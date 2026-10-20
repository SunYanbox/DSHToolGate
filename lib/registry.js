/**
 * registry.js —tool-to-plugin attribution.
 *
 * `ctx.tools.schemas()` exposes only `{ name, description, parameters }`: the
 * tool registry keeps no owner field, so attribution cannot be read off the
 * runtime. It also cannot be reconstructed from lifecycle events reliably: a
 * plugin installed as a bundle is applied after the host's own tool providers,
 * so an `internal/plugin` listener installed by that plugin only ever sees
 * plugins that start later —which is why an event-driven first version dumped
 * every host tool into a single "built-in" bucket.
 *
 * The install tree, in contrast, records ownership statically: every bundle's
 * `cordis.patch.yml` names the module each loader row mounts, and that module's
 * sources contain the names it registers. {@link scanInstalledPlugins} walks
 * the profile's bundles plus the host archive, and the scan is intersected with
 * the live schema list here —so a name is only attributed when the tool
 * actually exists right now, and order never matters.
 *
 * Anything still unattributed (preset/MCP tools, dynamically named ones) lands
 * in UNKNOWN_GROUP, which stays visible and toggleable rather than silently
 * hiding tools.
 */

import { scanInstalledPlugins } from './scan/index.js'

export const BASELINE_GROUP = '（内置/先加载）'
export const UNKNOWN_GROUP = '（未识别）'

/**
 * Rows whose tools the runtime mounts on the agent scope (official tool
 * plugins, preset rows). They are absent from the global schema list until a
 * conversation actually starts, so the dialog previews them up front.
 */
function isPresetToolRow(row) {
  if (row.preset === true) return true
  return /(^|\/)dsh-tool-/.test(row.packageName)
}

/**
 * Official DeepSeek packages (`@deepseek-ai/dsh-tool-*`, `@deepseek-ai/dsh-base`
 * rows like tool-browser) ship many tool plugins; the dialog keeps them folded
 * by default so third-party plugins stay visible at a glance.
 */
export function isOfficialPackage(packageName) {
  if (typeof packageName !== 'string' || packageName.length === 0) return false
  if (packageName.startsWith('@deepseek-ai/')) return true
  return /(^|\/)dsh-tool-/.test(packageName)
}

/** Union of two schema lists, first definition winning. */
function mergeSchemas(base, extra) {
  if (!Array.isArray(extra) || extra.length === 0) return base
  const byName = new Map(base.map(schema => [schema.name, schema]))
  for (const schema of extra) {
    if (schema && typeof schema.name === 'string' && !byName.has(schema.name)) byName.set(schema.name, schema)
  }
  return [...byName.values()]
}

