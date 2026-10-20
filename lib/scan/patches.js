/**
 * Minimal reader for the loader's `cordis.patch.yml` dialect.
 *
 * The plugin only needs ROW IDENTITY, not the composed tree: for every row the
 * patch declares we learn its `id`, the module `name` it mounts, and whether
 * the row is a group or statically disabled. That is enough to map a row id to
 * a package and then to the tool names that package's entry file registers.
 *
 * `disabled` may hold a `!!js` expression, which cannot be evaluated here; such
 * a row is treated as enabled and the runtime schema intersection drops it when
 * it never loads.
 */

/** One loader row harvested from a patch file. */
/**
 * @typedef {object} PatchRow
 * @property {string} id - loader row id (the stable group key).
 * @property {string | undefined} name - mounted module specifier.
 * @property {boolean} group - whether the row only groups children.
 * @property {string | undefined} disabled - raw `disabled:` value.
 * @property {Record<string, string>} props - every other scalar row property
 *   (`toolName`, `preset`, …), so a row's own config can name its tool.
 */

/**
 * Parse a `cordis.patch.yml` text into loader rows.
 *
 * @param text - the patch file contents.
 * @returns rows in declaration order.
 */
export function parsePatchRows(text) {
  if (typeof text !== 'string' || text === '') return []
  const rows = []
  let current
  /** Enclosing `- id:` items, so a row can inherit its group's scope. */
  const stack = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '')
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const item = /^(\s*)-\s+([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (item) {
      const indent = item[1].length
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
      const parent = stack[stack.length - 1]
      current = {
        id: undefined,
        name: undefined,
        group: false,
        disabled: undefined,
        props: {},
        parentId: parent?.row.id,
        // Rows inside an isolated group (`planning` with `isolate: planMode`)
        // mount on the agent scope, so the preset owns them even when they are
        // declared by the bundle's main patch instead of a preset file.
        agentScoped: parent !== undefined && (parent.row.agentScoped === true || (parent.row.group === true && parent.row.props.isolate !== undefined)),
      }
      rows.push(current)
      stack.push({ indent, row: current })
      assign(current, item[2], item[3])
      continue
    }
    const prop = /^\s+([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (prop && current) assign(current, prop[1], prop[2])
  }
  return rows
}

function assign(row, key, rawValue) {
  const value = rawValue.trim().replace(/^(['"])(.*)\1$/, '$2')
  if (key === 'id') row.id = value === '' ? undefined : value
  else if (key === 'name') row.name = value === '' ? undefined : value
  else if (key === 'group') row.group = value === 'true'
  else if (key === 'disabled') row.disabled = value
  else if (row.props) row.props[key] = value
}

/**
 * Split a package specifier into its package name and optional subpath.
 *
 * @param specifier - e.g. `dsh-builtin-browser` or `dsh-builtin-browser/tool-browser`.
 * @returns the package name plus the `./`-prefixed export subpath, if any.
 */
export function splitSpecifier(specifier) {
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) {
    return { packageName: parts.slice(0, 2).join('/'), subpath: parts.length > 2 ? `./${parts.slice(2).join('/')}` : undefined }
  }
  return { packageName: parts[0], subpath: parts.length > 1 ? `./${parts.slice(1).join('/')}` : undefined }
}
