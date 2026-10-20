/**
 * e2e-ui.cjs — launches the DSH web UI in an Electron window, waits for the
 * tool-gate dialog, and writes a screenshot + a log next to this script.
 *
 * Usage: electron --no-sandbox e2e-ui.cjs <url-with-token>
 */

const fs = require('node:fs')
const path = require('node:path')

const url = process.argv.filter(arg => /^https?:\/\//.test(arg)).pop()
const logFile = path.join(__dirname, 'e2e.log')
const shotFile = path.join(__dirname, 'e2e-shot.png')

function log(...parts) {
  const line = parts
    .map(part => (typeof part === 'string' ? part : JSON.stringify(part)))
    .join(' ')
  fs.appendFileSync(logFile, line + '\n')
}

try {
  fs.unlinkSync(logFile)
} catch {
  /* first run */
}

log('boot url=' + String(url))

const { app, BrowserWindow } = require('electron')

const probe = `(() => {
  const text = document.body ? document.body.innerText : ''
  const found = text.includes('本会话启用哪些插件的工具')
  const chips = [...document.querySelectorAll('button')]
    .map(b => (b.textContent || '').trim())
    .filter(t => /个工具/.test(t))
  const headings = [...document.querySelectorAll('h1,h2,h3,[role="dialog"]')]
    .map(el => (el.textContent || '').trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, 12)
  return { found, chips, headings, title: document.title, text: text.slice(0, 400) }
})()`

const clickNewSession = `(() => {
  const candidates = [...document.querySelectorAll('button,a,[role="button"]')]
  const match = candidates.find(el => /新会话|新建会话|新建对话|New session|开始对话/.test(el.textContent || ''))
  if (match) { match.click(); return (match.textContent || '').trim() }
  return null
})()`

app.on('window-all-closed', () => {
  app.quit()
})

app.whenReady().then(async () => {
  log('ready')
  const win = new BrowserWindow({
    show: true,
    width: 1440,
    height: 960,
    webPreferences: { backgroundThrottling: false },
  })

  win.webContents.on('console-message', (_event, level, message) => {
    log('[page]', String(level), message)
  })
  win.webContents.on('did-fail-load', (_event, code, description) => {
    log('[e2e] did-fail-load', code, description)
  })

  try {
    await win.loadURL(url)
    log('loaded')

    const started = Date.now()
    let result = { found: false }
    let clicked = null
    while (Date.now() - started < 45000) {
      result = await win.webContents.executeJavaScript(probe)
      if (result.found) break
      if (!clicked && Date.now() - started > 5000) {
        clicked = await win.webContents.executeJavaScript(clickNewSession)
        if (clicked) log('clicked new-session:', clicked)
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }

    log('result ' + JSON.stringify(result))
    await new Promise(resolve => setTimeout(resolve, 1200))
    const image = await win.capturePage()
    fs.writeFileSync(shotFile, image.toPNG())
    log('screenshot ' + shotFile)
  } catch (error) {
    log('error ' + (error && error.stack ? error.stack : String(error)))
  } finally {
    app.quit()
  }
})
