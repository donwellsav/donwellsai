import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { commandUnavailableReason, dispatchAppCommand } from '../src/renderer/src/commands'
import type { RepoSummary } from '../src/shared/types'
import * as editorModels from '../src/renderer/src/editor-models'
import { flushWorkspaceSession, useAppStore } from '../src/renderer/src/store'

const gitRoot = '/repos/git-project'
const folderRoot = '/repos/folder-project'
const createdRoot = '/repos/wt-feature'

function gitProject(worktrees: RepoSummary['worktrees'] = [
  { id: 'git-main', path: gitRoot, branch: 'main', isMain: true }
]): RepoSummary {
  return {
    repo: { id: 'git-project', path: gitRoot, addedAt: '2026-09-05T00:00:00.000Z', kind: 'git' },
    worktrees,
    defaultBranch: 'main',
    currentBranch: 'main'
  }
}

function folderProject(): RepoSummary {
  return {
    repo: { id: 'folder-project', path: folderRoot, addedAt: '2026-09-05T00:00:00.000Z', kind: 'folder' },
    worktrees: [{ id: 'folder-main', path: folderRoot, branch: '', isMain: true }],
    defaultBranch: ''
  }
}

const createWorktree = vi.fn()
const removeRepo = vi.fn()
const openTerminal = vi.fn()

it('returns to the main checkout after removing the active worktree', async () => {
  const main = gitProject()
  seed([gitProject([...main.worktrees, { id: 'feature', path: createdRoot, branch: 'feature', isMain: false }])])
  useAppStore.setState({ activeRepoId: main.repo.id, activeWorktreePath: createdRoot })
  Object.assign(window.donwells, { removeWorktree: vi.fn(async () => main), terminalSessions: async () => [], agentList: async () => [] })
  expect(await useAppStore.getState().removeWorktree(createdRoot)).toEqual({ ok: true })
  expect(useAppStore.getState().activeWorktreePath).toBe(gitRoot)
  expect(useAppStore.getState().activeRepoId).toBe(main.repo.id)
})

function seed(repos: RepoSummary[]): void {
  useAppStore.setState({
    repos,
    activeRepoId: repos[0]?.repo.id ?? null,
    activeWorktreePath: null,
    terminals: {},
    terminalOrder: {},
    panes: {},
    layouts: {},
    activePane: {},
    activeTerminal: {},
    runningAgents: {},
    previews: {},
    gitCommitDrafts: {},
    busy: {},
    statuses: {},
    explorer: {},
    error: null
  })
}

beforeEach(() => {
  createWorktree.mockReset()
  removeRepo.mockReset()
  openTerminal.mockReset()
  openTerminal.mockResolvedValue({
    id: 'created-terminal',
    worktreePath: createdRoot,
    title: 'zsh',
    createdAt: '2026-09-05T00:00:00.000Z',
    exited: false
  })
  vi.stubGlobal('window', {
    donwells: {
      createWorktree,
      removeRepo,
      openTerminal,
      listWorkspaceDirectory: vi.fn(async () => ({ entries: [], truncated: false })),
      closeTerminal: vi.fn(async () => {}),
      getWorkspaceSession: vi.fn(async () => null),
      saveWorkspaceSession: vi.fn(async () => {})
    }
  })
})

