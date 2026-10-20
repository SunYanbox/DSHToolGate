/**
 * e2e-shot.cjs — opens the dialog and saves a screenshot of the page.
 *
 * Usage: electron --no-sandbox e2e-shot.cjs <url-with-token> [output.png]
 */

const fs = require('node:fs')
const path = require('node:path')

const args = process.argv.filter(arg => /^https?:\/\//.test(arg))
const url = args.pop()
const output = path.join(__dirname, process.argv.includes('--out') ? 'shot.png' : 'shot.png')
const logFile = path.join(__dirname, 'shot.log')

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
  const findDialog = () => document.querySelector('[role="dialog"][aria-label="本会话启用的插件工具"]')
  for (let i = 0; i < 120; i += 1) {
    const button = [...document.querySelectorAll('button')].find(b => /工具门控/.test(b.textContent || ''))
    if (findDialog()) break
    if (button) button.click()
    await sleep(250)
  }
  await sleep(1200)
  const dialog = findDialog()
  const summary = dialog
    ? {
        buttons: [...dialog.querySelectorAll('button')].map(b => (b.textContent || '').trim()),
      }
    : null
  const gateButton = [...document.querySelectorAll('button')].find(b => /工具门控/.test(b.textContent || ''))
  const gateStyle = gateButton ? getComputedStyle(gateButton) : null
  return {
    dialog: !!dialog,
    summary,
    gate: gateButton
      ? {
          text: (gateButton.textContent || '').trim(),
          color: gateStyle.color,
          background: gateStyle.backgroundColor,
          opacity: gateStyle.opacity,
          width: gateButton.getBoundingClientRect().width,
          height: gateButton.getBoundingClientRect().height,
        }
      : null,
  }
})()`

app.on('window-all-closed', () => app.quit())

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1440, height: 960, webPreferences: { backgroundThrottling: false } })
  try {
    await win.loadURL(url)
    const result = await win.webContents.executeJavaScript(script)
    log('state ' + JSON.stringify(result))
    await new Promise(resolve => setTimeout(resolve, 400))
    const image = await win.webContents.capturePage()
    fs.writeFileSync(output, image.toPNG())
    log('saved ' + output)
  } catch (error) {
    log('error ' + (error && error.stack ? error.stack : String(error)))
  } finally {
    app.quit()
  }
})
