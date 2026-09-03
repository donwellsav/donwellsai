import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { useAppStore } from '../src/renderer/src/store'
import { executeUiCommand } from '../src/renderer/src/agent-ui-commands'
import type { RepoSummary } from '../src/shared/types'

const main = '/repos/demo'
const feature = '/repos/demo-feature'

function repoSummary(): RepoSummary {
  return {
    repo: { id: 'demo', path: main, addedAt: 't0' },
    worktrees: [
      { id: 'w0', path: main, branch: 'main', isMain: true },
      { id: 'w1', path: feature, branch: 'feat', isMain: false }
    ],
    defaultBranch: 'main'
  }
}

/** Reset the store slices the executor touches (no IPC-backed actions here). */
function seed(): void {
  useAppStore.setState({
    repos: [repoSummary()],
    activeRepoId: 'demo',
    activeWorktreePath: null,
    panes: { [main]: [{ key: 'term:t1', kind: 'terminal', sessionId: 't1' }] },
    activePane: { [main]: 'term:t1' },
    activeTerminal: { [main]: 't1' },
    terminalOrder: { [main]: ['t1'] },
    layouts: {},
    previews: {},
    sidebarOpen: true,
    rightSidebarOpen: false,
    rightSidebarTab: 'explorer',
    rightSidebarWidth: 320,
    sidebarWidth: 260,
    paletteOpen: false,
    settingsOpen: false,
    settingsSection: 'general',
    floatingOpen: false,
    floatingSessionId: null
  })
}

beforeAll(() => {
  // persistSessionSoon's deferred save must not explode in node
  vi.stubGlobal('window', { orca: { saveWorkspaceSession: async () => {}, closeTerminal: () => {} } })
  seed()
})

describe('executeUiCommand', () => {
  it('activate by worktree path selects repo + worktree; main path clears worktree', async () => {
    await executeUiCommand({ op: 'activate', worktreePath: feature })
    expect(useAppStore.getState().activeRepoId).toBe('demo')
    expect(useAppStore.getState().activeWorktreePath).toBe(feature)

    await executeUiCommand({ op: 'activate', worktreePath: main })
    expect(useAppStore.getState().activeWorktreePath).toBeNull()
  })

  it('activate rejects paths no repo owns', async () => {
    await expect(executeUiCommand({ op: 'activate', worktreePath: '/nope' })).rejects.toThrow('no repo owns')
  })

  it('pane.focus focuses an existing pane and rejects unknown keys', async () => {
    await executeUiCommand({ op: 'pane.focus', worktreePath: main, key: 'term:t1' })
    expect(useAppStore.getState().activePane[main]).toBe('term:t1')
    await expect(executeUiCommand({ op: 'pane.focus', worktreePath: main, key: 'preview:x' })).rejects.toThrow('no pane')
  })

  it('pane.close removes the pane', async () => {
    await executeUiCommand({ op: 'pane.close', worktreePath: main, key: 'term:t1' })
    expect(useAppStore.getState().panes[main]).toHaveLength(0)
  })

  it('pane.resize clamps to the 15-85 band', async () => {
    useAppStore.setState({
      layouts: { [main]: { kind: 'split', dir: 'row', first: { kind: 'leaf', pane: 'term:t1' }, second: { kind: 'leaf', pane: 'browser:tab' } } }
    })
    await executeUiCommand({ op: 'pane.resize', worktreePath: main, splitId: 0, pct: 5 })
    expect(useAppStore.getState().layouts[main]?.size).toBe(15)
    await executeUiCommand({ op: 'pane.resize', worktreePath: main, splitId: 0, pct: 99 })
    expect(useAppStore.getState().layouts[main]?.size).toBe(85)
  })

  it('sidebar left toggles; right opens with tab and width', async () => {
    await executeUiCommand({ op: 'sidebar', side: 'left', open: 'toggle' })
    expect(useAppStore.getState().sidebarOpen).toBe(false)
    await executeUiCommand({ op: 'sidebar', side: 'right', open: true, tab: 'git', width: 400 })
    const rs = useAppStore.getState()
    expect(rs.rightSidebarOpen).toBe(true)
    expect(rs.rightSidebarTab).toBe('git')
    expect(rs.rightSidebarWidth).toBe(400)
  })

  it('palette toggles open and closed', async () => {
    await executeUiCommand({ op: 'palette' })
    expect(useAppStore.getState().paletteOpen).toBe(true)
    await executeUiCommand({ op: 'palette' })
    expect(useAppStore.getState().paletteOpen).toBe(false)
  })

  it('settings.open deep-links a section', async () => {
    await executeUiCommand({ op: 'settings.open', section: 'terminal' })
    const s = useAppStore.getState()
    expect(s.settingsOpen).toBe(true)
    expect(s.settingsSection).toBe('terminal')
  })

  it('preview.close drops preview panes and prunes their layout leaves', async () => {
    useAppStore.setState({
      panes: { [main]: [{ key: 'term:t1', kind: 'terminal', sessionId: 't1' }, { key: 'preview:README.md', kind: 'preview', file: 'README.md' }] },
      layouts: { [main]: { kind: 'split', dir: 'row', first: { kind: 'leaf', pane: 'term:t1' }, second: { kind: 'leaf', pane: 'preview:README.md' } } }
    })
    await executeUiCommand({ op: 'preview.close', worktreePath: main })
    const s = useAppStore.getState()
    expect(s.panes[main]?.map((p) => p.key)).toEqual(['term:t1'])
    // invariant: layout leaves ⊆ live panes — a dangling leaf renders a dead slab
    expect(s.layouts[main]).toEqual({ kind: 'leaf', pane: 'term:t1' })
  })

  it('state returns a serializable control snapshot', async () => {
    const state = (await executeUiCommand({ op: 'state' })) as Record<string, unknown>
    expect(state['activeRepoId']).toBe('demo')
    expect(state['panes']).toBeTruthy()
    expect(state['rightSidebar']).toBeTruthy()
    expect(JSON.parse(JSON.stringify(state))).toBeTruthy()
  })
})