afterEach(async () => {
  await flushWorkspaceSession()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('workspace lifecycle store actions', () => {
  it('rejects worktree creation for a folder project before calling Git', async () => {
    seed([folderProject()])

    const result = await useAppStore.getState().createWorktree('folder-project', 'feature')

    expect(result.ok).toBe(false)
    expect(createWorktree).not.toHaveBeenCalled()
  })

  it('returns creation failure without changing the selected project or workspace', async () => {
    const project = gitProject()
    seed([project])
    createWorktree.mockRejectedValueOnce(new Error('branch already exists'))

    const result = await useAppStore.getState().createWorktree('git-project', 'feature')

    expect(result).toEqual({ ok: false, error: 'branch already exists' })
    expect(useAppStore.getState().repos).toEqual([project])
    expect(useAppStore.getState().activeRepoId).toBe('git-project')
    expect(useAppStore.getState().activeWorktreePath).toBeNull()
  })

  it('creates in the explicitly selected Git project and opens the new workspace', async () => {
    const folder = folderProject()
    const project = gitProject()
    const updated = gitProject([
      ...project.worktrees,
      { id: 'git-feature', path: createdRoot, branch: 'feature', isMain: false }
    ])
    seed([folder, project])
    createWorktree.mockResolvedValueOnce(updated)

    const result = await useAppStore.getState().createWorktree('git-project', 'feature', 'main')

    expect(result).toEqual({ ok: true })
    expect(createWorktree).toHaveBeenCalledWith('git-project', { name: 'feature', branch: 'main' })
    expect(useAppStore.getState().activeRepoId).toBe('git-project')
    expect(useAppStore.getState().activeWorktreePath).toBe(createdRoot)
    expect(openTerminal).toHaveBeenCalledWith(createdRoot)
  })

  it('blocks unregistering while a project has live terminals or an unsaved commit draft', async () => {
    seed([gitProject()])
    useAppStore.setState({
      terminals: {
        terminal: {
          session: { id: 'terminal', worktreePath: gitRoot, title: 'zsh', createdAt: '2026-09-05T00:00:00.000Z', exited: false },
          cols: 100,
          rows: 30
        }
      },
      gitCommitDrafts: { [gitRoot]: 'unfinished commit message' }
    })

    const result = await useAppStore.getState().removeRepo('git-project')

    expect(result.ok).toBe(false)
    useAppStore.setState({ terminals: {} })
    expect((await useAppStore.getState().removeRepo('git-project')).ok).toBe(false)
    expect(removeRepo).not.toHaveBeenCalled()
    expect(useAppStore.getState().repos).toHaveLength(1)
  })

  it('blocks unregistering while an editor has unsaved or conflicted content', async () => {
    seed([gitProject()])
    const dirtyDocument = Object.assign(Object.create(null), {
      save: { canDispose: () => false }
    })
    vi.spyOn(editorModels, 'getEditorDocument').mockReturnValue(dirtyDocument)
    useAppStore.setState({
      previews: {
        [gitRoot]: {
          'notes.md': { path: 'notes.md', content: 'draft', bytes: 5, truncated: false, revision: 'r1', v: 1 }
        }
      }
    })

    const result = await useAppStore.getState().removeRepo('git-project')

    expect(result.ok).toBe(false)
    expect(removeRepo).not.toHaveBeenCalled()
  })

  it('blocks unregistering while an agent is live or unreconciled', async () => {
    seed([gitProject()])
    useAppStore.setState({
      runningAgents: {
        agent: {
          id: 'agent',
          sessionId: 'agent-terminal',
          workspacePath: gitRoot,
          command: 'codex',
          startedAt: '2026-09-05T00:00:00.000Z',
          updatedAt: '2026-09-05T00:00:01.000Z',
          liveness: 'unverifiable',
          activity: 'working',
          hook: {
            support: 'unavailable',
            events: [],
            reason: 'No adapter',
            connected: false
          }
        }
      }
    })

    const result = await useAppStore.getState().removeRepo('git-project')

    expect(result.ok).toBe(false)
    expect(removeRepo).not.toHaveBeenCalled()
  })

  it('keeps a project registered when backend unregistering fails', async () => {
    const project = gitProject()
    seed([project])
    removeRepo.mockRejectedValueOnce(new Error('profile is read-only'))

    const result = await useAppStore.getState().removeRepo('git-project')

    expect(result).toEqual({ ok: false, error: 'profile is read-only' })
    expect(useAppStore.getState().repos).toEqual([project])
    expect(useAppStore.getState().activeRepoId).toBe('git-project')
  })

  it('unregisters a quiet project and selects the next registered project', async () => {
    const nextProject = folderProject()
    seed([gitProject(), nextProject])
    removeRepo.mockResolvedValueOnce(undefined)

    const result = await useAppStore.getState().removeRepo('git-project')

    expect(result).toEqual({ ok: true })
    expect(removeRepo).toHaveBeenCalledWith('git-project')
    expect(useAppStore.getState().repos).toEqual([nextProject])
    expect(useAppStore.getState().activeRepoId).toBe('folder-project')
    expect(useAppStore.getState().activeWorktreePath).toBeNull()
  })
})


it('preserves unavailable saved resources without starting replacement processes', async () => {
  seed([gitProject()])
  const savedPanes = [
    { key: 'term:lost', kind: 'terminal', sessionId: 'lost' },
    { key: 'term:foreign', kind: 'terminal', sessionId: 'foreign' },
    { key: 'preview:gone.md', kind: 'preview', file: 'gone.md' }
  ]
  Object.assign(window.donwells, {
    listRepos: vi.fn(async () => [gitProject()]), listAgents: vi.fn(async () => []), agentList: vi.fn(async () => []),
    getSettings: vi.fn(async () => useAppStore.getState().settings), gitStatus: vi.fn(async () => null),
    terminalSessions: vi.fn(async () => [{ id: 'foreign', worktreePath: folderRoot, title: 'foreign', exited: false, createdAt: 't0' }]),
    readFile: vi.fn(async () => { throw new Error('File missing') }),
    getWorkspaceSession: vi.fn(async () => ({ activeRepoId: 'git-project', ui: { railCollapsed: true, projectListPercent: 60, sidebarWidth: 540, sidebarOpen: false, rightSidebarOpen: true, rightSidebarTab: 'memory', runsOpen: false, runsSection: 'automations' }, repos: { 'git-project': {
      panes: { [gitRoot]: savedPanes }, layouts: {}, activePane: { [gitRoot]: 'term:lost' },
      activeTerminal: { [gitRoot]: 'lost' }, terminalOrder: { [gitRoot]: ['lost', 'foreign'] }, activeWorktreePath: gitRoot
    } } }))
  })
  await useAppStore.getState().load()
  expect(useAppStore.getState().initializationError).toBeNull()
  expect(useAppStore.getState()).toMatchObject({ railCollapsed: true, projectListPercent: 60, sidebarWidth: 540, sidebarOpen: false, rightSidebarOpen: true, rightSidebarTab: 'memory', runsOpen: false, runsSection: 'automations' })
  expect(useAppStore.getState().panes[gitRoot]).toEqual(savedPanes)
  expect(useAppStore.getState().terminals).toEqual({})
  expect(useAppStore.getState().activePane[gitRoot]).toBe('term:lost')
  expect(openTerminal).not.toHaveBeenCalled()
})

it('removes missing or foreign terminal references locally without stopping another workspace', async () => {
  seed([gitProject(), folderProject()])
  const foreign = { session: { id: 'foreign', worktreePath: folderRoot, title: 'zsh', exited: false, createdAt: 't0' }, cols: 100, rows: 30 }
  useAppStore.setState({
    terminals: { foreign },
    panes: { [gitRoot]: [{ key: 'term:lost', kind: 'terminal', sessionId: 'lost' }, { key: 'term:foreign', kind: 'terminal', sessionId: 'foreign' }], [folderRoot]: [{ key: 'term:foreign', kind: 'terminal', sessionId: 'foreign' }] }
  })
  await expect(useAppStore.getState().closeTerminal(gitRoot, 'lost')).resolves.toBe(true)
  await expect(useAppStore.getState().closeTerminal(gitRoot, 'foreign')).resolves.toBe(true)
  expect(window.donwells.closeTerminal).not.toHaveBeenCalled()
  expect(useAppStore.getState().panes[gitRoot]).toEqual([])
  expect(useAppStore.getState().terminals.foreign).toEqual(foreign)
  expect(useAppStore.getState().panes[folderRoot]).toHaveLength(1)
})

it('retains an Explorer operation draft across move and hide without sharing it with another checkout', () => {
  seed([gitProject(), folderProject()])
  const draft = { kind: 'create-file' as const, value: 'src/unfinished.ts', pending: true }
  useAppStore.getState().setExplorerEntryDialog(gitRoot, draft)
  useAppStore.getState().openWorkspaceModule(gitRoot, 'explorer')
  useAppStore.getState().hidePaneView(gitRoot, `explorer:${gitRoot}`)
  expect(useAppStore.getState().explorer[gitRoot]?.entryDialog).toBe(draft)
  expect(useAppStore.getState().explorer[folderRoot]?.entryDialog).toBeUndefined()
  useAppStore.getState().openWorkspaceModule(gitRoot, 'explorer')
  expect(useAppStore.getState().explorer[gitRoot]?.entryDialog?.pending).toBe(true)
  useAppStore.getState().setExplorerEntryDialog(gitRoot, null)
  expect(useAppStore.getState().explorer[gitRoot]?.entryDialog).toBeNull()
})

it('coalesces repeated first-visit shell requests and preserves browser focus when the shell arrives', async () => {
  seed([folderProject()])
  let release!: (session: unknown) => void
  openTerminal.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
  const state = useAppStore.getState()
  state.setActiveWorktree(folderRoot)
  state.setActiveWorktree(folderRoot)
  expect(openTerminal).toHaveBeenCalledTimes(1)
  await state.openBrowser(folderRoot, 'http://localhost:3000')
  release({ id: 'automatic-shell', worktreePath: folderRoot, title: 'zsh', createdAt: '', exited: false })
  await vi.waitFor(() => expect(useAppStore.getState().terminals['automatic-shell']).toBeDefined())
  expect(useAppStore.getState().panes[folderRoot].filter(pane => pane.kind === 'terminal')).toHaveLength(1)
  expect(useAppStore.getState().activePane[folderRoot]).toBe('browser:tab')
})

it('does not acknowledge a new browser location until its durable save resolves and exposes save failure', async () => {
  seed([folderProject()])
  let release!: () => void
  const save = vi.fn((_snapshot: unknown) => new Promise<void>(resolve => { release = resolve }))
  window.donwells.saveWorkspaceSession = save
  let acknowledged = false
  const opened = useAppStore.getState().openBrowser(folderRoot, 'http://localhost:8765').then(() => { acknowledged = true })
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  expect(acknowledged).toBe(false)
  expect(save.mock.calls[0]?.[0]).toMatchObject({ repos: { 'folder-project': { panes: { [folderRoot]: [{ kind: 'browser', url: 'http://localhost:8765' }] } } } })
  release(); await opened
  expect(acknowledged).toBe(true)
  window.donwells.saveWorkspaceSession = vi.fn(async () => { throw new Error('disk full') })
  await expect(useAppStore.getState().openBrowser(folderRoot, 'http://localhost:9000')).rejects.toThrow('disk full')
  expect(useAppStore.getState().error).toContain('Workspace save failed')
  window.donwells.saveWorkspaceSession = vi.fn(async () => {})
})

it('coalesces edits behind an in-flight save into one latest snapshot without acknowledging them early', async () => {
  seed([folderProject()])
  const releases: (() => void)[] = []
  const save = vi.fn((_snapshot: unknown) => new Promise<void>(resolve => { releases.push(resolve) }))
  window.donwells.saveWorkspaceSession = save
  const first = useAppStore.getState().openBrowser(folderRoot, 'http://localhost:8000')
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  let pendingAcknowledged = false
  const pending = Array.from({ length: 20 }, (_, index) => useAppStore.getState().openBrowser(folderRoot, `http://localhost:${8001 + index}`))
  void Promise.all(pending).then(() => { pendingAcknowledged = true })
  expect(save).toHaveBeenCalledTimes(1)
  releases[0](); await first
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2))
  expect(pendingAcknowledged).toBe(false)
  expect(save.mock.calls[1][0]).toMatchObject({ repos: { 'folder-project': { panes: { [folderRoot]: [{ kind: 'browser', url: 'http://localhost:8020' }] } } } })
  releases[1](); await Promise.all(pending)
  expect(save).toHaveBeenCalledTimes(2)
  window.donwells.saveWorkspaceSession = vi.fn(async () => {})
})


