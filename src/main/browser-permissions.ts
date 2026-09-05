import type { BrowserWindow, Session } from 'electron'

export const BROWSER_PARTITION = 'persist:donwells-browser'

function allowedNavigation(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

export function configureBrowserPermissions(browserSession: Session): void {
  // No browser capability is supported without an explicit app-level approval flow.
  browserSession.setPermissionCheckHandler(() => false)
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  browserSession.setDevicePermissionHandler(() => false)
}

export function guardBrowserGuests(window: BrowserWindow): void {
  window.webContents.on('will-attach-webview', (event, preferences, params) => {
    if (params.partition !== BROWSER_PARTITION || !allowedNavigation(params.src)) {
      event.preventDefault()
      return
    }
    delete preferences.preload
    preferences.nodeIntegration = false
    preferences.nodeIntegrationInSubFrames = false
    preferences.contextIsolation = true
    preferences.sandbox = true
  })
  window.webContents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler(() => ({ action: 'deny' }))
    guest.on('will-navigate', (event, url) => {
      if (!allowedNavigation(url)) event.preventDefault()
    })
    guest.on('will-redirect', (event, url) => {
      if (!allowedNavigation(url)) event.preventDefault()
    })
  })
}
