/**
 * Static plugin inventory.
 *
 * Why a source scan instead of runtime attribution: Cordis never records which
 * plugin a registered tool came from (`ToolDefinition` has no owner field, and
 * `internal/plugin`/`tools/change` only expose a live "currently applying"
 * stack that a plugin loaded after the tools — as any installed bundle is —
 * simply missed). The install tree does record it: each bundle's
 * `cordis.patch.yml` names the module every row mounts, and that module's
 * source contains the tool names it registers. Scanning is order-independent,
 * which is exactly what installation order cannot give us.
 *
 * Precision is guaranteed by intersecting scan output with the runtime
 * `ctx.tools.schemas()` set: a name literal is only kept when the tool really
 * exists right now.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AsarArchive, locateAsar } from './asar.js'
import { parsePatchRows, splitSpecifier } from './patches.js'

const MAX_FILES_PER_ENTRY = 80
const MAX_FILE_BYTES = 2 * 1024 * 1024
const SKIP_FILE = /(?:^|\/)(?:client[\w.-]*\.js|[\w.-]+\.min\.js|[\w.-]+\.d\.ts|[\w.-]+\.map)$/
const SKIP_DIR = new Set(['node_modules', 'client', 'docs', 'tests', 'test', '__tests__', 'scripts', 'coverage'])
/** Packages searched for a literal tool name when a row cannot be resolved. */
const MAX_OWNER_FILES = 400
const MAX_OWNER_FILE_BYTES = 8 * 1024 * 1024