it('keeps hidden shells live and confirms closing a live terminal', async () => {
  seed([gitProject()])
  const store = useAppStore.getState()
  await store.openTerminal(createdRoot)
  store.hidePaneView(createdRoot, 'term:created-terminal')
  expect(window.donwells.closeTerminal).not.toHaveBeenCalled()
  expect(useAppStore.getState().terminals['created-terminal']).toBeDefined()
  store.requestClosePane(createdRoot, 'term:created-terminal')
  expect(useAppStore.getState().closeRequest?.sessionId).toBe('created-terminal')
  expect(window.donwells.closeTerminal).not.toHaveBeenCalled()
  store.cancelClosePane()
  expect(useAppStore.getState().terminals['created-terminal']).toBeDefined()
  store.requestClosePane(createdRoot, 'term:created-terminal')
  await store.confirmClosePane()
  expect(window.donwells.closeTerminal).toHaveBeenCalledWith('created-terminal')
  expect(useAppStore.getState().panes[createdRoot]).toEqual([])
})


it('activates the owning project atomically and rejects unknown checkouts', () => {
  seed([folderProject(), gitProject()])
  useAppStore.setState({ panes: { [gitRoot]: [{ key: 'term:existing', kind: 'terminal' }] }, runsOpen: true })
  useAppStore.getState().setActiveWorktree(gitRoot)
  expect(useAppStore.getState()).toMatchObject({ activeRepoId: 'git-project', activeWorktreePath: gitRoot, runsOpen: false })
  useAppStore.getState().setActiveWorktree('/unknown')
  expect(useAppStore.getState().activeWorktreePath).toBe(gitRoot)
})

