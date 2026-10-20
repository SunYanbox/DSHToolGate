/**
 * e2e-send2.cjs — isolation check: new session, dismiss the gate dialog with
 * "稍后再说" (no config written), send a prompt, and confirm the fake model
 * still receives working_directory in its tool list.
 *
 * Usage: electron --no-sandbox e2e-send2.cjs <url-with-token>
 */

const fs = require('node:fs')
const path = require('node:path')

const url = process.argv.filter(arg => /^https?:\/\//.test(arg)).pop()
const logFile = path.join(__dirname, 'send2.log')

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

const dismissDialog = `(() => {
  const dialog = document.querySelector('[role="dialog"][aria-label="本会话启用的插件工具"]')
  if (!dialog) return { ok: false, reason: 'no dialog' }
  const buttons = [...dialog.querySelectorAll('button')]
  const later = buttons.find(b => /稍后|取消|later/i.test((b.textContent || '').trim()))
  if (later) { later.click(); return { ok: true, action: 'later', label: later.textContent } }
  const close = buttons.find(b => /关闭/.test(b.getAttribute('aria-label') || ''))
  if (close) { close.click(); return { ok: true, action: 'close' } }
  return { ok: false, reason: 'no dismiss button', labels: buttons.map(b => b.textContent) }
})()`

const focusComposer = `(() => {
  const editable = document.querySelector('[contenteditable="true"]')
  if (!editable) return null
  editable.focus()
  return true
})()`

const clickSend = `(() => {
  const buttons = [...document.querySelectorAll('button')]
  const send = buttons.find(b => /发送消息|发送|Send/.test((b.getAttribute('aria-label') || '') + ' ' + (b.title || '')))
  if (!send) return { ok: false }
  send.click()
  return { ok: true }
})()`

const turnState = `(() => {
  const body = document.body.innerText || ''
  return {
    mentionsRefused: /tool-gate|tool is masked/.test(body),
    tail: body.slice(-400),
  }
})()`

app.on('window-all-closed', () => app.quit())

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true,
    width: 1440,
    height: 960,
    webPreferences: { backgroundThrottling: false },
  })
  try {
    await win.loadURL(url)
    await new Promise(resolve => setTimeout(resolve, 1800))
    const clicked = await win.webContents.executeJavaScript(`(() => {
      const match = [...document.querySelectorAll('button,a,[role="button"]')].find(el => /新建会话/.test((el.textContent || '').trim()))
      if (!match) return null
      match.click()
      return (match.textContent || '').trim()
    })()`)
    log('new session click: ' + String(clicked))
    await new Promise(resolve => setTimeout(resolve, 1200))
    let seen = await win.webContents.executeJavaScript(waitDialog(45000))
    log('dialog seen: ' + seen)
    if (seen) {
      await new Promise(resolve => setTimeout(resolve, 500))
      log('dismiss ' + JSON.stringify(await win.webContents.executeJavaScript(dismissDialog)))
      await new Promise(resolve => setTimeout(resolve, 600))
    }
    await win.webContents.executeJavaScript(focusComposer)
    win.webContents.insertText('say hi again')
    await new Promise(resolve => setTimeout(resolve, 500))
    log('send ' + JSON.stringify(await win.webContents.executeJavaScript(clickSend)))
    for (let i = 0; i < 12; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 1500))
      const state = await win.webContents.executeJavaScript(turnState)
      log('turn[' + i + '] ' + JSON.stringify({ ...state, tail: state.tail.slice(-200) }))
      if (/OK\s*$/.test(state.tail.trim())) break
    }
    const image = await win.capturePage()
    fs.writeFileSync(path.join(__dirname, 'send2-shot.png'), image.toPNG())
  } catch (error) {
    log('error ' + (error && error.stack ? error.stack : String(error)))
  } finally {
    app.quit()
  }
})
