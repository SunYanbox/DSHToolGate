// Ad-hoc: run the static inventory against the live desktop profile.
import { locateProfileDir, scanInstalledPlugins } from '../lib/scan/index.js'
import { locateAsar } from '../lib/scan/asar.js'

// Override with DSH_PROFILE_DIR / DSH_ASAR; otherwise locate both at runtime.
const profileDir = process.env.DSH_PROFILE_DIR ?? locateProfileDir({ ownPackageName: '@suntion/dsh-tool-gate' })
const asarPath = process.env.DSH_ASAR ?? locateAsar()
if (!profileDir) {
  console.error('@suntion/dsh-tool-gate: could not locate a DSH profile; set DSH_PROFILE_DIR')
  process.exit(1)
}
if (!asarPath) {
  console.error('@suntion/dsh-tool-gate: could not locate app.asar; set DSH_ASAR')
  process.exit(1)
}

const started = Date.now()
const { rows, warnings } = scanInstalledPlugins({ profileDir, asarPath })
console.log('rows:', rows.size, 'ms:', Date.now() - started)
let total = 0
for (const [rowId, row] of rows) {
  if (row.tools.size === 0) continue
  total += row.tools.size
  console.log(`${rowId}  (${row.specifier})  ${row.tools.size}  ${[...row.tools].slice(0, 6).join(', ')}`)
}
console.log('candidate tools total:', total)
console.log('warnings:', warnings.length)
for (const warning of warnings.slice(0, 12)) console.log('  -', warning)
process.exit(0)