it('opens remembered tools from Runs, toggles only visible tools, and reuses docked owners', () => {
  seed([gitProject()])
  useAppStore.setState({ activeWorktreePath: gitRoot, runsOpen: true, rightSidebarOpen: true, rightSidebarTab: 'explorer' })
  const state = useAppStore.getState()
  state.setRightSidebarTab('explorer', true)
  expect(useAppStore.getState()).toMatchObject({ runsOpen: false, rightSidebarOpen: true, rightSidebarTab: 'explorer' })
  state.setRightSidebarTab('explorer', true)
  expect(useAppStore.getState().rightSidebarOpen).toBe(false)
  state.openWorkspaceModule(gitRoot, 'memory')
  state.setRunsOpen(true)
  state.setRightSidebarTab('memory')
  expect(useAppStore.getState()).toMatchObject({ runsOpen: false, rightSidebarOpen: false, activePane: { [gitRoot]: `memory:${gitRoot}` } })
  expect(useAppStore.getState().panes[gitRoot]).toHaveLength(1)
})


it('keeps workspace navigation available while Runs covers the workspace', () => {
  seed([gitProject()])
  useAppStore.setState({ activeWorktreePath: gitRoot, runsOpen: true })
  for (const command of ['toggle-explorer', 'toggle-git-status', 'show-project-search', 'show-project-memory'] as const) {
    expect(commandUnavailableReason(command)).toBeUndefined()
  }
})

