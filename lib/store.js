/**
 * store.js — gate decisions, persisted as JSON.
 *
 * Shape:
 *   {
 *     "version": 1,
 *     "defaults": { "disabled": [...], "updatedAt": "..." },   // last applied choice
 *     "sessions": { "<sessionId>": { "configured": true, "disabled": [...] } }
 *   }
 *
 * `defaults` is what keeps the dialog from ambushing every conversation: a
 * session without its own record inherits the defaults and counts as already
 * configured, so the dialog only opens automatically for the very first
 * conversation (or until the user saves once). A per-session record still wins
 * for that conversation. Writes are atomic (tmp file + rename) and synchronous,
 * which is fine for a file this small and keeps the gateway handler simple.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const FILE_VERSION = 1

export function defaultGateFilePath() {
  if (process.env.DSH_TOOL_GATE_FILE) return path.resolve(process.env.DSH_TOOL_GATE_FILE)
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'tool-gate.json')
}

export class GateStore {
  constructor(file = defaultGateFilePath()) {
    this.file = file
    this.data = { version: FILE_VERSION, sessions: {}, defaults: undefined }
    this.load()
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
        const defaults = parsed.defaults && Array.isArray(parsed.defaults.disabled)
          ? {
              disabled: parsed.defaults.disabled.filter(n => typeof n === 'string'),
              updatedAt: typeof parsed.defaults.updatedAt === 'string' ? parsed.defaults.updatedAt : undefined,
            }
          : undefined
        this.data = { version: FILE_VERSION, sessions: parsed.sessions, defaults }
      }
    } catch {
      /* missing or corrupt file → start empty */
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch (error) {
      this.onWriteError?.(error)
    }
  }

  /** Record for one session; never null. Falls back to the saved defaults. */
  choice(sessionId) {
    const record = this.data.sessions[sessionId]
    if (!record || typeof record !== 'object') {
      const defaults = this.data.defaults
      if (!defaults) return { configured: false, disabled: [], started: false }
      return { configured: true, disabled: [...defaults.disabled], inherited: true, started: false }
    }
    return {
      configured: record.configured === true,
      disabled: Array.isArray(record.disabled) ? record.disabled.filter(n => typeof n === 'string') : [],
      started: record.started === true,
    }
  }

  /** The saved defaults, or undefined when nothing was applied yet. */
  defaults() {
    return this.data.defaults ? { ...this.data.defaults, disabled: [...this.data.defaults.disabled] } : undefined
  }

  /**
   * Persist a decision (marks the session configured).
   *
   * `options.asDefault` also stores it as the profile-wide default, which stops
   * every later conversation from asking again; disable that when the user
   * explicitly only wants to tweak the current conversation.
   */
  setChoice(sessionId, disabled, options = {}) {
    const unique = [...new Set((Array.isArray(disabled) ? disabled : []).filter(n => typeof n === 'string'))]
    const updatedAt = new Date().toISOString()
    const previous = this.data.sessions[sessionId]
    const started = previous?.started === true
    this.data.sessions[sessionId] = { configured: true, disabled: unique, updatedAt, ...(started ? { started: true } : {}) }
    if (options.asDefault !== false) this.data.defaults = { disabled: unique, updatedAt }
    this.save()
    return this.choice(sessionId)
  }

  /**
   * Mark a session as having materialised an agent (i.e. it has been used, not
   * merely opened as a draft).  Used to decide whether changing the choice
   * mid-conversation needs an explicit confirmation.
   */
  markStarted(sessionId) {
    const record = this.data.sessions[sessionId]
    if (record?.started === true) return
    const choice = this.choice(sessionId)
    this.data.sessions[sessionId] = {
      configured: choice.inherited === true ? true : choice.configured === true,
      disabled: [...choice.disabled],
      started: true,
      updatedAt: record?.updatedAt ?? new Date().toISOString(),
    }
    this.save()
  }

  /** Whether an agent ever ran for this session (first message already sent). */
  started(sessionId) {
    return this.data.sessions[sessionId]?.started === true
  }

  /** Forget one session (used when a conversation is deleted). */
  forget(sessionId) {
    if (this.data.sessions[sessionId] === undefined) return false
    delete this.data.sessions[sessionId]
    this.save()
    return true
  }

  /** All configured session ids (diagnostics). */
  sessionIds() {
    return Object.keys(this.data.sessions)
  }
}
