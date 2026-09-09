import { Menu, Tray, app, nativeImage, BrowserWindow } from 'electron'
import type { AttentionState } from '@shared/types'

/**
 * System tray presence. The indicator reflects a current agent state that needs
 * attention; native window flashing is governed independently.
 */

function trayIcon(attention: boolean): Electron.NativeImage {
  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  const r = 6.2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - size / 2 + 0.5
      const dy = y - size / 2 + 0.5
      const dist = Math.sqrt(dx * dx + dy * dy)
      let a = 0
      let cr = 0
      let cg = 0
      let cb = 0
      if (attention) {
        // filled amber disc
        if (dist <= r) {
          a = 255
          cr = 250
          cg = 204
          cb = 21
        }
      } else if (Math.abs(dist - r) <= 0.75) {
        // hollow grey ring
        a = 230
        cr = 229
        cg = 229
        cb = 229
      }
      const i = (y * size + x) * 4
      buf[i] = cb // B
      buf[i + 1] = cg // G
      buf[i + 2] = cr // R
      buf[i + 3] = a // A
    }
  }
  const img = nativeImage.createFromBitmap(buf, { width: size, height: size })
  img.setTemplateImage(!attention)
  return img
}

export class TrayService {
  private tray: Tray | null = null
  private indicator = false
  private flash = false

  start(onShow: () => void): void {
    this.tray = new Tray(trayIcon(this.indicator))
    this.tray.setToolTip('donwells.ai')
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open donwells.ai', click: () => onShow() },
        { type: 'separator' },
        {
          label: 'Quit',
          click: () => {
            app.quit()
          }
        }
      ])
    )
    this.tray.on('click', () => onShow())
  }

  setAttention(state: AttentionState): void {
    if (this.indicator !== state.indicator) {
      this.indicator = state.indicator
      this.tray?.setImage(trayIcon(state.indicator))
      if (process.platform === 'darwin') app.dock?.setBadge(state.indicator ? '•' : '')
    }

    const beginFlash = state.flash && !this.flash
    const endFlash = !state.flash && this.flash
    this.flash = state.flash
    if (!beginFlash && !endFlash) return
    for (const window of BrowserWindow.getAllWindows()) {
      if (beginFlash) {
        if (!window.isFocused()) window.flashFrame(true)
      } else {
        window.flashFrame(false)
      }
    }
  }

  stop(): void {
    this.tray?.destroy()
    this.tray = null
  }
}