/** Tool registration call: `ctx.tools.register({ ... })` (any receiver). */
const TOOL_REGISTER = /tools\s*\.\s*register\s*\(\s*(?:[A-Za-z_$][\w$.]*\s*\(\s*)*\{/g
/** Tool-name literal inside source: `name: 'tool_name'`. */
const NAME_LITERAL = /\bname\s*:\s*(['"])([a-z][a-z0-9_]{2,})\1/g
/** `const EXIT_PLAN_MODE = 'exit_plan_mode'` — names referenced by identifier. */
const CONST_STRING = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*(['"`])([a-z][a-z0-9_]{1,60})\2/g
/** `name: toolName` inside a `tools.register({ … })` object literal. */
const REGISTER_NAME_IDENT = /\bname\s*:\s*([A-Za-z_$][\w$]*)/g
/** `z.string().default('subagent')` — configurable tool names. */
const DEFAULT_STRING = /\.default\(\s*(['"])([a-z][a-z0-9_]{1,60})\1\s*\)/g
/** Widest slice after `register({` that still belongs to the options object. */
const REGISTER_OPTIONS_WINDOW = 800

/**
 * One storage backend (a profile directory or the asar archive).
 *
 * @typedef {object} Backend
 * @property {string} id - human label, for diagnostics.
 * @property {(rel: string) => string | undefined} readText
 * @property {(rel: string) => string[]} list
 * @property {(rel: string) => boolean} isDir
 */

/** @returns {Backend | undefined} */
function directoryBackend(root) {
  let stat
  try {
    stat = fs.statSync(root)
  }
  catch {
    return undefined
  }
  if (!stat.isDirectory()) return undefined
  return {
    id: root,
    readText(rel) {
      const abs = path.join(root, rel)
      try {
        if (fs.statSync(abs).size > MAX_FILE_BYTES) return undefined
        return fs.readFileSync(abs, 'utf8')
      }
      catch {
        return undefined
      }
    },
    list(rel) {
      try {
        return fs.readdirSync(path.join(root, rel))
      }
      catch {
        return []
      }
    },
    isDir(rel) {
      try {
        return fs.statSync(path.join(root, rel)).isDirectory()
      }
      catch {
        return false
      }
    },
  }
}

/** @returns {Backend | undefined} */
function asarBackend(archive, prefix) {
  if (!archive) return undefined
  return {
    id: `${archive.file}:${prefix}`,
    readText(rel) {
      const text = archive.readText(`${prefix}/${rel}`)
      if (text !== undefined && Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) return undefined
      return text
    },
    list(rel) {
      return archive.list(`${prefix}/${rel}`)
    },
    isDir(rel) {
      return archive.hasDir(`${prefix}/${rel}`)
    },
  }
}

/**
 * Find the profile directory of the running host.
 *
 * The harness CLI is launched as `dsh --profile <name>`, and the desktop app
 * additionally exports `DSH_PROFILE`. Both beat a dependency search (several
 * profiles may depend on this plugin).
 *
 * @param options - `{ ownPackageName, override, dshHome, argv, env }`.
 * @returns the profile directory, or `undefined` when nothing matches.
 */
export function locateProfileDir({ ownPackageName, override, dshHome, argv, env } = {}) {
  const args = argv ?? process.argv
  const environment = env ?? process.env
  const home = dshHome ?? environment.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const profiles = path.join(home, 'profiles')

  const isProfile = (name) => {
    if (typeof name !== 'string' || name === '') return false
    try {
      return fs.statSync(path.join(profiles, name, 'package.json')).isFile()
    }
    catch {
      return false
    }
  }

  if (override) {
    try {
      if (fs.statSync(override).isDirectory()) return override
    }
    catch {
      /* fall through to discovery */
    }
  }

  const flag = args.indexOf('--profile')
  if (flag !== -1 && isProfile(args[flag + 1])) return path.join(profiles, args[flag + 1])
  const inline = args.find(arg => arg.startsWith('--profile='))
  if (inline && isProfile(inline.slice('--profile='.length))) return path.join(profiles, inline.slice('--profile='.length))
  if (environment.DSH_PROFILE && isProfile(environment.DSH_PROFILE)) return path.join(profiles, environment.DSH_PROFILE)

  let entries = []
  try {
    entries = fs.readdirSync(profiles, { withFileTypes: true })
  }
  catch {
    return undefined
  }
  const matches = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(profiles, entry.name)
    let manifest
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    }
    catch {
      continue
    }
    const bundles = manifest?.dsh?.profile?.bundles
    if (!Array.isArray(bundles)) continue
    const depends = Boolean(ownPackageName) && Boolean(manifest?.dependencies?.[ownPackageName])
    matches.push({ dir, bundles, depends })
  }
  const preferred = matches.find(m => m.depends)
  if (preferred) return preferred.dir
  return matches.length === 1 ? matches[0].dir : undefined
}

/**
 * Resolve a loader specifier to a readable entry file across the install tree.
 *
 * @returns `{ backend, packageName, entryPath }`, or `undefined`.
 */
function resolveSpecifier(specifier, packageRoots) {
  const { packageName, subpath } = splitSpecifier(specifier)
  const root = packageRoots.get(packageName)
  if (!root) return undefined
  const { backend, prefix } = root
  const manifestText = backend.readText(`${prefix}/package.json`)
  if (!manifestText) return undefined
  let manifest
  try {
    manifest = JSON.parse(manifestText)
  }
  catch {
    return undefined
  }
  const key = subpath ?? '.'
  let entry
  const exported = manifest?.exports?.[key]
  if (typeof exported === 'string') entry = exported
  else if (exported && typeof exported === 'object') entry = exported.default ?? exported.import ?? exported.require
  if (!entry && key === '.') entry = manifest?.main
  if (!entry) entry = subpath ? `${subpath.slice(2)}/index.js` : 'index.js'
  entry = String(entry).replace(/^\.\//, '')
  return { backend, packageName, entryPath: `${prefix}/${entry}` }
}

/** Absolute-or-archive path helpers for one entry file. */
function dirOf(entryPath) {
  const cut = entryPath.lastIndexOf('/')
  return cut === -1 ? '' : entryPath.slice(0, cut)
}

/**
 * Collect tool-name literals from one source file.
 *
 * Only files that really register tools count: an HTTP route handler also has
 * `name:` literals (`ctx.webServer.register({ path, name: 'read' })`), and
 * those must never be mistaken for tools.
 *
 * @returns candidate names; empty when the file registers no tool.
 */
function namesFromText(text) {
  const fileNames = new Set()
  if (!text || !/tools\s*\.\s*register/.test(text)) return fileNames
  // Names are often indirect: `name: EXIT_PLAN_MODE` with the literal in a
  // const, or `name: toolName` where the default lives in a config schema.
  const consts = new Map()
  for (const match of text.matchAll(CONST_STRING)) consts.set(match[1], match[3])
  TOOL_REGISTER.lastIndex = 0
  for (const match of text.matchAll(TOOL_REGISTER)) {
    const window = text.slice(match.index, match.index + REGISTER_OPTIONS_WINDOW)
    const literal = /\bname\s*:\s*(['"])([a-z][a-z0-9_]{1,60})\1/.exec(window)
    if (literal) {
      fileNames.add(literal[2])
      continue
    }
    REGISTER_NAME_IDENT.lastIndex = 0
    const ident = REGISTER_NAME_IDENT.exec(window)
    if (!ident) continue
    const resolved = consts.get(ident[1])
    if (resolved) fileNames.add(resolved)
  }
  // Configurable names (`toolName: z.string().default('subagent')`) only
  // resolve through the schema default; the live-registry intersection later
  // drops anything that is not an actual tool. A file may also pass a prebuilt
  // definition to `register(definition)` — then only that default names it.
  if (/\btoolName\b/.test(text) && /\.default\(/.test(text)) {
    for (const match of text.matchAll(DEFAULT_STRING)) fileNames.add(match[2])
  }
  // Helper-style plugins build the definition elsewhere and register it by
  // reference; fall back to every name literal in the file for those.
  if (fileNames.size === 0) {
    for (const match of text.matchAll(NAME_LITERAL)) fileNames.add(match[2])
  }
  return fileNames
}

/**
 * Collect tool names for a loader row from its module entry.
 *
 * A subpath row (`…/list-agents`) owns exactly the module it names, so its own
 * file is authoritative; only when that file registers nothing do we widen to
 * the sibling modules of the package (bundles that re-export their tools).
 *
 * @returns the candidate names (unvalidated against the live registry).
 */
function scanEntry(browser, entryPath) {
  // A file entry is authoritative: a settings/helper module that registers no
  // tool owns none, and widening to its siblings would borrow the package's
  // real tools into an unrelated chip. Only a directory entry (a package root
  // whose manifest main is a directory, or an explicitly-invalid subpath) is
  // walked.
  if (entryPath.endsWith('.js')) return namesFromText(browser.readText(entryPath))
  const names = new Set()
  let files = 0
  const dir = dirOf(entryPath)
  const walk = (relative, depth) => {
    if (files >= MAX_FILES_PER_ENTRY || depth > 2) return
    for (const child of browser.list(relative)) {
      if (files >= MAX_FILES_PER_ENTRY) return
      if (SKIP_DIR.has(child)) continue
      const childPath = relative === '' ? child : `${relative}/${child}`
      if (browser.isDir(childPath)) {
        walk(childPath, depth + 1)
        continue
      }
      if (!child.endsWith('.js') || SKIP_FILE.test(childPath)) continue
      files += 1
      for (const name of namesFromText(browser.readText(childPath))) names.add(name)
    }
  }
  walk(dir, 0)
  return names
}

/**
 * Build the static inventory: loader row id → candidate tool names.
 *
 * @param options - `{ profileDir, asarPath, logger }`.
 * @returns `{ rows, asar, warnings }`; `rows` is a Map keyed by row id.
 */
export function scanInstalledPlugins({ profileDir, asarPath, logger } = {}) {
  const warnings = []
  const skipped = []
  const archivePath = asarPath ?? locateAsar()
  const archive = AsarArchive.open(archivePath)
  if (!archive) {
    warnings.push(`host archive not found: host bundle tools cannot be attributed (${archivePath ?? 'no candidate'}${AsarArchive.lastError ? `; ${AsarArchive.lastError}` : ''})`)
  }
  const backends = []
  const profileBackend = profileDir ? directoryBackend(profileDir) : undefined
  if (profileBackend) backends.push(profileBackend)
  const hostBackend = asarBackend(archive, 'dsh')
  if (hostBackend) backends.push(hostBackend)

  /** @type {Map<string, {backend: Backend, prefix: string}>} */
  const packageRoots = new Map()
  for (const backend of backends) {
    for (const name of backend.list('node_modules')) {
      if (name.startsWith('.')) continue
      if (name.startsWith('@')) {
        for (const scoped of backend.list(`node_modules/${name}`)) {
          packageRoots.set(`${name}/${scoped}`, { backend, prefix: `node_modules/${name}/${scoped}` })
        }
        continue
      }
      packageRoots.set(name, { backend, prefix: `node_modules/${name}` })
    }
  }

  let bundles = []
  if (profileBackend) {
    const manifestText = profileBackend.readText('package.json')
    if (manifestText) {
      try {
        bundles = JSON.parse(manifestText)?.dsh?.profile?.bundles ?? []
      }
      catch {
        warnings.push('profile package.json is not valid JSON')
      }
    }
  }

  /** @type {Map<string, {rowId: string, specifier: string, packageName: string, tools: Set<string>, preset?: boolean}>} */
  const rows = new Map()
  // A row can rename the tool it mounts through its own config
  // (`toolName: subagent_fork`), which no source literal reveals.
  const TOOL_CONFIG_VALUE = /^[a-z][a-z0-9_]{2,60}$/
  const configToolNames = row => {
    const names = []
    const value = row.props?.toolName
    if (typeof value === 'string' && TOOL_CONFIG_VALUE.test(value)) names.push(value)
    return names
  }
  const handlePatch = (patchText, sourceLabel, { preset = false } = {}) => {
    for (const row of parsePatchRows(patchText)) {
      if (!row.name || row.group) continue
      if (row.disabled === 'true') continue
      // A row nested under an isolated group belongs to an agent preset even
      // when the bundle's main patch declares it (e.g. the coding bundle's
      // `planning` group owns `plan-mode`).
      const presetRow = preset || row.agentScoped === true
      const resolved = resolveSpecifier(row.name, packageRoots)
      const rowId = row.id ?? row.name
      if (!resolved) {
        // A row may name a package that exists without exposing that subpath, or
        // the row id may be a label. Fall back to the package ROOT FOLDER named
        // by the specifier: whatever that package's sources register belongs to
        // it, and the chip is labelled with the root folder.
        const { packageName } = splitSpecifier(row.name)
        const root = packageRoots.get(packageName)
        if (root) {
          const tools = scanEntry(root.backend, `${root.prefix}/package.json`)
          for (const name of configToolNames(row)) tools.add(name)
          rows.set(rowId, { rowId, specifier: packageName, packageName, tools, preset: presetRow, configTools: configToolNames(row) })
          continue
        }
        // Model ids, labels and CLI/plugin aliases are rows too, not packages;
        // note them for diagnostics but do not treat them as failures.
        skipped.push(`${sourceLabel}: no package for row "${rowId}" (${row.name})`)
        continue
      }
      const tools = scanEntry(resolved.backend, resolved.entryPath)
      for (const name of configToolNames(row)) tools.add(name)
      rows.set(rowId, { rowId, specifier: row.name, packageName: resolved.packageName, tools, preset: presetRow, configTools: configToolNames(row) })
    }
  }

  // The agent preset decides which tool plugins a conversation really mounts.
  // Only that preset's rows are listed; the other preset files in the same
  // bundle would otherwise add chips for tools this profile never loads. Some
  // profiles use a preset whose patch file is not shipped as a file at all
  // (e.g. `coding`, whose roster comes from the coding bundle) — then every
  // preset file is read, and duplicate tool names are deduped downstream.
  const ownPatchText = profileBackend?.readText('cordis.patch.yml')
  const registryRow = ownPatchText
    ? parsePatchRows(ownPatchText).find(row => row.id === 'agent-preset-registry' || row.name === '@deepseek-ai/dsh-agent-preset-registry')
    : undefined
  const activePreset = registryRow?.props?.selectedDefault ?? registryRow?.props?.default

  /** @type {{ bundle: string, path: string, isPreset: boolean, preset?: string, text: string, label: string }[]} */
  const patches = []
  for (const bundle of bundles) {
    const resolved = resolveSpecifier(bundle, packageRoots)
    const root = packageRoots.get(splitSpecifier(bundle).packageName)
    if (!resolved || !root) {
      warnings.push(`bundle not found: ${bundle}`)
      continue
    }
    let patchRel
    try {
      const manifest = JSON.parse(root.backend.readText(`${root.prefix}/package.json`) ?? '')
      patchRel = manifest?.dsh?.bundle?.patch
    }
    catch {
      /* not a bundle package */
    }
    if (!patchRel) continue
    const patchFiles = Array.isArray(patchRel)
      ? patchRel
      : String(patchRel).split(',').map(part => part.trim()).filter(Boolean)
    for (const patchFile of patchFiles) {
      const path = String(patchFile).replace(/^\.\//, '')
      const patchText = root.backend.readText(`${root.prefix}/${path}`)
      if (!patchText) {
        warnings.push(`bundle ${bundle}: patch ${patchFile} unreadable`)
        continue
      }
      const isPreset = /(?:^|\/)presets\//.test(path)
      const preset = isPreset ? /([\w-]+)\.patch\.yml$/.exec(path)?.[1] : undefined
      patches.push({ bundle, path, isPreset, preset, text: patchText, label: `${bundle}:${patchFile}` })
    }
  }
  const activePresetShipped = !activePreset || patches.some(entry => entry.preset === activePreset)
  for (const entry of patches) {
    // When the selected preset ships its own patch file, only that file counts.
    // When it does not (a preset whose roster comes from a bundle patch, e.g.
    // `coding`), the preset files of OTHER presets are skipped and the bundle's
    // agent-scoped rows are used instead.
    if (entry.isPreset && activePreset && (!activePresetShipped || entry.preset !== activePreset)) continue
    handlePatch(entry.text, entry.label, { preset: entry.isPreset })
  }

  if (profileBackend) {
    const ownPatch = ownPatchText ?? profileBackend.readText('cordis.patch.yml')
    if (ownPatch) handlePatch(ownPatch, 'profile patch')
  }

  // Leftovers (a tool whose row gave no name literal: names built at runtime,
  // MCP passthrough tools, and so on) are attributed by ROOT FOLDER: search the
  // locally installed plugin packages for the literal name and report the
  // package that contains it. Host-archive packages are skipped — they are all
  // covered by rows, and scanning them would be far more expensive.
  const ownerCandidates = []
  if (profileBackend) {
    for (const [packageName, root] of packageRoots) {
      if (root.backend !== profileBackend) continue
      const manifestText = profileBackend.readText(`${root.prefix}/package.json`)
      if (!manifestText) continue
      let manifest
      try {
        manifest = JSON.parse(manifestText)
      }
      catch {
        continue
      }
      if (!manifest?.dsh && !bundles.includes(packageName)) continue
      ownerCandidates.push({ packageName, backend: root.backend, prefix: root.prefix })
    }
  }
  const ownerCache = new Map()
  /** Walk one plugin package (≤3 levels) and report whether `test` matched a source file. */
  const scanPackage = (candidate, test, budget, extensions) => {
    let hit = false
    const walk = (relative, depth) => {
      if (hit || budget.left <= 0 || depth > 3) return
      for (const child of candidate.backend.list(relative)) {
        if (hit || budget.left <= 0) return
        if (SKIP_DIR.has(child)) continue
        const childPath = relative === '' ? child : `${relative}/${child}`
        if (candidate.backend.isDir(childPath)) {
          walk(childPath, depth + 1)
          continue
        }
        if (!extensions.some(extension => child.endsWith(extension)) || SKIP_FILE.test(childPath)) continue
        budget.left -= 1
        const text = candidate.backend.readText(childPath)
        if (!text || Buffer.byteLength(text, 'utf8') > MAX_OWNER_FILE_BYTES) continue
        if (test(text)) {
          hit = true
          return
        }
      }
    }
    walk(candidate.prefix, 0)
    return hit
  }
  const findOwner = (toolName) => {
    if (typeof toolName !== 'string' || toolName === '') return undefined
    if (ownerCache.has(toolName)) return ownerCache.get(toolName)
    const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const quoted = new RegExp(`['"\`]${escaped}['"\`]`)
    const bareKey = new RegExp(`\\b${escaped}\\s*:`)
    // Tier 1 prefers a real registration source (quoted literal or object key).
    // Tier 2 widens the file types: a tool name produced by a bundled agent/MCP
    // runtime leaves no literal in the shipped `.js` (billion-context builds its
    // ACP tool table at runtime) but does appear in the source map's embedded
    // sources and in its markdown docs.
    const tiers = [
      { extensions: ['.js'], test: text => /tools\s*\.\s*register/.test(text) && (quoted.test(text) || bareKey.test(text)) },
      { extensions: ['.js'], test: text => quoted.test(text) },
      { extensions: ['.mjs', '.cjs', '.map', '.md'], test: text => quoted.test(text) },
    ]
    let found
    for (const tier of tiers) {
      if (found) break
      const budget = { left: MAX_OWNER_FILES }
      for (const candidate of ownerCandidates) {
        if (found) break
        if (scanPackage(candidate, tier.test, budget, tier.extensions)) found = candidate.packageName
      }
    }
    ownerCache.set(toolName, found)
    return found
  }

  logger?.debug?.(`tool-gate: scanned ${rows.size} tool-providing rows (${warnings.length} warnings, ${skipped.length} non-package rows)`)
  return { rows, asar: archive, warnings, skipped, findOwner }
}
