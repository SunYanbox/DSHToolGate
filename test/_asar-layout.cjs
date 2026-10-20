// Determine the asar data offset layout by extracting a known file.
// Usage: node test/_asar-layout.cjs <path-to-app.asar>   (or set DSH_ASAR)
const fs = require('fs')
const path = require('path')
const p = process.argv[2] ?? process.env.DSH_ASAR
if (!p) {
  console.error('usage: node test/_asar-layout.cjs <path-to-app.asar>  (or set DSH_ASAR)')
  process.exit(1)
}
const fd = fs.openSync(p, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const a = head.readUInt32LE(0)
const b = head.readUInt32LE(4)
const c = head.readUInt32LE(8)
const d = head.readUInt32LE(12)
console.log('u32@0', a, 'u32@4', b, 'u32@8', c, 'u32@12', d)
const size = d
const hb = Buffer.alloc(size)
fs.readSync(fd, hb, 0, size, 16)
let idx
try {
  idx = JSON.parse(hb.toString('utf8'))
  console.log('json parsed at 16 with size', d, 'ok')
} catch (e) {
  console.log('parse at 16 failed', e.message)
  const hb2 = Buffer.alloc(b)
  fs.readSync(fd, hb2, 0, b, 8)
  idx = JSON.parse(hb2.toString('utf8'))
  console.log('json parsed at 8 with size', b, 'ok')
  fs.writeFileSync(path.join(__dirname, '_layout.txt'), String(8 + b))
}
const dataStart = d ? 16 + size : 8 + b
const entry = idx.files.dsh.files['package.json']
console.log('entry', JSON.stringify(entry).slice(0, 200))
const off = Number(entry.offset)
const len = entry.size
const buf = Buffer.alloc(len)
fs.readSync(fd, buf, 0, len, dataStart + off)
console.log('dataStart', dataStart, 'first 120:', buf.toString('utf8', 0, 120))
fs.closeSync(fd)
