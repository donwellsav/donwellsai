import { expect, it, vi } from 'vitest'

it('restores authored state after renderer replacement and retains deletion without writing profile files', async () => {
  const main = new Map<string, string>()
  vi.stubGlobal('window', { donwells: {
    guiDraftsWrite: async (name: string, text: string) => { main.set(name, text) },
    guiDraftsRead: async () => [...main]
  } })
  try {
    const first = await import('../src/renderer/src/gui-drafts')
    const drafts = first.guiDraftMap<{ text: string; destination: string }>('recovery-test')
    drafts.set('project-a', { text: 'unsent note', destination: 'session-a' })
    drafts.set('project-b', { text: 'other note', destination: 'session-b' })
    vi.resetModules()
    const replacement = await import('../src/renderer/src/gui-drafts')
    const restored = replacement.guiDraftMap<{ text: string; destination: string }>('recovery-test')
    await replacement.restoreGuiDrafts()
    expect(restored.get('project-a')).toEqual({ text: 'unsent note', destination: 'session-a' })
    expect(restored.get('project-b')?.destination).toBe('session-b')
    restored.delete('project-a')
    expect(JSON.parse(main.get('recovery-test')!)).toEqual([['project-b', { text: 'other note', destination: 'session-b' }]])
  } finally { vi.unstubAllGlobals(); vi.resetModules() }
})
