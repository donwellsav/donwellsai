import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { VersionedEditorSave } from '../src/renderer/src/editor-save'
import { cacheEditorDocument, disposePreviewModel, type EditorModel } from '../src/renderer/src/editor-models'
import { useAppStore, flushWorkspaceSession } from '../src/renderer/src/store'
import { executeUiCommand } from '../src/renderer/src/agent-ui-commands'
import type { FileContent, PersistedState, RepoSummary, RunningAgent, TerminalSession } from '../src/shared/types'

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

function file(path: string, content: string, revision: string): FileContent {
  return { path, content, revision, bytes: Buffer.byteLength(content), truncated: false }
}

function disposableModel(): EditorModel {
  const model: EditorModel = Object.create(null)
  model.dispose = vi.fn()
  return model
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
    terminals: {},
    runningAgents: {},
    previews: {},
    sidebarOpen: true,
    rightSidebarOpen: false,
    rightSidebarTab: 'explorer',
    rightSidebarWidth: 320,
    sidebarWidth: 260,
    paletteOpen: false,
    settingsOpen: false,
    settingsSection: 'agents',
    runsOpen: false,
  })
}

beforeEach(() => {
  // persistSessionSoon's deferred save must not explode in node
  vi.stubGlobal('window', { donwells: { getWorkspaceSession: async () => null, saveWorkspaceSession: async () => {}, closeTerminal: () => {} } })
  seed()
})
afterEach(async () => {
  await flushWorkspaceSession()
  vi.unstubAllGlobals()
})

