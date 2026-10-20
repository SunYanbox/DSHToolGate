// Verifies the hover preview keeps a FIXED height (no dialog jump) and scrolls
// internally. Run with:
//   $env:ELECTRON_RUN_AS_NODE=$null  (remove it)
//   <electron.exe> --no-sandbox --disable-gpu test/e2e-fixed-preview.cjs <url>
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const url = process.argv.filter(a => /^https?:\/\//.test(a)).pop()
const logFile = path.join(__dirname, 'fixed-preview.log')
const shotFile = path.join(__dirname, 'fixed-preview.png')
const log = (...parts) => fs.appendFileSync(logFile, parts.join(' ') + '\n')
fs.writeFileSync(logFile, 'url=' + url + '\n')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

app.commandLine.appendSwitch('disable-gpu')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 900, show: true })
  win.webContents.on('console-message', (_event, _level, message) => log('[page]', message))
  await win.loadURL(url)
  await wait(3500)
  const findText = (text) => `
    (() => {
      const all = [...document.querySelectorAll('button')]
      const hit = all.find(b => (b.textContent || '').includes(${JSON.stringify(text)}))
      if (!hit) return 'not-found:' + all.map(b => b.textContent).join('|')
      hit.click()
      return 'clicked'
    })()`
  log('open:', await win.webContents.executeJavaScript(findText('工具门控')))
  await wait(1200)

  const measure = async (chipText) => {
    const script = `(() => {
      const dialog = document.querySelector('[role="dialog"][aria-label="本会话启用的插件工具"]')
      if (!dialog) return { error: 'no dialog' }
      let chip = null
      if (${JSON.stringify(chipText)}) {
        const node = [...dialog.querySelectorAll('*')].find(n => n.children.length === 0 && (n.textContent || '').includes(${JSON.stringify(chipText)}))
        chip = node ? (node.closest('div') || node) : null
      }
      if (chip) chip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      const rect = dialog.getBoundingClientRect()
      const preview = [...dialog.querySelectorAll('div')].find(d => (d.textContent || '').startsWith('把鼠标移到插件标签上') || /将注册：/.test((d.textContent || '').slice(0, 40)))
      const box = preview ? { client: preview.clientHeight, scroll: preview.scrollHeight } : null
      return { height: Math.round(rect.height), top: Math.round(rect.top), box }
    })()`
    const value = await win.webContents.executeJavaScript(script)
    await wait(350)
    const after = await win.webContents.executeJavaScript('(() => { const d = document.querySelector(\'[role="dialog"][aria-label="本会话启用的插件工具"]\'); return d ? Math.round(d.getBoundingClientRect().height) : -1 })()')
    return { ...value, afterHoverHeight: after }
  }

  log('idle:', JSON.stringify(await measure(null)))
  log('short:', JSON.stringify(await measure('tool-worktree')))
  log('long:', JSON.stringify(await measure('tool-browser')))

  const image = await win.webContents.capturePage()
  fs.writeFileSync(shotFile, image.toPNG())
  log('saved', shotFile)
  win.destroy()
  app.exit(0)
}).catch(error => {
  log('fatal', error && error.stack ? error.stack : String(error))
  app.exit(1)
})
