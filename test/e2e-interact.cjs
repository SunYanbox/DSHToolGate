/**
 * e2e-interact.cjs — drives the tool-gate dialog in a real Electron window:
 * hovers a chip (tooltip), toggles it, applies, and reports the API state.
 *
 * Usage: electron --no-sandbox e2e-interact.cjs <url-with-token>
 */

const fs = require('node:fs')
const path = require('node:path')

const url = process.argv.filter(arg => /^https?:\/\//.test(arg)).pop()
const logFile = path.join(__dirname, 'interact.log')
const shotFile = path.join(__dirname, 'interact-shot.png')

function log(...parts) {
  fs.appendFileSync(
    logFile,
    parts.map(part => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ') + '\n',
  )
}

try {
  fs.unlinkSync(logFile)
} catch {
  /* first run */
}

const { app, BrowserWindow } = require('electron')

const waitForDialog = `new Promise((resolve) => {
  const started = Date.now()
  const timer = setInterval(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="本会话启用的插件工具"]')
    if (dialog) { clearInterval(timer); resolve(true) }
    else if (Date.now() - started > 40000) { clearInterval(timer); resolve(false) }
  }, 250)
})`

const clickNewSession = `(() => {
  const candidates = [...document.querySelectorAll('button,a,[role="button"]')]
  const match = candidates.find(el => /新会话|新建会话|新建对话|New session|开始对话/.test(el.textContent || ''))
  if (match) { match.click(); return (match.textContent || '').trim() }
  return null
})()`

const interact = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const dialog = document.querySelector('[role="dialog"][aria-label="本会话启用的插件工具"]')
  if (!dialog) return { ok: false, reason: 'no dialog' }
  const chips = [...dialog.querySelectorAll('button')].filter(b => /个工具/.test(b.textContent || ''))
  if (chips.length === 0) return { ok: false, reason: 'no chips' }
  const chip = chips[0]
  const before = chip.textContent
  chip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  await sleep(400)
  const tooltipText = (dialog.textContent || '').includes('将注册')
    ? (dialog.textContent || '').split('将注册')[1].slice(0, 200)
    : ''
  chip.click()
  await sleep(300)
  const afterToggle = [...dialog.querySelectorAll('button')]
    .filter(b => /个工具/.test(b.textContent || ''))
    .map(b => b.textContent)
  const apply = [...dialog.querySelectorAll('button')].find(b => /^应用$/.test((b.textContent || '').trim()))
  if (apply) apply.click()
  await sleep(1200)
  const sessionId = (location.pathname.match(/session[\\/-]([A-Za-z0-9_-]+)/) || [])[1] || ''
  let state = null
  try {
    const response = await fetch('/tool-gate/api/state?sessionId=' + encodeURIComponent(sessionId))
    state = await response.json()
  } catch (error) {
    state = { fetchError: String(error) }
  }
  const dialogStillOpen = !!document.querySelector('[role="dialog"][aria-label="本会话启用的插件工具"]')
  return { ok: true, before, tooltipText, afterToggle, dialogStillOpen, sessionId, state }
})()`

app.on('window-all-closed', () => app.quit())

app.whenReady().then(async () => {
  log('boot url=' + String(url))
  const win = new BrowserWindow({
    show: true,
    width: 1440,
    height: 960,
    webPreferences: { backgroundThrottling: false },
  })

  win.webContents.on('console-message', (_event, level, message) => {
    if (String(level) === '3') log('[page-error]', message)
  })

  try {
    await win.loadURL(url)
    log('loaded')
    let seen = await win.webContents.executeJavaScript(waitForDialog)
    if (!seen) {
      const clicked = await win.webContents.executeJavaScript(clickNewSession)
      log('clicked new-session:', String(clicked))
      seen = await win.webContents.executeJavaScript(waitForDialog)
    }
    log('dialog seen: ' + seen)
    if (seen) {
      await new Promise(resolve => setTimeout(resolve, 700))
      const result = await win.webContents.executeJavaScript(interact)
      log('interact ' + JSON.stringify(result))
      await new Promise(resolve => setTimeout(resolve, 700))
    }
    const image = await win.capturePage()
    fs.writeFileSync(shotFile, image.toPNG())
    log('screenshot ' + shotFile)
  } catch (error) {
    log('error ' + (error && error.stack ? error.stack : String(error)))
  } finally {
    app.quit()
  }
})
