import type { WebContents } from 'electron'
import type { BrowserShortcutAction } from '@shared/types'

export function registerBrowserShortcuts(guest: WebContents, owner: WebContents): void {
    guest.on('before-input-event', (event, input) => {
      const host = owner
      if (!host || host.isDestroyed() || input.type !== 'keyDown' || input.alt) return
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
      if (action === 'focusAddress' || action === 'find') host.focus()
      host.send('browser:shortcut', { action, guestId: guest.id })
    })
}
