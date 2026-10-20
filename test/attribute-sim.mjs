// Ad-hoc: exercise ToolRegistry attribution with a simulated live tool set.
import { ToolRegistry } from '../lib/registry.js'
import { locateProfileDir, scanInstalledPlugins } from '../lib/scan/index.js'
import { locateAsar } from '../lib/scan/asar.js'

// Override with DSH_PROFILE_DIR / DSH_ASAR; otherwise locate both at runtime.
const profileDir = process.env.DSH_PROFILE_DIR ?? locateProfileDir({ ownPackageName: 'dsh-tool-gate' })
const asarPath = process.env.DSH_ASAR ?? locateAsar()
if (!profileDir) {
  console.error('dsh-tool-gate: could not locate a DSH profile; set DSH_PROFILE_DIR')
  process.exit(1)
}
if (!asarPath) {
  console.error('dsh-tool-gate: could not locate app.asar; set DSH_ASAR')
  process.exit(1)
}

const scan = scanInstalledPlugins({ profileDir, asarPath })
const all = new Set()
for (const row of scan.rows.values()) for (const name of row.tools) all.add(name)

const fakeCtx = {
  tools: { schemas: () => [...all].map(name => ({ name, description: `simulated ${name}`, parameters: {} })) },
  on: () => () => {},
}

const registry = new ToolRegistry(fakeCtx, { profileDir, asarPath })
const started = Date.now()
const groups = registry.groups()
console.log('groups:', groups.length, 'ms:', Date.now() - started)
for (const group of groups) {
  console.log(`${group.name}  (${group.label})  ${group.tools.length} tools${group.tools.length <= 4 ? '  ' + group.tools.map(t => t.name).join(',') : ''}`)
}
const assigned = new Set(groups.flatMap(g => g.tools.map(t => t.name)))
console.log('assigned:', assigned.size, 'candidates:', all.size)
process.exit(0)
