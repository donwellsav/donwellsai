const { app, BrowserWindow } = require('electron')
const { createServer } = require('node:http')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const userData = mkdtempSync(join(tmpdir(), 'donwells-browser-webview-'))
app.setPath('userData', userData)
process.exitCode = 1

let httpServer
let window
let finished = false

function finish(code, message) {
  if (finished) return
  finished = true
  process.exitCode = code
  console.log(message)
  if (window && !window.isDestroyed()) window.destroy()
  if (httpServer) httpServer.close()
  app.quit()
}

app.on('will-quit', () => {
  rmSync(userData, { recursive: true, force: true })
})

app.whenReady().then(() => {
  httpServer = createServer((request, response) => {
    if (request.url === '/fail') {
      request.socket.destroy()
      return
    }
    const page = request.url === '/second'
      ? '<title>Second target</title><main>second target body</main>'
      : '<title>First target</title><main>first target body</main>'
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(page)
  })

  httpServer.listen(0, '127.0.0.1', async () => {
    const address = httpServer.address()
    if (!address || typeof address === 'string') {
      finish(1, 'browser-webview-smoke:fail no HTTP address')
      return
    }
    const origin = `http://127.0.0.1:${address.port}`
    const firstUrl = `${origin}/first`
    const secondUrl = `${origin}/second`
    const failUrl = `${origin}/fail`

    window = new BrowserWindow({
      show: false,
      webPreferences: {
        webviewTag: true,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    })

    window.webContents.on('page-title-updated', (_event, title) => {
      if (title.startsWith('FAIL:')) {
        finish(1, `browser-webview-smoke:fail ${title.slice(5)}`)
        return
      }
      if (!title.startsWith('PASS:')) return
      try {
        const result = JSON.parse(title.slice(5))
        const valid =
          result.partition === 'persist:donwells-browser' &&
          result.first.url === firstUrl &&
          result.first.title === 'First target' &&
          result.hidden === true &&
          result.second.url === secondUrl &&
          result.second.title === 'Second target' &&
          result.restored.url === secondUrl &&
          result.failure.includes('ERR_')
        finish(valid ? 0 : 1, valid
          ? `browser-webview-smoke:ok ${JSON.stringify(result)}`
          : `browser-webview-smoke:fail ${JSON.stringify(result)}`)
      } catch (error) {
        finish(1, `browser-webview-smoke:fail ${error instanceof Error ? error.message : String(error)}`)
      }
    })

    const html = `
      <webview
        id="guest"
        src="${firstUrl}"
        partition="persist:donwells-browser"
        style="display: none; width: 320px; height: 180px"
      ></webview>
      <script>
        const guest = document.getElementById('guest')
        const initial = new Promise((resolve, reject) => {
          guest.addEventListener('did-finish-load', resolve, { once: true })
          guest.addEventListener('did-fail-load', (event) => reject(new Error(event.errorDescription)), { once: true })
        })
        void (async () => {
          try {
            await initial
            const first = await guest.executeJavaScript('({ url: location.href, title: document.title })')
            await guest.loadURL(${JSON.stringify(secondUrl)})
            const hidden = getComputedStyle(guest).display === 'none'
            const second = await guest.executeJavaScript('({ url: location.href, title: document.title })')
            guest.style.display = 'block'
            const restored = await guest.executeJavaScript('({ url: location.href, title: document.title })')
            let failure = ''
            try {
              await guest.loadURL(${JSON.stringify(failUrl)})
            } catch (error) {
              failure = error.message
            }
            document.title = 'PASS:' + JSON.stringify({
              partition: guest.getAttribute('partition'),
              first,
              hidden,
              second,
              restored,
              failure
            })
          } catch (error) {
            document.title = 'FAIL:' + error.message
          }
        })()
      <\/script>
    `
    await window.loadURL(`data:text/html,${encodeURIComponent(html)}`)
  })

  setTimeout(() => finish(1, 'browser-webview-smoke:fail timeout'), 10_000).unref()
})
