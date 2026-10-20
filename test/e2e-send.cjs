/**
 * e2e-send.cjs — end-to-end gate check against a fake model:
 * 1. waits for the tool-gate dialog, disables the baseline plugin group, applies
 * 2. types a prompt into the composer and sends it
 * 3. waits for the assistant turn, then dumps transcript + control facts
 *
 * Usage: electron --no-sandbox e2e-send.cjs <url-with-token>
 */

const fs = require('node:fs')
const path = require('node:path')

const url = process.argv.filter(arg => /^https?:\/\//.test(arg)).pop()
const logFile = path.join(__dirname, 'send.log')
const shotFile = path.join(__dirname, 'send-shot.png')

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

const waitDialog = (ms) => `new Promise((resolve) => {
  const started = Date.now()
  const timer = setInterval(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="本会话启用的插件工具"]')
    if (dialog) { clearInterval(timer); resolve(true) }
    else if (Date.now() - started > ${ms}) { clearInterval(timer); resolve(false) }
  }, 250)
})`

const configureGate = `(() => {
  const dialog = document.querySelector('[role="dialog"][aria-label="本会话启用的插件工具"]')
  if (!dialog) return { ok: false, reason: 'no dialog' }
  const chips = [...dialog.querySelectorAll('button')].filter(b => /个工具/.test(b.textContent || ''))
  const target = chips.find(b => /dsh-builtin-browser|tool-browser/.test(b.textContent || '')) || chips[0]
  if (!target) return { ok: false, reason: 'no chips' }
  const before = target.textContent
  target.click()
  const after = target.textContent
  const apply = [...dialog.querySelectorAll('button')].find(b => /^应用$/.test((b.textContent || '').trim()))
  if (apply) apply.click()
  return { ok: true, before, after, applied: !!apply }
})()`

const clickNewSession = `(() => {
  const candidates = [...document.querySelectorAll('button,a,[role="button"]')]
  const match = candidates.find(el => /新建会话/.test((el.textContent || '').trim()))
  if (!match) return null
  match.click()
  return true
})()`

const focusComposer = `(() => {
  const editable = document.querySelector('[contenteditable="true"]')
  if (!editable) return null
  editable.focus()
  return (editable.getAttribute('aria-label') || '').slice(0, 40)
})()`

const composerText = `(() => {
  const editable = document.querySelector('[contenteditable="true"]')
  return editable ? (editable.textContent || '') : null
})()`

const clickSend = `(() => {
  const buttons = [...document.querySelectorAll('button')]
  const send = buttons.find(b => /发送消息|发送|Send/.test((b.getAttribute('aria-label') || '') + ' ' + (b.title || '')))
  if (!send) return { ok: false, labels: buttons.map(b => b.getAttribute('aria-label')).filter(Boolean).slice(0, 20) }
  send.click()
  return { ok: true, sendName: (send.getAttribute('aria-label') || '').trim() }
})()`

const turnState = `(() => {
  const body = document.body.innerText || ''
  return {
    dialogOpen: !!document.querySelector('[role="dialog"][aria-label="本会话启用的插件工具"]'),
    mentionsWorkingDirectory: body.includes('working_directory'),
    mentionsRefused: /拒绝|disabled|forbidden|not allowed|不可用/.test(body),
    tail: body.slice(-1200),
  }
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
    if (String(level) === '3' || String(message).indexOf('tool-gate') >= 0) log('[console:' + level + ']', message)
  })

  try {
    await win.loadURL(url)
    log('loaded')
    await new Promise(resolve => setTimeout(resolve, 1500))
    log('new-session ' + JSON.stringify(await win.webContents.executeJavaScript(clickNewSession)))
    let seen = await win.webContents.executeJavaScript(waitDialog(45000))
    log('dialog seen: ' + seen)
    if (seen) {
      await new Promise(resolve => setTimeout(resolve, 600))
      log('configure ' + JSON.stringify(await win.webContents.executeJavaScript(configureGate)))
      await new Promise(resolve => setTimeout(resolve, 900))
    }
    log('focus ' + JSON.stringify(await win.webContents.executeJavaScript(focusComposer)))
    win.webContents.insertText('say hi')
    await new Promise(resolve => setTimeout(resolve, 600))
    log('composer ' + JSON.stringify(await win.webContents.executeJavaScript(composerText)))
    log('send ' + JSON.stringify(await win.webContents.executeJavaScript(clickSend)))
    for (let i = 0; i < 20; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 1500))
      const state = await win.webContents.executeJavaScript(turnState)
      log('turn[' + i + '] ' + JSON.stringify({ ...state, tail: state.tail.slice(-300) }))
      if (/OK$/.test(state.tail.trim()) && !/thinking|思考/.test(state.tail)) break
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
