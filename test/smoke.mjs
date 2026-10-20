/**
 * smoke.mjs — host-half tests without a running DSH.
 *
 * Exercises static attribution (with a synthetic install inventory), per-session
 * enforcement (assemble filter + guard), persistence and the HTTP gateway
 * against a fake Cordis context.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ToolRegistry, UNKNOWN_GROUP } from '../lib/registry.js'
import { GateStore } from '../lib/store.js'
import { installAgentGate } from '../lib/policy.js'
import { installGateway } from '../lib/gateway.js'

/* ------------------------------------------------------------------ fakes */

function createHostCtx(toolNames) {
  const listeners = new Map()
  return {
    toolNames,
    logger: { info() {}, debug() {}, warn() {} },
    tools: {
      schemas() {
        return toolNames.map(name => ({ name, description: '', parameters: {} }))
      },
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => listeners.set(event, (listeners.get(event) ?? []).filter(h => h !== handler))
    },
    emit(event, payload) {
      for (const handler of listeners.get(event) ?? []) handler(payload)
    },
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    webServer: {
      register(spec) {
        this.spec = spec
        return () => {
          this.spec = undefined
        }
      },
    },
  }
}

function createAgentCtx(toolNames) {
  const assembleHandlers = []
  const guards = []
  return {
    assembleHandlers,
    guards,
    tools: {
      schemas() {
        return toolNames.map(name => ({ name, description: '', parameters: {} }))
      },
      guard(fn) {
        guards.push(fn)
        return () => {
          const idx = guards.indexOf(fn)
          if (idx >= 0) guards.splice(idx, 1)
        }
      },
    },
    on(event, handler) {
      if (event === 'system-prompt/assemble') assembleHandlers.push(handler)
      return () => {
        const idx = assembleHandlers.indexOf(handler)
        if (idx >= 0) assembleHandlers.splice(idx, 1)
      }
    },
    effect(fn) {
      return fn()
    },
  }
}

/** Synthetic install inventory: row id → candidate tool names. */
function inventory(rows) {
  const map = new Map()
  for (const [rowId, { specifier, packageName, tools, preset, configTools }] of Object.entries(rows)) {
    map.set(rowId, { rowId, specifier, packageName, tools: new Set(tools), preset, configTools })
  }
  return { rows: map, warnings: [], skipped: [] }
}

/* ------------------------------------------------------------------- tests */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tool-gate-'))
const storeFile = path.join(tmpDir, 'tool-gate.json')

const toolNames = ['working_directory', 'browser_open', 'browser_close', 'mystery_tool']
const ctx = createHostCtx(toolNames)

const registry = new ToolRegistry(ctx, {
  inventory: inventory({
    'tool-working-directory': {
      specifier: '@deepseek-ai/dsh-tool-working-directory',
      packageName: '@deepseek-ai/dsh-tool-working-directory',
      tools: ['working_directory'],
    },
    'tool-browser': {
      specifier: 'dsh-builtin-browser/tool-browser',
      packageName: 'dsh-builtin-browser',
      tools: ['browser_open', 'browser_close', 'not_registered_tool'],
    },
  }),
})

const groups = registry.groups()
const byName = new Map(groups.map(group => [group.name, group]))
assert.equal(groups.length, 3, 'two plugin groups plus the unattributed one')
assert.deepEqual(
  byName.get('tool-browser').tools.map(t => t.name),
  ['browser_close', 'browser_open'],
  'only tools that really exist are attributed, sorted by name',
)
assert.equal(byName.has('tool-working-directory'), true)
assert.deepEqual(
  byName.get(UNKNOWN_GROUP).tools.map(t => t.name),
  ['mystery_tool'],
  'tools no scanned row claims land in the unknown group',
)

// Agent-scope (preset) tools are merged on request.
const presetGroups = registry.groups([{ name: 'read' }])
const presetUnknown = presetGroups.find(group => group.name === UNKNOWN_GROUP)
assert.deepEqual(presetUnknown.tools.map(t => t.name).sort(), ['mystery_tool', 'read'], 'agent-scope tools are attributed too')

