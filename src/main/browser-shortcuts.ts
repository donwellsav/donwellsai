import { app, type WebContents } from 'electron'
import type { BrowserShortcutAction } from '@shared/types'

export function registerBrowserShortcuts(owner: () => WebContents | null): void {
  app.on('web-contents-created', (_event, guest) => {
    if (guest.getType() !== 'webview') return
    guest.on('before-input-event', (event, input) => {
      const host = guest.hostWebContents
      if (!host || host !== owner() || host.isDestroyed() || input.type !== 'keyDown' || input.alt) return
      const modifier = process.platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
      if (!modifier) return
      const key = input.key.toLowerCase()
      let action: BrowserShortcutAction | undefined
      if (!input.shift && key === 'l') action = 'focusAddress'
      else if (!input.shift && key === 'f') action = 'find'
      else if (key === '+' || key === '=') action = 'zoomIn'
      else if (!input.shift && key === '-') action = 'zoomOut'
      else if (!input.shift && key === '0') action = 'zoomReset'
      if (!action) return
      event.preventDefault()
      host.send('browser:shortcut', { action, guestId: guest.id })
    })
  })
}
