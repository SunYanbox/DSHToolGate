/**
 * Minimal ASAR reader.
 *
 * Host plugin packages ship inside the Electron `app.asar` archive, so the
 * scanner must be able to read them without Electron's fs patch: a CLI run has
 * plain `node`, where `.../app.asar/dsh/package.json` is just an invalid path.
 *
 * Format (verified against DeepSeek Harness 44.7.0's `app.asar`):
 *
 *   [u32=4][u32 pickleSize][u32 stringSize][u32 payloadSize][payload JSON][file data]
 *
 * `8 + pickleSize` is the data offset; entries in the JSON index carry an
 * absolute `offset` into that data area.
 */

import fs from 'node:fs'

const HEADER_PROBE = 16

/**
 * Electron patches `fs` to virtualize anything inside `app.asar`, and that
 * patch also treats the archive file itself as a directory. Reading the raw
 * bytes therefore has to disable the patch (`process.noAsar`) for the call.
 */
function rawIo(fn) {
  if (typeof process === 'undefined') return fn()
  const previous = process.noAsar
  process.noAsar = true
  try {
    return fn()
  }
  finally {
    if (previous === undefined) delete process.noAsar
    else process.noAsar = previous
  }
}

/** One opened archive; `close()` releases the descriptor. */
export class AsarArchive {
  constructor(file, fd, index, dataStart) {
    this.file = file
    this.fd = fd
    this.index = index
    this.dataStart = dataStart
  }

  /**
   * Open an archive.
   *
   * @param file - absolute path to `app.asar`.
   * @returns the archive, or `undefined` when the file does not exist or is not
   * a readable asar.
   */
  static open(file) {
    AsarArchive.lastError = undefined
    let fd
    try {
      fd = rawIo(() => fs.openSync(file, 'r'))
    }
    catch (error) {
      AsarArchive.lastError = `open ${file}: ${error?.message ?? error}`
      return undefined
    }
    try {
      const head = Buffer.alloc(HEADER_PROBE)
      rawIo(() => fs.readSync(fd, head, 0, HEADER_PROBE, 0))
      if (head.readUInt32LE(0) !== 4) throw new Error(`unexpected header magic ${head.readUInt32LE(0)}`)
      const pickleSize = head.readUInt32LE(4)
      const payloadSize = head.readUInt32LE(12)
      const body = Buffer.alloc(payloadSize)
      rawIo(() => fs.readSync(fd, body, 0, payloadSize, HEADER_PROBE))
      const index = JSON.parse(body.toString('utf8'))
      return new AsarArchive(file, fd, index, 8 + pickleSize)
    }
    catch (error) {
      AsarArchive.lastError = `read ${file}: ${error?.message ?? error}`
      try {
        rawIo(() => fs.closeSync(fd))
      }
      catch {
        /* already gone */
      }
      return undefined
    }
  }

  close() {
    try {
      fs.closeSync(this.fd)
    }
    catch {
      /* already closed */
    }
  }

  /** Resolve a `/`-separated archive path to its index node. */
  _node(parts) {
    let node = this.index
    for (const part of parts) {
      if (part === '' || part === '.') continue
      node = node?.files?.[part]
      if (!node) return undefined
    }
    return node
  }

  /** Direct children names of an archive directory (or `[]`). */
  list(dir) {
    const node = this._node(dir.split('/').filter(Boolean))
    return node?.files ? Object.keys(node.files) : []
  }

  /** True when a directory exists in the archive. */
  hasDir(dir) {
    const node = this._node(dir.split('/').filter(Boolean))
    return Boolean(node?.files)
  }

  /**
   * Read one archive file.
   *
   * @returns its bytes, or `undefined` when absent (or stored unpacked).
   */
  readFile(relPath) {
    const parts = relPath.split('/').filter(Boolean)
    const node = this._node(parts)
    if (!node || node.files) return undefined
    if (node.unpacked) return undefined
    const size = Number(node.size)
    if (!Number.isFinite(size)) return undefined
    const buffer = Buffer.alloc(size)
    rawIo(() => fs.readSync(this.fd, buffer, 0, size, this.dataStart + Number(node.offset)))
    return buffer
  }

  /** Read one archive file as UTF-8 text (`undefined` when absent). */
  readText(relPath) {
    return this.readFile(relPath)?.toString('utf8')
  }
}

/**
 * Locate the host's `app.asar` from runtime clues.
 *
 * @param hints - extra candidate paths (e.g. a config override).
 * @returns the first existing archive path, or `undefined`.
 */
export function locateAsar(hints = []) {
  const candidates = [...hints]
  if (typeof process !== 'undefined') {
    if (process.resourcesPath) candidates.push(`${process.resourcesPath}/app.asar`)
    for (const arg of process.argv ?? []) {
      if (typeof arg === 'string' && arg.includes('app.asar')) {
        const cut = arg.indexOf('app.asar')
        candidates.push(arg.slice(0, cut + 'app.asar'.length))
      }
    }
    if (process.execPath) {
      candidates.push(`${process.execPath}/../../resources/app.asar`)
      candidates.push(`${process.execPath}/../resources/app.asar`)
    }
  }
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      // Under Electron the archive itself is virtualized and stats as a
      // directory, so existence is the only usable check here.
      if (fs.existsSync(candidate)) return candidate
    }
    catch {
      /* unreadable candidate */
    }
  }
  return undefined
}
