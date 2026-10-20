// Dump one file out of an asar archive (read-only).
// Usage: node test/dump-asar-file.cjs <app.asar> <inner/path.js> [byteLimit]
const fs = require('node:fs')

const [, , archive, inner, limitArg] = process.argv
if (!archive || !inner) {
  console.error('usage: node test/dump-asar-file.cjs <app.asar> <inner/path> [byteLimit]')
  process.exit(1)
}
const limit = Number(limitArg ?? 400000)

const fd = fs.openSync(archive, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(12)
const headerBuf = Buffer.alloc(headerSize)
fs.readSync(fd, headerBuf, 0, headerSize, 16)
const index = JSON.parse(headerBuf.toString('utf8'))
const dataOffset = 16 + headerSize

let node = index
for (const segment of inner.split('/').filter(Boolean)) {
  node = node.files?.[segment]
  if (!node) {
    console.error(`not found: ${inner}`)
    process.exit(2)
  }
}
if (!node.offset) {
  console.error(`not a file: ${inner}`)
  process.exit(2)
}
const size = Math.min(node.size, limit)
const buf = Buffer.alloc(size)
fs.readSync(fd, buf, 0, size, dataOffset + Number(node.offset))
fs.closeSync(fd)
process.stdout.write(buf.toString('utf8'))
