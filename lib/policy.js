/**
 * policy.js — per-session enforcement.
 *
 * On every `agent/created` (new session, resume, or fork) two agent-scoped
 * policies are installed on `agent.ctx`:
 *
 *   1. a `system-prompt/assemble` waterfall listener that removes the tools of
 *      every disabled plugin from the assembled tool list, so they are never
 *      injected into this session's context;
 *   2. a `tools.guard()` that rejects an execution attempt even when a stale
 *      reference to the tool survives (e.g. from an earlier turn).
 *
 * Both policies read the store on every call, so a choice saved mid-session
 * takes effect on the next assembly / call.  Agent-scoped registration keeps
 * other sessions untouched and unwinds automatically when the agent is
 * disposed.
 */

const DISABLED_REASON = code => `tool-gate: tool is masked because its plugin was disabled for this session (${code})`

export function installAgentGate(ctx, { registry, store, logger }) {
  /** Live agents, so the gateway can read the tools an agent actually sees. */
  const agents = new Map()

  const disposeCreated = ctx.on('agent/created', ({ agent }) => {
    const sessionId = agent.id
    agents.set(sessionId, agent)
    /**
     * `agent/created` fires as soon as a conversation is opened — including an
     * empty draft — so the agent alone does not mean the conversation started.
     * Only a session that already produced messages gets the confirmation
     * prompt when its tool choice changes.
     */
    const markStarted = () => {
      if (hasStarted()) store.markStarted(sessionId)
    }
    const hasStarted = () => {
      try {
        const messages = agent.session?.deriveMessages?.()
        if (Array.isArray(messages) && messages.length > 0) return true
      }
      catch {
        /* session surface not ready yet */
      }
      return store.started(sessionId)
    }
    markStarted()
    /** Preset tools live on the agent scope, so read that view for attribution. */
    const agentSchemas = () => {
      try {
        return agent.ctx.tools.schemas()
      }
      catch {
        return []
      }
    }
    const disabledToolNames = () => registry.disabledToolNames(store.choice(sessionId).disabled, agentSchemas())

    agent.ctx.effect(() => {
      const offAssemble = agent.ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
        // Assembling a prompt means this conversation now has a real turn;
        // from here on, changing its tool set deserves a confirmation.
        markStarted()
        const result = await next()
        const disabled = disabledToolNames()
        if (disabled.size === 0) return result
        const tools = Array.isArray(result.tools) ? result.tools : []
        const kept = tools.filter(tool => !disabled.has(tool.name))
        if (kept.length === tools.length) return result
        return { ...result, tools: kept }
      })

      const offGuard = agent.ctx.tools.guard(execution =>
        disabledToolNames().has(execution.name) ? DISABLED_REASON(execution.name) : undefined,
      )

      return () => {
        offAssemble()
        offGuard()
        agents.delete(sessionId)
      }
    }, 'tool-gate: session gate')

    logger?.debug?.(`tool-gate: gate policy installed for session ${sessionId}`)
  })

  return {
    dispose: disposeCreated,
    /** Whether an agent currently exists for the session (conversation opened). */
    hasAgent(sessionId) {
      return agents.has(sessionId)
    },
    /** Whether the conversation already produced at least one message. */
    hasStarted(sessionId) {
      const agent = agents.get(sessionId)
      if (!agent) return store.started(sessionId)
      try {
        const messages = agent.session?.deriveMessages?.()
        if (Array.isArray(messages) && messages.length > 0) return true
      }
      catch {
        /* session surface not ready yet */
      }
      return store.started(sessionId)
    },
    /** Tools registered on the agent's own scope (preset tools) plus global ones. */
    schemasFor(sessionId) {
      const agent = agents.get(sessionId)
      if (!agent) return []
      try {
        return agent.ctx.tools.schemas()
      }
      catch {
        return []
      }
    },
  }
}

/** Remove every installed policy (used on plugin disposal; agent scopes unwind themselves). */
export function disposeAgentGate(gate) {
  if (typeof gate === 'function') gate()
  else gate?.dispose?.()
}