export class ToolRegistry {
  /**
   * @param ctx - plugin context (uses `ctx.tools.schemas()` and `tools/change`).
   * @param options - `{ profileDir, asarPath, logger, ownPackageName }`.
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx
    this.options = options
    this.logger = options.logger
    this.inventory = options.inventory
    this.cache = undefined
    ctx.on('tools/change', () => {
      this.cache = undefined
    })
  }

  readSchemas() {
    try {
      const schemas = this.ctx.tools.schemas()
      return Array.isArray(schemas) ? schemas : []
    }
    catch {
      return []
    }
  }

  inventoryOrScan() {
    if (this.inventory === undefined) {
      try {
        this.inventory = scanInstalledPlugins(this.options)
        for (const warning of this.inventory.warnings) this.logger?.warn?.(`tool-gate: ${warning}`)
      }
      catch (error) {
        this.logger?.warn?.(`tool-gate: plugin scan failed: ${error?.message ?? error}`)
        this.inventory = { rows: new Map(), warnings: [] }
      }
    }
    return this.inventory
  }

  /**
   * Build the attribution for one live tool set.
   *
   * @param extraSchemas - tools registered on an agent scope (preset tools),
   * merged with the global schemas when a session is already materialised.
   */
  build(extraSchemas = []) {
    const schemas = mergeSchemas(this.readSchemas(), extraSchemas)
    const byName = new Map(schemas.map(schema => [schema.name, schema]))
    const groups = new Map()
    const assigned = new Set()

    // Loader rows are *assigned* last-first: a bundle's specific rows
    // (`tool-browser`) follow its root row (`dsh-builtin-browser`), and scanning
    // the root row also reaches the subpath's sources. Letting the specific row
    // claim first keeps the chip labelled with the row that owns the tools. The
    // resulting groups are still emitted in patch order.
    const rows = [...this.inventoryOrScan().rows.values()]
    const owned = new Map()
    const claim = (row, schema) => {
      if (assigned.has(schema.name)) return
      const tools = owned.get(row.rowId) ?? []
      tools.push({ name: schema.name, description: schema.description })
      owned.set(row.rowId, tools)
      assigned.add(schema.name)
    }
    // A row may rename its tool through its own config (`toolName:
    // subagent_fork`); that name is authoritative over sibling heuristics.
    for (const row of rows) {
      for (const candidate of row.configTools ?? []) {
        const schema = byName.get(candidate)
        if (schema) claim(row, schema)
      }
    }
    for (const row of [...rows].reverse()) {
      for (const candidate of row.tools) {
        if (assigned.has(candidate)) continue
        const schema = byName.get(candidate)
        if (schema) claim(row, schema)
      }
    }
    for (const row of rows) {
      const tools = owned.get(row.rowId)
      if (!tools) continue
      tools.sort((a, b) => a.name.localeCompare(b.name))
      groups.set(row.rowId, { name: row.rowId, label: row.specifier, packageName: row.packageName, official: isOfficialPackage(row.packageName), tools })
    }

    // Preset / official tool rows only register on the session's agent scope,
    // which may not be materialised yet (fresh draft, or a conversation whose
    // agent only mounts after the next message). List that roster anyway —as
    // `potential` chips —so official built-in plugins stay toggleable at every
    // point of a conversation.
    {
      const own = this.options.ownPackageName ?? 'dsh-tool-gate'
      const claimed = new Set(assigned)
      const potential = new Map()
      const order = [...rows].reverse()
      const take = (row, name) => {
        if (claimed.has(name)) return
        const tools = potential.get(row.rowId) ?? []
        tools.push(name)
        potential.set(row.rowId, tools)
        claimed.add(name)
      }
      for (const row of order) {
        if (groups.has(row.rowId) || row.packageName === own) continue
        if (!isPresetToolRow(row)) continue
        for (const name of row.configTools ?? []) take(row, name)
      }
      for (const row of order) {
        if (groups.has(row.rowId) || row.packageName === own) continue
        if (!isPresetToolRow(row)) continue
        for (const name of row.tools) take(row, name)
      }
      for (const row of rows) {
        const names = potential.get(row.rowId)
        if (!names || names.length === 0) continue
        groups.set(row.rowId, {
          name: row.rowId,
          label: row.specifier,
          packageName: row.packageName,
          official: isOfficialPackage(row.packageName),
          tools: names.map(name => ({ name })),
          potential: true,
        })
      }
    }

    const leftovers = []
    for (const schema of schemas) {
      if (assigned.has(schema.name)) continue
      leftovers.push({ name: schema.name, description: schema.description })
    }
    // Unattributed tools are grouped by the ROOT FOLDER of the plugin package
    // that references them, so a chip still names the plugin it came from
    // instead of dumping everything into one bucket.
    const inventory = this.inventoryOrScan()
    const unknown = []
    for (const tool of leftovers) {
      const owner = inventory.findOwner?.(tool.name)
      if (!owner) {
        unknown.push(tool)
        continue
      }
      let group = groups.get(owner)
      if (!group) {
        group = { name: owner, label: owner, packageName: owner, official: isOfficialPackage(owner), tools: [] }
        groups.set(owner, group)
      }
      group.tools.push(tool)
    }
    for (const group of groups.values()) group.tools.sort((a, b) => a.name.localeCompare(b.name))
    if (unknown.length > 0) groups.set(UNKNOWN_GROUP, { name: UNKNOWN_GROUP, label: UNKNOWN_GROUP, packageName: undefined, tools: unknown })

    return groups
  }

  current(extraSchemas = []) {
    if (Array.isArray(extraSchemas) && extraSchemas.length > 0) return this.build(extraSchemas)
    if (this.cache === undefined) this.cache = this.build()
    return this.cache
  }

  /** Plugin groups that currently contribute at least one tool. */
  groups(extraSchemas = []) {
    return [...this.current(extraSchemas).values()].map(group => ({
      name: group.name,
      label: group.label,
      packageName: group.packageName,
      official: group.official === true,
      potential: group.potential === true,
      tools: group.tools,
    }))
  }

  /** Every tool name owned by one plugin group. */
  toolsOf(pluginName, extraSchemas = []) {
    const group = this.current(extraSchemas).get(pluginName)
    return group ? group.tools.map(tool => tool.name) : []
  }

  /** Resolve a list of disabled plugin groups into the concrete tool-name set. */
  disabledToolNames(pluginNames, extraSchemas = []) {
    const set = new Set()
    if (!Array.isArray(pluginNames)) return set
    const current = this.current(extraSchemas)
    for (const name of pluginNames) {
      const group = current.get(name)
      if (group) for (const tool of group.tools) set.add(tool.name)
    }
    return set
  }

  /** Diagnostics for the gateway/state view. */
  info() {
    const inventory = this.inventoryOrScan()
    return {
      profileDir: this.options.profileDir,
      asarPath: this.options.asarPath,
      rows: inventory.rows ? inventory.rows.size : 0,
      warnings: Array.isArray(inventory.warnings) ? inventory.warnings : [],
      debug: {
        execPath: process.execPath,
        argv: process.argv,
        resourcesPath: process.resourcesPath,
        dshHome: process.env.DSH_HOME,
        profileEnv: process.env.DSH_PROFILE ?? process.env.DSH_PROFILE_NAME,
      },
    }
  }

  dispose() {
    this.inventory?.asar?.close()
    this.inventory = undefined
  }
}