it('restores Markdown using the reading preference instead of falling back to source', async () => {
  seed([folderProject()])
  for (const reading of [true, false]) {
    Object.assign(window.donwells, {
      listRepos: async () => [folderProject()], listAgents: async () => [], agentList: async () => [], terminalSessions: async () => [],
      getSettings: async () => ({ markdownPreviewDefault: reading }), gitStatus: async () => ({}),
      readFile: async () => ({ path: 'guide.md', content: '# Guide', bytes: 7, truncated: false }),
      getWorkspaceSession: async () => ({ version: 1, repos: { 'folder-project': { panes: { [folderRoot]: [{ key: 'preview:guide.md', kind: 'preview', file: 'guide.md' }] } } } })
    })
    await useAppStore.getState().load()
    expect(useAppStore.getState().initializationError).toBeNull()
    expect(useAppStore.getState().previews[folderRoot]?.['guide.md']?.mode).toBe(reading ? 'preview' : 'edit')
  }
})


it('opens computer control through its discoverable command and requires a project', () => {
  seed([gitProject()])
  useAppStore.setState({ activeWorktreePath: gitRoot, runsOpen: true })
  expect(commandUnavailableReason('show-computer-control')).toBeUndefined()
  dispatchAppCommand('show-computer-control')
  expect(useAppStore.getState()).toMatchObject({ runsOpen: false, rightSidebarOpen: true, rightSidebarTab: 'computer' })
  useAppStore.setState({ activeWorktreePath: null })
  expect(commandUnavailableReason('show-computer-control')).toBeTruthy()
})
