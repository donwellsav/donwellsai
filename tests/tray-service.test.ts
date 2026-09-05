import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TrayService } from '../src/main/tray-service'

const electron = vi.hoisted(() => ({
  tray: {
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
    setImage: vi.fn(),
    on: vi.fn(),
    destroy: vi.fn()
  },
  setBadge: vi.fn(),
  focusedWindow: { isFocused: vi.fn(() => true), flashFrame: vi.fn() },
  backgroundWindow: { isFocused: vi.fn(() => false), flashFrame: vi.fn() }
}))

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: vi.fn(() => ({})) },
  Tray: vi.fn(function MockTray() { return electron.tray }),
  app: { dock: { setBadge: electron.setBadge }, quit: vi.fn() },
  nativeImage: {
    createFromBitmap: vi.fn(() => ({ setTemplateImage: vi.fn() }))
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [electron.focusedWindow, electron.backgroundWindow])
  }
}))

beforeEach(() => {
  vi.clearAllMocks()
  electron.focusedWindow.isFocused.mockReturnValue(true)
  electron.backgroundWindow.isFocused.mockReturnValue(false)
})

describe('native agent attention', () => {
  it('updates the indicator independently and only flashes an unfocused window on entry', () => {
    const service = new TrayService()
    service.start(() => {})

    service.setAttention({ indicator: true, flash: false })
    expect(electron.tray.setImage).toHaveBeenCalledTimes(1)
    expect(electron.focusedWindow.flashFrame).not.toHaveBeenCalled()
    expect(electron.backgroundWindow.flashFrame).not.toHaveBeenCalled()

    service.setAttention({ indicator: true, flash: true })
    expect(electron.focusedWindow.flashFrame).not.toHaveBeenCalled()
    expect(electron.backgroundWindow.flashFrame).toHaveBeenCalledOnce()
    expect(electron.backgroundWindow.flashFrame).toHaveBeenLastCalledWith(true)

    service.setAttention({ indicator: false, flash: true })
    expect(electron.tray.setImage).toHaveBeenCalledTimes(2)
    expect(electron.backgroundWindow.flashFrame).toHaveBeenCalledOnce()

    service.setAttention({ indicator: false, flash: false })
    expect(electron.focusedWindow.flashFrame).toHaveBeenCalledWith(false)
    expect(electron.backgroundWindow.flashFrame).toHaveBeenLastCalledWith(false)
  })
})
