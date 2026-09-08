import { afterEach, expect, it, vi } from 'vitest'
const { state } = vi.hoisted(() => ({ state: { runsOpen: false, settingsOpen: false, paletteOpen: false, rightSidebarOpen: false, rightSidebarTab: 'explorer' } }))
vi.mock('../src/renderer/src/store', () => ({ useAppStore: { getState: () => state }, persistSessionSoon: vi.fn() }))
import { focusPaneTarget } from '../src/renderer/src/navigation-controller'
afterEach(() => { vi.unstubAllGlobals(); state.rightSidebarOpen = false; state.runsOpen = false })
it('discards queued terminal focus when a tool opens before the animation frames finish', () => {
  const frames: FrameRequestCallback[] = []
  const query = vi.fn(() => null)
  vi.stubGlobal('document', { querySelector: query })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  focusPaneTarget({ kind: 'terminal', repoId: 'project', worktreePath: '/project', paneKey: 'session', sessionId: 'session' })
  state.rightSidebarOpen = true
  frames.shift()!(0); frames.shift()!(0)
  // The overlay check is allowed, but no stale pane or navigation lookup may occur.
  expect(query.mock.calls).toEqual([['dialog[open]']])
})
it('resolves false when an overlay blocks the focus handoff', async () => {
  const frames: FrameRequestCallback[] = []
  const query = vi.fn(() => null)
  vi.stubGlobal('document', { querySelector: query })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  state.runsOpen = true
  const result = focusPaneTarget({ kind: 'workspace', repoId: 'project', worktreePath: '/project' })
  frames.shift()!(0); frames.shift()!(0)
  await expect(result).resolves.toBe(false)
})