// Per-session enforcement.
const store = new GateStore(storeFile)
const gate = installAgentGate(ctx, { registry, store, logger: ctx.logger })

const agentSession = { deriveMessages: () => [{ role: 'user', content: 'hi' }] }
const agentCtx = createAgentCtx(toolNames)
ctx.emit('agent/created', { agent: { id: 'session-1', ctx: agentCtx, session: agentSession }, source: 'new' })
assert.equal(agentCtx.assembleHandlers.length, 1, 'agent gets one assemble listener')
assert.equal(agentCtx.guards.length, 1, 'agent gets one guard')

const assembly = {
  tools: [{ name: 'working_directory' }, { name: 'browser_open' }],
  sections: [],
  contexts: [],
  variables: {},
}

const assemble = () => agentCtx.assembleHandlers[0](assembly, {}, async () => assembly)

assert.deepEqual((await assemble()).tools.map(t => t.name), ['working_directory', 'browser_open'], 'nothing disabled → all tools')

store.setChoice('session-1', ['tool-browser'])
assert.deepEqual((await assemble()).tools.map(t => t.name), ['working_directory'], 'disabled plugin tools filtered out of assembly')
assert.match(agentCtx.guards[0]({ name: 'browser_open' }) ?? '', /masked|disabled/, 'guard denies disabled tool')
assert.equal(agentCtx.guards[0]({ name: 'working_directory' }), undefined, 'guard allows remaining tool')

// A second session starts from the saved defaults (no dialog ambush) …
const agent2Ctx = createAgentCtx(toolNames)
ctx.emit('agent/created', { agent: { id: 'session-2', ctx: agent2Ctx, session: agentSession }, source: 'new' })
assert.deepEqual(
  (await agent2Ctx.assembleHandlers[0](assembly, {}, async () => assembly)).tools.map(t => t.name),
  ['working_directory'],
  'a new session inherits the saved defaults',
)

// …but an explicit per-session choice only affects that session.
store.setChoice('session-2', [])
assert.deepEqual(
  (await agent2Ctx.assembleHandlers[0](assembly, {}, async () => assembly)).tools.map(t => t.name),
  ['working_directory', 'browser_open'],
  'session-2 opted back in',
)
assert.deepEqual((await assemble()).tools.map(t => t.name), ['working_directory'], 'session-1 is untouched by session-2')
assert.equal(agent2Ctx.guards[0]({ name: 'browser_open' }), undefined)

// Preset rows are listed before the first message, when agent-scope tools do
// not exist yet, and live tools replace the candidates once they register.
const presetRegistry = new ToolRegistry(ctx, {
  inventory: inventory({
    'tool-fs': {
      specifier: '@deepseek-ai/dsh-tool-fs',
      packageName: '@deepseek-ai/dsh-tool-fs',
      tools: ['read', 'write'],
      preset: true,
    },
  }),
})
const draftGroups = presetRegistry.groups()
const draftFs = draftGroups.find(g => g.name === 'tool-fs')
assert.deepEqual([draftFs.potential, draftFs.tools.map(t => t.name)], [true, ['read', 'write']], 'preset rows shown for a draft')
const liveGs = presetRegistry.groups([{ name: 'read' }]).find(g => g.name === 'tool-fs')
assert.deepEqual([liveGs.potential ?? false, liveGs.tools.map(t => t.name)], [false, ['read']], 'live tools take over')

