/**
 * dsh-tool-gate — host entry.
 *
 * Session-scoped, plugin-level tool gating for DeepSeek Harness.
 *
 * {@link ToolRegistry} builds a static inventory of the installed profile: every
 * bundle's loader rows, the module each row mounts, and the tool names that
 * module registers. The inventory is intersected with the live tool registry and
 * cached until `tools/change` fires again. When a session starts, the client
 * bundle shows a picker (one chip per plugin, its tools on hover). The saved
 * choice is keyed by session id and enforced for the whole session:
 *
 *   - disabled plugins' tools are filtered out of `system-prompt/assemble`;
 *   - executing one of those tools is denied by an agent-scoped `tools.guard()`.
 *
 * The gate is registered on `agent.ctx`, so it never leaks into other
 * conversations and unwinds when the agent is disposed.
 */

import path from 'node:path'
import { GateStore, defaultGateFilePath } from './store.js'
import { ToolRegistry } from './registry.js'
import { installAgentGate } from './policy.js'
import { installGateway } from './gateway.js'
import { locateAsar } from './scan/asar.js'
import { locateProfileDir } from './scan/index.js'

export const name = 'tool-gate'

export const inject = ['tools']

const OWN_PACKAGE = 'dsh-tool-gate'

export function apply(ctx, config = {}) {
  const logger = ctx.logger
  const file = typeof config.file === 'string' && config.file !== '' ? path.resolve(config.file) : defaultGateFilePath()
  const askOnSessionStart = config.askOnSessionStart !== false

  const store = new GateStore(file)
  store.onWriteError = error => logger?.warn?.(`tool-gate: cannot persist ${file}: ${error?.message ?? error}`)

  const registry = new ToolRegistry(ctx, {
    logger,
    profileDir: locateProfileDir({ ownPackageName: OWN_PACKAGE, override: config.profileDir }),
    asarPath: typeof config.asarPath === 'string' && config.asarPath !== '' ? config.asarPath : locateAsar(),
    ownPackageName: OWN_PACKAGE,
  })

  const gate = installAgentGate(ctx, { registry, store, logger })

  // The HTTP surface needs `webServer`, which starts later than `tools` on most
  // hosts. Waiting for it in the top-level `inject` would hold this plugin back,
  // so the gateway installs from a nested injection instead.
  const disposeGateway = ctx.inject(['webServer'], webCtx =>
    installGateway(webCtx, { registry, store, logger, askOnSessionStart, gate }))

  ctx.effect(() => () => {
    gate?.dispose?.()
    disposeGateway?.()
    registry.dispose()
  }, 'tool-gate: dispose')

  logger?.info?.(`tool-gate: enabled (state file: ${file})`)
}

/** Read-only view used by tests. */
export { GateStore, ToolRegistry }
