/**
 * e2e-toggle.cjs — clicks the first chip and samples its label over time,
 * to see whether the toggle sticks or a refresh overrides it.
 *
 * Usage: electron --no-sandbox e2e-toggle.cjs <url-with-token>
 */

const fs = require('node:fs')
const path = require('node:path')

const url = process.argv.filter(arg => /^https?:\/\//.test(arg)).pop()
const logFile = path.join(__dirname, 'toggle.log')

function log(...parts) {
  fs.appendFileSync(logFile, parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ') + '\n')
}

try {
  fs.unlinkSync(logFile)
} catch {
  /* first run */
}

const { app, BrowserWindow } = require('electron')

const script = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const find = () => document.querySelector('[role="dialog"][aria-label="本会话启用的插件工具"]')
  const waitDialog = async () => {
    for (let i = 0; i < 160; i += 1) {
      if (find()) return true
      const open = [...document.querySelectorAll('button')].find(b => /工具门控/.test(b.textContent || ''))
      if (open && i === 4) open.click()
      await sleep(250)
    }
    return false
  }
  if (!(await waitDialog())) return { ok: false, reason: 'no dialog' }
  const label = () => {
    const dialog = find()
    if (!dialog) return null
    const chip = [...dialog.querySelectorAll('button')].find(b => /个工具/.test(b.textContent || ''))
    return chip ? (chip.textContent || '').trim() : null
  }
  const chip = [...find().querySelectorAll('button')].find(b => /个工具/.test(b.textContent || ''))
  const before = label()
  chip.click()
  const samples = []
  for (const delay of [80, 250, 600, 1200, 2500, 5000]) {
    await sleep(delay)
    samples.push([delay, label()])
  }
  return { ok: true, before, samples }
})()`

app.on('window-all-closed', () => app.quit())

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1440, height: 960, webPreferences: { backgroundThrottling: false } })
  win.webContents.on('console-message', (_e, level, message) => {
    if (String(level) === '3') log('[page-error]', message)
  })
  try {
    await win.loadURL(url)
    log('loaded')
    const result = await win.webContents.executeJavaScript(script)
    log('toggle ' + JSON.stringify(result))
  } catch (error) {
    log('error ' + (error && error.stack ? error.stack : String(error)))
  } finally {
    app.quit()
  }
})
