/**
 * client-smoke.mjs — loads the pre-bundled client bundle in Node with a fake
 * module loader + fake React, and asserts the slot contributions it declares.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const code = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

let loaded
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition
    },
  },
}

const reactStub = {
  createElement() {
    return null
  },
  useEffect() {},
  useSyncExternalStore() {
    return {}
  },
}

const registrations = []
const ctx = {
  effect(fn) {
    fn()
  },
  slots: {
    inject(name, factory) {
      const iterator = factory()
      iterator.next()
      return () => {}
    },
    register(spec) {
      registrations.push(spec)
      return () => {}
    },
  },
}

new Function('window', code)(globalThis.window)

assert.ok(loaded, 'bundle registered itself with __ModuleLoader__')
assert.equal(loaded.id, 'dsh-tool-gate', 'bundle id matches the package name')

const exported = loaded.factory(name => {
  assert.equal(name, 'react', `unexpected module request: ${name}`)
  return reactStub
})

assert.equal(exported.name, 'tool-gate')
assert.deepEqual(exported.inject, ['slots'])
exported.apply(ctx)

assert.deepEqual(
  registrations.map(spec => `${spec.name}#${spec.id}`),
  ['conversation.input.dock#tool-gate-dialog', 'conversation.input.left#tool-gate-open'],
)

console.log('client-smoke: all assertions passed')
