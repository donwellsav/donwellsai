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

describe('agent chip durability', () => {
  it('running agents persist into the workspace session and restore with their live PTYs only', async () => {
    const live = [
      { id: 't1', worktreePath: main, title: 'zsh', createdAt: 'a', exited: false },
      { id: 't2', worktreePath: main, title: 'zsh', createdAt: 'b', exited: false }
    ]
    let savedSession: unknown = null
    vi.stubGlobal('window', {
      orca: {
        saveWorkspaceSession: async (ws: unknown) => { savedSession = ws },
        closeTerminal: () => {},
        // round-trip through the real actions so persistence is the byproduct
        openTerminal: async (cwd: string) => ({ id: 't1', worktreePath: cwd, title: 'zsh', createdAt: 'a', exited: false }),
        terminalWrite: async () => true
      }
    })

    await useAppStore.getState().runAgent(main, 'codex')
    expect(useAppStore.getState().runningAgents['t1']?.state).toBe('working')

    // debounced persist
    await new Promise((r) => setTimeout(r, 450))
    const saved = savedSession as { runningAgents?: Record<string, unknown> } | null
    expect(saved?.runningAgents?.['t1']).toBeTruthy()

    // Restart: daemon still owns t1 and t2; the saved session also claims a
    // chip for session "ghost" (no live PTY) and a pane for "t2".
    useAppStore.setState({ runningAgents: {}, panes: {}, activePane: {}, terminalOrder: {}, terminals: {}, layouts: {} })
    vi.stubGlobal('window', {
      orca: {
        saveWorkspaceSession: async () => {},
        closeTerminal: () => {},
        listRepos: async () => [repoSummary()],
        listAgents: async () => [],
        getSettings: async () => ({ agentCommand: 'codex', theme: 'dark', fontSize: 13, statusPollMs: 5000 }),
        getWorkspaceSession: async () => ({
          activeRepoId: 'demo',
          runningAgents: {
            t1: { sessionId: 't1', worktreePath: main, agent: 'codex', startedAt: 'a', state: 'permission' as const },
            ghost: { sessionId: 'ghost', worktreePath: main, agent: 'codex', startedAt: 'a', state: 'working' as const }
          },
          repos: {
            demo: {
              panes: { [main]: [{ key: 'term:t1', kind: 'terminal', sessionId: 't1' }, { key: 'term:t2', kind: 'terminal', sessionId: 't2' }] },
              activePane: { [main]: 'term:t1' },
              activeTerminal: { [main]: 't1' },
              terminalOrder: { [main]: ['t1', 't2'] },
              layouts: {},
              activeWorktreePath: main
            }
          }
        }),
        terminalSessions: async () => live,
        // restore-time fallback open for exited sessions — none here
        openTerminal: async () => { throw new Error('not expected') },
        loadExplorer: async () => {},
        gitStatus: async () => null,
        scanWorktree: async () => ({ ports: [], cpuPercent: 0, memMB: 0 }),
        attachTerminal: async () => null
      }
    })

    await useAppStore.getState().load()
    const chips = useAppStore.getState().runningAgents
    expect(Object.keys(chips).sort()).toEqual(['t1'])
    // hook state survives the restart (permission chip, not just "working")
    expect(chips['t1']?.state).toBe('permission')
    expect(chips['ghost']).toBeUndefined()
    // both panes restored against the live sessions
    expect(useAppStore.getState().panes[main]?.map((p) => p.key)).toEqual(['term:t1', 'term:t2'])
  })
})