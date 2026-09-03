import { Menu, Tray, app, nativeImage, BrowserWindow } from 'electron'

/**
 * System tray (upstream orcad tray): lightweight presence when the window is
 * closed; an amber dot marks unread agent activity (attention icon), mirrored
 * to the Dock badge on macOS.
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
  private attention = false

  start(onShow: () => void): void {
    this.tray = new Tray(trayIcon(false))
    this.tray.setToolTip('donwells.ai')
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open donwells.ai', click: () => onShow() },
        { type: 'separator' },
        {
          label: 'Quit',
          click: () => {
            this.stop()
            app.quit()
          }
        }
      ])
    )
    this.tray.on('click', () => onShow())
  }

  setAttention(on: boolean): void {
    if (this.attention === on) return
    this.attention = on
    this.tray?.setImage(trayIcon(on))
    if (process.platform === 'darwin') app.dock?.setBadge(on ? '•' : '')
    for (const w of BrowserWindow.getAllWindows()) {
      if (on) w.flashFrame(true)
      else w.flashFrame(false)
    }
  }

  stop(): void {
    this.tray?.destroy()
    this.tray = null
  }
}
