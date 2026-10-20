/**
 * e2e-confirm.cjs — checks the mid-conversation confirmation flow: disable a
 * chip, press 应用, expect the warning (role=alert) and a 仍然应用 button, then
 * confirm and verify the dialog closes.
 *
 * Usage: electron --no-sandbox e2e-confirm.cjs <url-with-token> [sessionId]
 */

const fs = require('node:fs')
const path = require('node:path')

const url = process.argv.filter(arg => /^https?:\/\//.test(arg)).pop()
const explicitSession = process.argv[2] && !/^https?:/.test(process.argv[2]) ? process.argv[2] : ''
const logFile = path.join(__dirname, 'confirm.log')
const shotFile = path.join(__dirname, 'confirm-shot.png')

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

const clickGateButton = `(() => {
  const candidates = [...document.querySelectorAll('button,a,[role="button"]')]
  const match = candidates.find(el => /工具门控/.test(el.textContent || ''))
  if (match) { match.click(); return (match.textContent || '').trim() }
  return null
})()`

function interactScript(sessionId) {
  return `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const findDialog = () => document.querySelector('[role="dialog"][aria-label="本会话启用的插件工具"]')
  const dialog = findDialog()
  if (!dialog) return { ok: false, reason: 'no dialog' }
  const chip = [...dialog.querySelectorAll('button')].find(b => /个工具/.test(b.textContent || ''))
  if (!chip) return { ok: false, reason: 'no chips' }
  const chipText = chip.textContent
  if (/✕/.test(chipText)) chip.click()
  await sleep(500)
  const chipAfter = [...(findDialog() || dialog).querySelectorAll('button')]
    .filter(b => /个工具/.test(b.textContent || ''))
    .slice(0, 3)
    .map(b => (b.textContent || '').trim())
  const apply = [...(findDialog() || dialog).querySelectorAll('button')].find(b => /^应用$/.test((b.textContent || '').trim()))
  if (!apply) return { ok: false, reason: 'no apply' }
  apply.click()
  await sleep(1500)
  const dialogAfter = findDialog() || dialog
  const alert = document.querySelector('[role="alert"]')
  const buttons = [...dialogAfter.querySelectorAll('button')].map(b => (b.textContent || '').trim())
  const confirmButton = [...dialogAfter.querySelectorAll('button')].find(b => /仍然应用/.test(b.textContent || ''))
  const result = {
    chipText,
    chipAfter,
    alertText: alert ? (alert.textContent || '').slice(0, 300) : null,
    hasConfirmButton: !!confirmButton,
    dialogOpen: !!document.querySelector('[role="dialog"][aria-label="本会话启用的插件工具"]'),
    buttons,
  }
  if (confirmButton) {
    confirmButton.click()
    await sleep(1500)
    result.dialogOpenAfterConfirm = !!document.querySelector('[role="dialog"][aria-label="本会话启用的插件工具"]')
    const id = ${JSON.stringify(sessionId)} || (location.href.match(/session[\\/-]([A-Za-z0-9_-]{8,})/) || [])[1] || ''
    try {
      const res = await fetch('/tool-gate/api/state?sessionId=' + encodeURIComponent(id))
      const json = await res.json()
      result.savedChoice = json && json.value ? json.value.choice : null
    } catch (error) {
      result.savedChoice = 'fetch-error: ' + String(error)
    }
  }
  return result
})()`
}

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
      await new Promise(resolve => setTimeout(resolve, 1500))
      seen = await win.webContents.executeJavaScript(waitForDialog)
    }
    if (!seen) {
      const opened = await win.webContents.executeJavaScript(clickGateButton)
      log('clicked gate button:', String(opened))
      await new Promise(resolve => setTimeout(resolve, 1200))
      seen = await win.webContents.executeJavaScript(waitForDialog)
    }
    log('dialog seen: ' + seen)
    if (seen) {
      await new Promise(resolve => setTimeout(resolve, 800))
      const result = await win.webContents.executeJavaScript(interactScript(explicitSession))
      log('confirm ' + JSON.stringify(result))
      await new Promise(resolve => setTimeout(resolve, 600))
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
