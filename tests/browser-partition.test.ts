import { expect, it, vi } from 'vitest'
import { browserPartition, configureBrowserPermissions } from '../src/main/browser-permissions'
import type { Session } from 'electron'
it('keeps checkout storage stable and distinct without exposing paths', () => {
  const a = browserPartition('/projects/a')
  expect(a).toMatch(/^persist:donwells-checkout-[a-f0-9]{64}$/)
  expect(browserPartition('/projects/a')).toBe(a)
  expect(browserPartition('/projects/a-worktree')).not.toBe(a)
  expect(browserPartition('/projects/b')).not.toBe(a)
})
it('denies capabilities on each isolated browser session', () => {
  const session = { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(), setDevicePermissionHandler: vi.fn() }
  configureBrowserPermissions(session as unknown as Session)
  expect(session.setPermissionCheckHandler.mock.calls[0]![0]()).toBe(false)
  const callback = vi.fn()
  session.setPermissionRequestHandler.mock.calls[0]![0](null, 'camera', callback)
  expect(callback).toHaveBeenCalledWith(false)
  expect(session.setDevicePermissionHandler.mock.calls[0]![0]()).toBe(false)
})
