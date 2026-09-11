import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron-updater before importing the module
vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    checkForUpdates: vi.fn().mockResolvedValue(undefined),
    downloadUpdate: vi.fn().mockResolvedValue(undefined),
    quitAndInstall: vi.fn(),
    on: vi.fn(),
  },
}))

describe('auto-updater', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('exports all required functions', async () => {
    const mod = await import('../src/main/auto-updater')
    expect(typeof mod.initAutoUpdater).toBe('function')
    expect(typeof mod.checkForUpdates).toBe('function')
    expect(typeof mod.downloadUpdate).toBe('function')
    expect(typeof mod.quitAndInstall).toBe('function')
  })

  it('checkForUpdates returns false when not initialized', async () => {
    const { checkForUpdates } = await import('../src/main/auto-updater')
    const result = await checkForUpdates()
    expect(result).toBe(false)
  })
})