describe('executeUiCommand', () => {
  it('activate by worktree path selects the requested workspace, including main', async () => {
    await executeUiCommand({ op: 'activate', worktreePath: feature })
    expect(useAppStore.getState().activeRepoId).toBe('demo')
    expect(useAppStore.getState().activeWorktreePath).toBe(feature)

    await expect(executeUiCommand({ op: 'activate', worktreePath: main })).resolves.toEqual({ activeRepoId: 'demo', activeWorktreePath: main })
    expect(useAppStore.getState().activeWorktreePath).toBe(main)
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

  it('keeps a live terminal open until the explicit close confirmation', async () => {
    let closes = 0
    vi.stubGlobal('window', {
      donwells: {
        saveWorkspaceSession: async () => {},
        closeTerminal: async () => { closes++ }
      }
    })
    useAppStore.setState({
      terminals: {
        t1: {
          session: { id: 't1', worktreePath: main, title: 'zsh', createdAt: '2026-09-04T10:00:00.000Z', exited: false },
          cols: 100,
          rows: 30
        }
      }
    })

    useAppStore.getState().requestClosePane(main, 'term:t1')
    expect(closes).toBe(0)
    expect(useAppStore.getState().closeRequest?.sessionId).toBe('t1')
    expect(useAppStore.getState().panes[main]).toHaveLength(1)

    await useAppStore.getState().confirmClosePane()
    expect(closes).toBe(1)
    expect(useAppStore.getState().closeRequest).toBeNull()
    expect(useAppStore.getState().panes[main]).toHaveLength(0)
  })

  it('pane.resize returns the applied clamp and rejects an unknown split', async () => {
    useAppStore.setState({
      layouts: { [main]: { kind: 'split', dir: 'row', first: { kind: 'leaf', pane: 'term:t1' }, second: { kind: 'leaf', pane: 'browser:tab' } } }
    })
    await expect(executeUiCommand({ op: 'pane.resize', worktreePath: main, splitId: 0, pct: 5 })).resolves.toEqual({ pct: 15 })
    const firstResize = useAppStore.getState().layouts[main]
    if (firstResize?.kind !== 'split') throw new Error('expected split layout')
    expect(firstResize.size).toBe(15)
    await expect(executeUiCommand({ op: 'pane.resize', worktreePath: main, splitId: 0, pct: 99 })).resolves.toEqual({ pct: 85 })
    const secondResize = useAppStore.getState().layouts[main]
    if (secondResize?.kind !== 'split') throw new Error('expected split layout')
    expect(secondResize.size).toBe(85)
    await expect(executeUiCommand({ op: 'pane.resize', worktreePath: main, splitId: 4, pct: 50 })).rejects.toThrow('No split 4')
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


  it('preview and editor open reject when the requested file cannot be loaded', async () => {
    const readFile = vi.fn(async () => { throw new Error('missing file') })
    vi.stubGlobal('window', { donwells: {
      getWorkspaceSession: async () => null,
      saveWorkspaceSession: async () => {},
      closeTerminal: () => {},
      readFile
    } })

    await expect(executeUiCommand({ op: 'preview.open', worktreePath: main, relPath: 'missing.txt' })).rejects.toThrow('missing file')
    await expect(executeUiCommand({ op: 'editor.open', worktreePath: main, relPath: 'missing.txt' })).rejects.toThrow('missing file')
    expect(readFile).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().previews[main]?.['missing.txt']).toBeUndefined()
  })

  it('split returns the created terminal and rejects before opening without an active pane', async () => {
    const session: TerminalSession = {
      id: 't2', worktreePath: main, title: 'zsh', createdAt: '2026-09-04T10:00:00.000Z', exited: false
    }
    const openTerminal = vi.fn(async () => session)
    vi.stubGlobal('window', { donwells: {
      getWorkspaceSession: async () => null,
      saveWorkspaceSession: async () => {},
      closeTerminal: () => {},
      openTerminal
    } })

    await expect(executeUiCommand({ op: 'split', worktreePath: main })).resolves.toEqual({ key: 'term:t2', sessionId: 't2' })
    expect(useAppStore.getState().layouts[main]).toEqual({
      kind: 'split', dir: 'row', first: { kind: 'leaf', pane: 'term:t1' }, second: { kind: 'leaf', pane: 'term:t2' }
    })

    useAppStore.setState({ panes: { [main]: [] }, activePane: { [main]: '' }, layouts: {} })
    await expect(executeUiCommand({ op: 'split', worktreePath: main })).rejects.toThrow('Select a pane before splitting')
    expect(openTerminal).toHaveBeenCalledTimes(1)
  })

  it('editor.write rejects a dirty model before any backend write', async () => {
    const relPath = 'dirty.txt'
    const backendWrite = vi.fn(async () => file(relPath, 'agent', 'r2'))
    vi.stubGlobal('window', { donwells: {
      getWorkspaceSession: async () => null,
      saveWorkspaceSession: async () => {},
      closeTerminal: () => {},
      writeFile: backendWrite
    } })
    const save = new VersionedEditorSave({
      initial: file(relPath, 'base', 'r1'),
      sourceEpoch: 1,
      write: async () => file(relPath, 'local', 'r2')
    })
    cacheEditorDocument(main, relPath, { model: disposableModel(), save })
    save.edit('irreplaceable local edit', 2)
    try {
      await expect(executeUiCommand({ op: 'editor.write', worktreePath: main, relPath, content: 'agent' })).rejects.toThrow('unsaved editor changes')
      expect(backendWrite).not.toHaveBeenCalled()
    } finally {
      save.reload(file(relPath, 'base', 'r1'), 2)
      disposePreviewModel(main, relPath)
    }
  })

  it('editor.write guards disk replacement with the observed revision', async () => {
    const relPath = 'guarded.txt'
    const writeFile = vi.fn(async (_workspacePath: string, path: string, content: string) => file(path, content, 'r2'))
    const readFile = vi.fn(async () => { throw new Error('should use the loaded revision') })
    vi.stubGlobal('window', { donwells: {
      getWorkspaceSession: async () => null,
      saveWorkspaceSession: async () => {},
      closeTerminal: () => {},
      readFile,
      writeFile
    } })
    useAppStore.setState({ previews: { [main]: { [relPath]: { ...file(relPath, 'base', 'r1'), v: 0, mode: 'edit' } } } })

    await expect(executeUiCommand({ op: 'editor.write', worktreePath: main, relPath, content: 'agent' })).resolves.toEqual({ bytes: 5 })
    expect(writeFile).toHaveBeenCalledWith(main, relPath, 'agent', 'r1')
    expect(readFile).not.toHaveBeenCalled()
    expect(useAppStore.getState().previews[main]?.[relPath]).toMatchObject({ content: 'agent', revision: 'r2' })
  })
})

describe('native agent state', () => {
  it('starts through the runtime and reconstructs a missing live agent pane after restart', async () => {
    const session: TerminalSession = {
      id: 't1',
      worktreePath: main,
      title: 'codex',
      createdAt: '2026-09-04T10:00:00.000Z',
      exited: false
    }
    const run: RunningAgent = {
      id: 'run-1',
      sessionId: session.id,
      workspacePath: main,
      command: 'codex',
      presetId: 'codex',
      startedAt: session.createdAt,
      updatedAt: '2026-09-04T10:01:00.000Z',
      liveness: 'live',
      activity: 'permission',
      detail: 'Waiting for approval',
      hook: {
        support: 'native',
        adapter: 'codex-hooks',
        documentationUrl: 'https://developers.openai.com/codex/hooks',
        events: ['working', 'waiting', 'permission', 'completed'],
        connected: true,
        lastEventAt: '2026-09-04T10:01:00.000Z'
      }
    }
    let savedSession: PersistedState['workspaceSession']
    let directTerminalWrites = 0
    vi.stubGlobal('window', {
      donwells: {
        saveWorkspaceSession: async (value: NonNullable<PersistedState['workspaceSession']>) => { savedSession = value },
        closeTerminal: async () => true,
        agentStart: async () => ({ run, session }),
        terminalWrite: async () => { directTerminalWrites++; return true }
      }
    })

    await useAppStore.getState().runAgent(main, 'codex')
    expect(useAppStore.getState().runningAgents.t1).toEqual(run)
    expect(directTerminalWrites).toBe(0)

    await flushWorkspaceSession()
    expect(savedSession).not.toHaveProperty('runningAgents')

    useAppStore.setState({ runningAgents: {}, panes: {}, activePane: {}, terminalOrder: {}, terminals: {}, layouts: {} })
    vi.stubGlobal('window', {
      donwells: {
        saveWorkspaceSession: async () => {},
        closeTerminal: async () => true,
        listRepos: async () => [repoSummary()],
        listAgents: async () => [],
        agentList: async () => [run],
        getSettings: async () => useAppStore.getState().settings,
        getWorkspaceSession: async () => ({
          activeRepoId: 'demo',
          repos: {
            demo: {
              panes: { [main]: [] },
              activePane: {},
              activeTerminal: {},
              terminalOrder: { [main]: [] },
              layouts: {},
              activeWorktreePath: main
            }
          }
        }),
        terminalSessions: async () => [session],
        openTerminal: async () => { throw new Error('not expected') },
        loadExplorer: async () => {},
        gitStatus: async () => null,
        scanWorktree: async () => ({ ports: [], cpuPercent: 0, memMB: 0 }),
        attachTerminal: async () => null
      }
    })

    await useAppStore.getState().load()
    const restored = useAppStore.getState()
    expect({
      error: restored.error,
      run: restored.runningAgents.t1,
      panes: restored.panes[main]?.map((pane) => pane.key),
      activePane: restored.activePane[main]
    }).toEqual({ error: null, run, panes: ['term:t1'], activePane: 'term:t1' })
  })

  it('retains exited agent output until explicit dismissal', async () => {
    const session: TerminalSession = { id: 't1', worktreePath: main, title: 'node', createdAt: 't0', exited: false }
    const run: RunningAgent = {
      id: 'finished-run', sessionId: session.id, workspacePath: main, command: 'node',
      startedAt: 't0', updatedAt: 't1', liveness: 'exited', activity: 'failed', exitCode: 143,
      hook: { support: 'unavailable', events: [], reason: 'Local fixture', connected: false }
    }
    const confirmation = Promise.withResolvers<void>()
    vi.stubGlobal('window', { donwells: {
      saveWorkspaceSession: async () => {},
      agentDismiss: () => confirmation.promise
    } })
    useAppStore.setState({
      terminals: { t1: { session, cols: 100, rows: 30 } },
      runningAgents: { t1: run }
    })

    useAppStore.getState().applyTerminalExit(session.id, 143)
    expect(useAppStore.getState().panes[main]?.map(pane => pane.key)).toEqual(['term:t1'])
    expect(useAppStore.getState().terminals.t1?.session.exited).toBe(true)

    const closing = useAppStore.getState().closePane(main, 'term:t1')
    expect(useAppStore.getState().panes[main]?.map(pane => pane.key)).toEqual(['term:t1'])
    confirmation.resolve()
    await expect(closing).resolves.toBe(true)
    expect(useAppStore.getState().panes[main]).toBeUndefined()
    expect(useAppStore.getState().terminals.t1).toBeUndefined()
    expect(useAppStore.getState().runningAgents.t1).toBeUndefined()
  })
  it('opens a CLI-created retained session without starting another process', async () => {
    const session: TerminalSession = { id: 'cli-agent', worktreePath: feature, title: 'node', createdAt: 't0', exited: true }
    const run: RunningAgent = {
      id: 'cli-run', sessionId: session.id, workspacePath: feature, command: 'node',
      startedAt: 't0', updatedAt: 't1', liveness: 'exited', activity: 'completed', exitCode: 0,
      hook: { support: 'unavailable', events: [], reason: 'Local fixture', connected: false }
    }
    vi.stubGlobal('window', { donwells: {
      saveWorkspaceSession: async () => {},
      terminalSessions: async () => [session],
      agentList: async () => [run],
      openTerminal: () => { throw new Error('must not start a replacement terminal') }
    } })
    useAppStore.setState({ panes: {}, terminals: {}, runsOpen: true })
    await expect(useAppStore.getState().focusAgentSession(session.id)).resolves.toBe(true)
    const focused = useAppStore.getState()
    expect(focused.activeRepoId).toBe('demo')
    expect(focused.activeWorktreePath).toBe(feature)
    expect(focused.activePane[feature]).toBe('term:cli-agent')
    expect(focused.panes[feature]).toHaveLength(1)
    expect(focused.runsOpen).toBe(false)
    await focused.focusAgentSession(session.id)
    expect(useAppStore.getState().panes[feature]).toHaveLength(1)

    const pending = Promise.withResolvers<TerminalSession[]>()
    window.donwells.terminalSessions = () => pending.promise
    const opening = useAppStore.getState().focusAgentSession(session.id)
    useAppStore.setState({ repos: [], panes: {}, terminals: {} })
    pending.resolve([session])
    await expect(opening).resolves.toBe(false)
    expect(useAppStore.getState().panes).toEqual({})
  })
})