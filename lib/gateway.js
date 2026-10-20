/**
 * gateway.js — small loopback JSON API used by the client bundle.
 *
 * Mounted under the host web server as a prefix route:
 *
 *   GET  /tool-gate/api/state?sessionId=<id>   → groups + this session's choice
 *   POST /tool-gate/api/state {sessionId}      → same, for clients avoiding query strings
 *   POST /tool-gate/api/set   {sessionId, disabled: [...], asDefault?: boolean}
 *   POST /tool-gate/api/forget{sessionId}
 *
 * `asDefault` (default true) also stores the choice as the profile-wide
 * default, so conversations that were never configured simply inherit it
 * instead of popping the dialog again.
 *
 * Every response uses the `{ ok: true, value }` / `{ ok: false, error }`
 * envelope.  The route only touches loopback-local state, so the host's
 * web-server auth is the only gate needed.
 */

const STATE_PATH = '/tool-gate/api/state'
const SET_PATH = '/tool-gate/api/set'
const FORGET_PATH = '/tool-gate/api/forget'

export function installGateway(ctx, { registry, store, logger, askOnSessionStart = true, gate }) {
  return ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/tool-gate/api',
        handler: (req, res) => handleRequest(req, res, { registry, store, logger, askOnSessionStart, gate }),
      }),
    'tool-gate: http gateway',
  )
}

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function ok(res, value) {
  send(res, 200, { ok: true, value })
}

function fail(res, status, code, message) {
  send(res, status, { ok: false, error: { code, message } })
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return null
  }
}

function diffChoices(before, after) {
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  return {
    added: [...afterSet].filter(name => !beforeSet.has(name)),
    removed: [...beforeSet].filter(name => !afterSet.has(name)),
  }
}

function stateOf(sessionId, { registry, store, askOnSessionStart, gate }) {
  const agentSchemas = typeof gate?.schemasFor === 'function' ? gate.schemasFor(sessionId) : []
  return {
    sessionId,
    groups: registry.groups(agentSchemas),
    choice: store.choice(sessionId),
    started: store.started(sessionId) || Boolean(gate?.hasStarted?.(sessionId)),
    askOnSessionStart,
    inventory: typeof registry.info === 'function' ? registry.info() : undefined,
  }
}

async function handleRequest(req, res, deps) {
  const { registry, store, logger } = deps
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    let pathname = url.pathname
    const prefix = '/tool-gate/api'
    if (pathname.startsWith(prefix)) pathname = pathname.slice(prefix.length) || '/'

    if (req.method === 'GET' && (pathname === '/state' || pathname === '/')) {
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) return fail(res, 400, 'missing-session', 'sessionId query parameter is required')
      return ok(res, stateOf(sessionId, deps))
    }

    if (req.method === 'POST' && pathname === '/state') {
      const body = await readBody(req)
      if (body === null) return fail(res, 400, 'bad-json', 'request body is not valid JSON')
      if (typeof body.sessionId !== 'string' || body.sessionId === '') {
        return fail(res, 400, 'missing-session', 'sessionId is required')
      }
      return ok(res, stateOf(body.sessionId, deps))
    }

    if (req.method === 'POST' && pathname === '/set') {
      const body = await readBody(req)
      if (body === null) return fail(res, 400, 'bad-json', 'request body is not valid JSON')
      if (typeof body.sessionId !== 'string' || body.sessionId === '') {
        return fail(res, 400, 'missing-session', 'sessionId is required')
      }
      if (!Array.isArray(body.disabled)) {
        return fail(res, 400, 'bad-disabled', 'disabled must be an array of plugin group names')
      }
      const agentSchemas = typeof deps.gate?.schemasFor === 'function' ? deps.gate.schemasFor(body.sessionId) : []
      const known = new Set(registry.groups(agentSchemas).map(group => group.name))
      const unknown = body.disabled.filter(name => !known.has(name))
      if (unknown.length > 0) {
        return fail(res, 400, 'unknown-group', `unknown plugin group(s): ${unknown.join(', ')}`)
      }
      const started = store.started(body.sessionId) || Boolean(deps.gate?.hasStarted?.(body.sessionId))
      const before = store.choice(body.sessionId).disabled
      const diff = diffChoices(before, body.disabled)
      if (started && body.confirm !== true && (diff.added.length > 0 || diff.removed.length > 0)) {
        // Mid-conversation changes alter which tools the running agent can see;
        // ask once rather than silently swapping capabilities under the model.
        send(res, 409, {
          ok: false,
          error: {
            code: 'needs-confirmation',
            message: 'this conversation already started; changing its tools needs confirmation',
            detail: {
              sessionId: body.sessionId,
              added: diff.added,
              removed: diff.removed,
              disabled: body.disabled,
            },
          },
        })
        return
      }
      store.setChoice(body.sessionId, body.disabled, { asDefault: body.asDefault !== false })
      logger?.debug?.(`tool-gate: session ${body.sessionId} disabled [${body.disabled.join(', ')}]`)
      return ok(res, stateOf(body.sessionId, deps))
    }

    if (req.method === 'POST' && pathname === '/forget') {
      const body = await readBody(req)
      if (body === null) return fail(res, 400, 'bad-json', 'request body is not valid JSON')
      if (typeof body.sessionId !== 'string' || body.sessionId === '') {
        return fail(res, 400, 'missing-session', 'sessionId is required')
      }
      store.forget(body.sessionId)
      return ok(res, stateOf(body.sessionId, deps))
    }

    return fail(res, 404, 'not-found', `no route for ${req.method} ${url.pathname}`)
  } catch (error) {
    logger?.warn?.(error)
    if (!res.headersSent) fail(res, 500, 'internal', error instanceof Error ? error.message : String(error))
    else res.end()
  }
}

export const ROUTES = { STATE_PATH, SET_PATH, FORGET_PATH }
