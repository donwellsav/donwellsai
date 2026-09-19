import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

const updater = vi.hoisted(() => ({ value: null as EventEmitter | null }))
vi.mock('electron-updater', () => ({ autoUpdater: updater.value }))

it('delivers update events to the replacement window exactly once', async () => {
  updater.value = new EventEmitter()
  const { initAutoUpdater } = await import('./auto-updater')
  const firstSend = vi.fn()
  const replacementSend = vi.fn()
  const first = { isDestroyed: () => true, webContents: { send: firstSend } }
  const replacement = { isDestroyed: () => false, webContents: { send: replacementSend } }
  initAutoUpdater(first as unknown as Electron.BrowserWindow)
  initAutoUpdater(replacement as unknown as Electron.BrowserWindow)
  updater.value.emit('update-downloaded', { version: '9.9.9' })
  expect(firstSend).not.toHaveBeenCalled()
  expect(replacementSend).toHaveBeenCalledExactlyOnceWith('autoUpdater:update-downloaded', { version: '9.9.9' })
})