// A row can rename the tool it mounts (`toolName: subagent_fork`); that config
// wins over sibling-row heuristics, and no tool is listed under two chips.
const renamedRegistry = new ToolRegistry(ctx, {
  inventory: inventory({
    'tool-subagent': {
      specifier: '@deepseek-ai/dsh-tool-subagent',
      packageName: '@deepseek-ai/dsh-tool-subagent',
      tools: ['subagent', 'subagent_fork'],
      preset: true,
      configTools: ['subagent'],
    },
    'tool-subagent-fork': {
      specifier: '@deepseek-ai/dsh-tool-subagent',
      packageName: '@deepseek-ai/dsh-tool-subagent',
      tools: ['subagent', 'subagent_fork'],
      preset: true,
      configTools: ['subagent_fork'],
    },
  }),
})
const renamed = new Map(renamedRegistry.groups().map(g => [g.name, g.tools.map(t => t.name)]))
assert.deepEqual(renamed.get('tool-subagent'), ['subagent'], 'the row config names its tool')
assert.deepEqual(renamed.get('tool-subagent-fork'), ['subagent_fork'], 'no tool appears under two chips')

// Persistence round-trip.
const reloaded = new GateStore(storeFile)
assert.deepEqual(reloaded.choice('session-1'), { configured: true, disabled: ['tool-browser'], started: true })
assert.deepEqual(reloaded.choice('session-2'), { configured: true, disabled: [], started: true })

// HTTP gateway.
const disposeGateway = installGateway(ctx, { registry, store, logger: ctx.logger, gate })
const route = ctx.webServer.spec
assert.equal(route.kind, 'prefix')
assert.equal(route.path, '/tool-gate/api')

function makeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(body) {
      this.body = body ?? ''
      this.headersSent = true
    },
  }
}

async function call(method, url, body) {
  const res = makeRes()
  await route.handler(makeReq(method, url, body), res)
  return { status: res.statusCode, json: JSON.parse(res.body) }
}

const stateRes = await call('POST', '/tool-gate/api/state', { sessionId: 'session-1' })
assert.equal(stateRes.status, 200)
assert.equal(stateRes.json.ok, true)
assert.deepEqual(stateRes.json.value.choice, { configured: true, disabled: ['tool-browser'], started: true })
assert.equal(stateRes.json.value.started, true, 'session-1 has an agent → started')
assert.ok(stateRes.json.value.groups.some(g => g.name === 'tool-browser'))

// Mid-conversation changes ask for confirmation; before the first message
// (no agent yet) the same call applies straight away.
const confirmSet = await call('POST', '/tool-gate/api/set', { sessionId: 'session-2', disabled: ['tool-browser', 'tool-working-directory'] })
assert.equal(confirmSet.status, 409)
assert.equal(confirmSet.json.error.code, 'needs-confirmation')
assert.deepEqual(confirmSet.json.error.detail.added, ['tool-browser', 'tool-working-directory'])

const confirmed = await call('POST', '/tool-gate/api/set', { sessionId: 'session-2', disabled: ['tool-browser', 'tool-working-directory'], confirm: true })
assert.equal(confirmed.status, 200)
assert.deepEqual(confirmed.json.value.choice, { configured: true, disabled: ['tool-browser', 'tool-working-directory'], started: true })

const draftSet = await call('POST', '/tool-gate/api/set', { sessionId: 'session-draft', disabled: [] })
assert.equal(draftSet.status, 200, 'a draft session never needs confirmation')
assert.equal(draftSet.json.value.started, false)

const badSet = await call('POST', '/tool-gate/api/set', { sessionId: 'session-2', disabled: ['nope'] })
assert.equal(badSet.status, 400)
assert.equal(badSet.json.error.code, 'unknown-group')

const missing = await call('GET', '/tool-gate/api/state?sessionId=', undefined)
assert.equal(missing.status, 400)

const forgetRes = await call('POST', '/tool-gate/api/forget', { sessionId: 'session-1' })
assert.equal(forgetRes.status, 200)
assert.deepEqual(forgetRes.json.value.choice, { configured: true, disabled: [], inherited: true, started: false }, 'forget falls back to the saved defaults')

disposeGateway()
assert.equal(ctx.webServer.spec, undefined, 'gateway route disposed')

gate.dispose()
fs.rmSync(tmpDir, { recursive: true, force: true })

console.log('smoke: all assertions passed')
