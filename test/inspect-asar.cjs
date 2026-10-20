// Ad-hoc: dump app.asar layout to see where host plugin packages live.
// Usage: node test/inspect-asar.cjs <path-to-app.asar>   (or set DSH_ASAR)
const fs = require('fs')
const p = process.argv[2] ?? process.env.DSH_ASAR
if (!p) {
  console.error('usage: node test/inspect-asar.cjs <path-to-app.asar>  (or set DSH_ASAR)')
  process.exit(1)
}
const fd = fs.openSync(p, 'r')
const b = Buffer.alloc(16)
fs.readSync(fd, b, 0, 16, 0)
const headerSize = b.readUInt32LE(12)
const hb = Buffer.alloc(headerSize)
fs.readSync(fd, hb, 0, headerSize, 16)
const idx = JSON.parse(hb.toString('utf8'))
console.log('headerSize', headerSize, 'root keys', Object.keys(idx.files))
function dir(node) { return node && node.files ? Object.keys(node.files) : [] }
console.log('dsh/', dir(idx.files.dsh))
console.log('dsh/node_modules?', dir(idx.files.dsh.files['node_modules']).slice(0, 20))
const nm = idx.files.dsh.files['node_modules']
if (nm && nm.files) {
  const names = Object.keys(nm.files)
  console.log('node_modules entries', names.length)
  console.log(names.filter((n) => n.startsWith('@deepseek-ai')).slice(0, 10))
  const ds = nm.files['@deepseek-ai']
  if (ds && ds.files) {
    console.log('@deepseek-ai count', Object.keys(ds.files).length)
    console.log('has dsh-tools?', 'dsh-tools' in ds.files)
  }
}
fs.closeSync(fd)
