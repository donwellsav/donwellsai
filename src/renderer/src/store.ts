import { create } from 'zustand'
import { disposePreviewModel } from './editor-models'
import type {
  AgentPreset,
  AppSettings,
  FileContent,
  FileEntry,
  PersistedState,
  PreviewMode,
  RepoSummary,
  RunningAgent,
  SettingsSection,
  TerminalSession,
  WorktreeStatus
} from '@shared/types'
import { terminalBus } from './terminal-bus'

type TerminalView = {
  session: TerminalSession
  /** current cols/rows the xterm instance is rendered at (for resize sync) */
  cols: number
  rows: number
}

/** A pane inside a worktree: terminal tab, preview, or embedded browser. */
export type PaneKind = 'terminal' | 'explorer' | 'git-status' | 'preview' | 'browser'
export type Pane = {
  key: string
  kind: PaneKind
  sessionId?: string
  file?: string
  /** browser pane start URL */
  url?: string
}
/** Binary split tree (upstream TabGroupLayoutNode): leaf = pane key. */
export type LayoutNode = { kind: 'leaf'; pane: string } | { kind: 'split'; dir: 'row' | 'col'; first: LayoutNode; second: LayoutNode; /** first child size in percent (drag divider; default 50) */ size?: number }
/** Insert newKey as an immediate sibling of targetKey; when targetKey is absent
 *  from the tree, fall back to splitting the first leaf (pane must render). */
function insertLeaf(node: LayoutNode, targetKey: string | undefined, newKey: string): LayoutNode | null {
  const matched = targetKey !== undefined ? insertAt(node, targetKey, newKey) : null
  return matched ?? insertAt(node, undefined, newKey)
}

export function isMarkdownFile(relPath: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(relPath)
}

function defaultPreviewMode(relPath: string, settings: AppSettings): PreviewMode {
  return isMarkdownFile(relPath) && settings.markdownPreviewDefault ? 'preview' : 'edit'
}

function layoutHasLeaf(node: LayoutNode, key: string): boolean {
  if (node.kind === 'leaf') return node.pane === key
  return layoutHasLeaf(node.first, key) || layoutHasLeaf(node.second, key)
}

function insertAt(node: LayoutNode, targetKey: string | undefined, newKey: string): LayoutNode | null {
  if (node.kind === 'leaf') {
    if (targetKey === undefined || node.pane === targetKey) {
      return { kind: 'split', dir: 'row', first: node, second: { kind: 'leaf', pane: newKey } }
    }
    return null
  }
  const first = insertAt(node.first, targetKey, newKey)
  if (first) return { ...node, first }
  const second = insertAt(node.second, targetKey, newKey)
  if (second) return { ...node, second }
  return null
}

/** Set size (first-child percent) on the split node with the given pre-order id. */
function setSplitSizeById(node: LayoutNode, targetId: number, pct: number, counter: { n: number }): LayoutNode {
  if (node.kind === 'leaf') return node
  const id = counter.n++
  const first = setSplitSizeById(node.first, targetId, pct, counter)
  const second = setSplitSizeById(node.second, targetId, pct, counter)
  return { ...node, first, second, size: id === targetId ? pct : node.size }
}

/** Remove a leaf by pane key; promote the surviving sibling at each collapse. */
function removeLeaf(node: LayoutNode, paneKey: string): LayoutNode | null {
  if (node.kind === 'leaf') return node.pane === paneKey ? null : node
  const first = removeLeaf(node.first, paneKey)
  const second = removeLeaf(node.second, paneKey)
  if (!first) return second
  if (!second) return first
  return { ...node, first, second }
}

/** Invariant keeper: layout leaves ⊆ live pane keys. Drops dead leaves
 *  (e.g. previews closed before layouts learned to prune) and collapses
 *  splits whose side vanished. */
function pruneLayoutTo(node: LayoutNode, validKeys: ReadonlySet<string>): LayoutNode | null {
  if (node.kind === 'leaf') return validKeys.has(node.pane) ? node : null
  const first = pruneLayoutTo(node.first, validKeys)
  const second = pruneLayoutTo(node.second, validKeys)
  if (!first) return second
  if (!second) return first
  if (first === node.first && second === node.second) return node
  return { ...node, first, second }
}
/** Rename one leaf key in place (editor retarget keeps the split geometry). */
function replaceLayoutLeafKey(node: LayoutNode, from: string, to: string): LayoutNode {
  if (node.kind === 'leaf') return node.pane === from ? { ...node, pane: to } : node
  return { ...node, first: replaceLayoutLeafKey(node.first, from, to), second: replaceLayoutLeafKey(node.second, from, to) }
}


type AppState = {
  repos: RepoSummary[]
  loading: boolean
  error: string | null
  activeRepoId: string | null
  /** the worktree path a card is expanded/arrowed; null = main worktree */
  activeWorktreePath: string | null

  /** live git status per worktree path (polled) */
  statuses: Record<string, WorktreeStatus>
  /** per-worktree scan: listening ports + cpu/mem usage (polled; Orca status segments) */
  scans: Record<string, { ports: Array<{ port: number; pid: number; command: string }>; cpuPercent: number; memMB: number }>
  /** file explorer entries per worktree path */
  explorer: Record<string, FileEntry[]>
  /** open editor buffers: worktree path → file relPath → versioned content (+ markdown view mode) */
  previews: Record<string, Record<string, FileContent & { v: number; mode?: PreviewMode }>>
  /** loading flags */
  busy: Record<string, boolean>

  /** terminals per worktree path */
  terminals: Record<string, TerminalView>
  /** RCU order of open terminals per worktree path */
  terminalOrder: Record<string, string[]>
  /** per-worktree panes (terminal tabs + explorer + git) in layout order */
  panes: Record<string, Pane[]>
  /** which pane key is active per worktree path */
  activePane: Record<string, string>
  /** active terminal session id per worktree path (recipient of typed input) */
  activeTerminal: Record<string, string>

  /** agents launched into worktree terminals, session-scoped */
  runningAgents: Record<string, RunningAgent>
  agents: AgentPreset[]
  settings: AppSettings
  /** split-tree layout per worktree path; undefined = flat single active pane */
  layouts: Record<string, LayoutNode>
  paletteOpen: boolean
  settingsOpen: boolean
  /** which settings section the modal shows (nav rail selection; deep-linkable) */
  settingsSection: SettingsSection
  /** app chrome (Orca shell state) */
  sidebarOpen: boolean
  sidebarWidth: number
  rightSidebarWidth: number
  rightSidebarOpen: boolean
  rightSidebarTab: 'explorer' | 'git'
  createOpen: boolean
  /** worktree path pending styled delete confirmation (null = closed) */
  deleteTarget: string | null
  load(): Promise<void>
  addRepo(dir: string): Promise<void>
  removeRepo(repoId: string): Promise<void>
  /** Re-pull the repo list after a CLI/RPC client mutates repos behind our back. */
  syncRepos(): Promise<void>
  refresh(repoId?: string): Promise<void>
  createWorktree(name?: string, branch?: string): Promise<void>
  removeWorktree(worktreePath: string, force?: boolean): Promise<void>
  setDeleteTarget(path: string | null): void
  openTerminal(worktreePath: string): Promise<TerminalSession | null>
  closeTerminal(worktreePath: string, sessionId: string): void
  writeTerminal(sessionId: string, data: string): void
  interruptTerminal(sessionId: string): void
  resizeTerminal(sessionId: string, cols: number, rows: number): void
  togglePane(worktreePath: string, kind: 'explorer' | 'git-status'): void
  closePane(worktreePath: string, key: string): void
  setActivePane(worktreePath: string, key: string): void
  splitTerminal(worktreePath: string): Promise<void>
  selectTerminal(worktreePath: string, sessionId: string): void

  loadExplorer(worktreePath: string, prefix?: string): Promise<void>
  openPreview(worktreePath: string, relPath: string): Promise<void>
  /** Switch an open editor pane to another file (tab switch semantics). */
  retargetPreview(worktreePath: string, paneKey: string, relPath: string): Promise<void>
  openBrowser(worktreePath: string, url: string): void
  writePreview(worktreePath: string, relPath: string, content: string): Promise<void>
  /** Editor → buffer sync after a save, without re-adopting into monaco (no v bump). */
  notePreviewContent(worktreePath: string, relPath: string, content: string): void
  /** Close one file (relPath) or every editor of the worktree when omitted. */
  closePreview(worktreePath: string, relPath?: string): void
  /** Set an editor buffer's view mode (markdown files: 'edit' source / 'preview' rendered). */
  setPreviewMode(worktreePath: string, relPath: string, mode: PreviewMode): void
  pruneRemovedRepos(): void
  refreshStatuses(): Promise<void>
  /** Scan ports + resource usage for the active worktree (status segments). */
  refreshScan(worktreePath: string): Promise<void>

  runAgent(worktreePath: string, command: string): Promise<void>
  stopAgent(sessionId: string): void
  dismissAgent(sessionId: string): void

  setPaletteOpen(open: boolean): void
  setSettingsOpen(open: boolean): void
  openSettings(section: SettingsSection): void
  setSettings(patch: Partial<AppSettings>): Promise<void>
  setSidebarOpen(open: boolean): void
  setSidebarWidth(w: number): void
  setRightSidebarWidth(w: number): void
  resizeSplit(worktreePath: string, splitId: number, pct: number): void
  setRightSidebarOpen(open: boolean): void
  setRightSidebarTab(tab: 'explorer' | 'git'): void
  setCreateOpen(open: boolean): void

  setActiveRepo(repoId: string | null): void
  setActiveWorktree(path: string | null): void
  applyTerminalExit(sessionId: string, exitCode: number): void
  applyTerminalTitle(sessionId: string, title: string): void
  setError(err: string | null): void
  applyAgentHook(sessionId: string, state: string, detail: string): void
}

/** Restore persisted per-repo workbench (panes/tabs/active) into a fresh state object.
 *  Live-session lookups may hit the daemon; callers treat failure as non-fatal. */
async function restoreSession(
  saved: NonNullable<Awaited<ReturnType<typeof window.orca.getWorkspaceSession>>>,
  repos: RepoSummary[],
  state: Partial<AppState>
): Promise<void> {
  const restored: {
    panes: Record<string, Pane[]>
    activePane: Record<string, string>
    activeTerminal: Record<string, string>
    terminalOrder: Record<string, string[]>
    terminals: Record<string, TerminalView>
    layouts: Record<string, LayoutNode>
    runningAgents: Record<string, RunningAgent>
  } = { panes: {}, activePane: {}, activeTerminal: {}, terminalOrder: {}, terminals: {}, layouts: {}, runningAgents: {} }
  const liveSessions = await window.orca.terminalSessions()
  const restoredPreviews: Record<string, Record<string, FileContent & { v: number }>> = {}
  const liveById = new Map(liveSessions.map((s) => [s.id, s]))
  for (const repo of repos) {
    const savedRepo = saved.repos[repo.repo.id]
    if (!savedRepo) continue
    for (const [wtPath, panes] of Object.entries(savedRepo.panes)) {
      const valid: Pane[] = []
      for (const p of panes) {
        if (p.kind !== 'terminal' || !p.sessionId) {
          // Editor buffers repopulate from disk on restore — a pane whose file
          // is gone drops like a dead terminal instead of rendering blank.
          if (p.kind === 'preview' && p.file) {
            try {
              const files = (restoredPreviews[wtPath] ??= {})
              if (p.file in files) { valid.push(p); continue }
              if (Object.keys(files).length >= 12) continue
              const content = await window.orca.readFile(wtPath, p.file)
              files[p.file] = { ...content, v: 0 }
            } catch {
              continue
            }
          }
          valid.push(p)
          continue
        }
        const live = liveById.get(p.sessionId)
        if (live && !live.exited) {
          valid.push(p)
          if (!restored.terminals[p.sessionId]) {
            restored.terminals[p.sessionId] = { session: live, cols: 100, rows: 30 }
          }
          continue
        }
        // Daemon lost the PTY (crash/reap): keep the tab, swap in a fresh
        // shell (Orca's pendingReconnect, resolved immediately). Dropping the
        // pane made every restart lose workspaces whenever the daemon cycled.
        try {
          const fresh = await window.orca.openTerminal(wtPath, wtPath)
          restored.terminals[fresh.id] = { session: fresh, cols: 100, rows: 30 }
          valid.push({ ...p, sessionId: fresh.id })
        } catch {
          /* worktree gone — drop this pane only */
        }
      }
      if (!valid.length) continue
      restored.panes[wtPath] = valid
      restored.terminalOrder[wtPath] = valid.filter((p) => p.sessionId).map((p) => p.sessionId!)
      // Restore the split tree pruned to the panes that actually survived.
      const savedLayout = savedRepo.layouts?.[wtPath]
      if (savedLayout) {
        const validKeys = new Set(valid.map((p) => p.key))
        // leaves with no live pane die too — stale previews etc. survive per-pane diffs otherwise
        const pruned = pruneLayoutTo(savedLayout, new Set(valid.map((p) => p.key)))
        if (pruned) restored.layouts[wtPath] = pruned
      }
    }
    restored.activePane = { ...restored.activePane, ...savedRepo.activePane }
    restored.activeTerminal = { ...restored.activeTerminal, ...savedRepo.activeTerminal }
  }
  state.panes = restored.panes
  state.activePane = restored.activePane
  state.activeTerminal = restored.activeTerminal
  state.terminalOrder = restored.terminalOrder
  state.terminals = restored.terminals
  // Agent chips restore only alongside their PTY session (daemon still owns
  // the process). Reopened panes get fresh session ids, so a dead agent's chip
  // can never resurrect as a stale badge.
  for (const [sid, agent] of Object.entries(saved.runningAgents ?? {})) {
    if (restored.terminals[sid]) restored.runningAgents[sid] = agent
  }
  state.runningAgents = restored.runningAgents
  state.previews = restoredPreviews
  state.layouts = restored.layouts
  state.activeWorktreePath = saved.repos[state.activeRepoId ?? '']?.activeWorktreePath ?? null
}


export const useAppStore = create<AppState>((set, get) => ({
  repos: [],
  loading: true,
  error: null,
  activeRepoId: null,
  activeWorktreePath: null,
  statuses: {},
  scans: {},
  explorer: {},
  previews: {},
  busy: {},
  settings: { agentCommand: 'codex', theme: 'dark', fontSize: 13, statusPollMs: 5000 },
  terminals: {},
  terminalOrder: {},
  panes: {},
  layouts: {},
  activePane: {},
  activeTerminal: {},
  sidebarOpen: true,
  sidebarWidth: 280,
  rightSidebarWidth: 350,
  rightSidebarOpen: false,
  rightSidebarTab: 'explorer',
  createOpen: false,
  deleteTarget: null,
  paletteOpen: false,
  settingsOpen: false,
  settingsSection: 'general',
  runningAgents: {},
  agents: [],

  async load() {
    try {
      const [repos, agents, settings, wsSession] = await Promise.all([
        window.orca.listRepos().catch(() => [] as RepoSummary[]),
        window.orca.listAgents().catch(() => [] as AgentPreset[]),
        window.orca.getSettings().catch(() => get().settings),
        window.orca.getWorkspaceSession().catch(() => null)
      ])
      const state: Partial<AppState> = { repos, agents, settings, loading: false }
      const saved = wsSession ?? undefined
      if (saved?.activeRepoId && repos.some((r) => r.repo.id === saved.activeRepoId)) {
        state.activeRepoId = saved.activeRepoId
      } else if (repos.length > 0) {
        state.activeRepoId = repos[0]!.repo.id
      }
      if (saved) {
        // Session restore is async (daemon round-trip) — it MUST complete before
        // the state object is committed, or the workbench boots empty every time.
        try {
          await restoreSession(saved, repos, state)
        } catch (restoreErr) {
          console.error('session restore failed:', restoreErr)
        }
      }
      set(state)
      const ui = saved?.ui
      if (ui) {
        set({
          sidebarWidth: ui.sidebarWidth ?? get().sidebarWidth,
          rightSidebarWidth: ui.rightSidebarWidth ?? get().rightSidebarWidth,
        })
      }
      if (repos.length > 0) void get().refreshStatuses()
    } catch (e) {
      set({ loading: false, error: String(e) })
    }
  },

  async addRepo(dir: string) {
    try {
      const summary = await window.orca.addRepo(dir)
      const repos = [...get().repos.filter((r) => r.repo.id !== summary.repo.id), summary]
      set({ repos, activeRepoId: summary.repo.id, error: null })
      void get().refreshStatuses()
    } catch (e) {
      set({ error: String(e) })
    }
  },

  async removeRepo(repoId: string) {
    await window.orca.removeRepo(repoId)
    set({ repos: get().repos.filter((r) => r.repo.id !== repoId) })
    if (get().activeRepoId === repoId) set({ activeRepoId: get().repos[0]?.repo.id ?? null })
    get().pruneRemovedRepos()
  },

  async syncRepos() {
    try {
      const repos = await window.orca.listRepos()
      set({ repos, error: null })
      if (!get().activeRepoId && repos.length > 0) set({ activeRepoId: repos[0]!.repo.id })
      get().pruneRemovedRepos()
    } catch (e) {
      set({ error: String(e) })
    }
  },

  async refresh(repoId?: string) {
    try {
      const id = repoId ?? get().activeRepoId
      if (!id) return
      const summary = await window.orca.refreshRepo(id)
      set({ repos: get().repos.map((r) => (r.repo.id === id ? summary : r)), error: null })
      void get().refreshStatuses()
    } catch (e) {
      set({ error: String(e) })
    }
  },

  async createWorktree(name?: string, branch?: string) {
    const repoId = get().activeRepoId
    if (!repoId) return
    try {
      const summary = await window.orca.createWorktree(repoId, { name, branch })
      set({ repos: get().repos.map((r) => (r.repo.id === repoId ? summary : r)), error: null })
    } catch (e) {
      set({ error: String(e) })
    }
  },

  async removeWorktree(worktreePath: string, force = false) {
    const repoId = get().activeRepoId
    if (!repoId) return
    try {
      const summary = await window.orca.removeWorktree(repoId, worktreePath, force)
      // drop any state bound to the deleted worktree
      set((s) => {
        const terminals = { ...s.terminals }
        const panes = { ...s.panes }
        for (const [id, t] of Object.entries(terminals)) {
          if (t.session.worktreePath === worktreePath) {
            delete terminals[id]
            void window.orca.closeTerminal(id)
          }
        }
        const runningAgents = { ...s.runningAgents }
        for (const [id, a] of Object.entries(runningAgents)) {
          if (a.worktreePath === worktreePath) {
            delete runningAgents[id]
            void window.orca.closeTerminal(id)
          }
        }
        delete panes[worktreePath]
        delete s.activePane[worktreePath]
        delete s.activeTerminal[worktreePath]
        delete s.statuses[worktreePath]
        delete s.explorer[worktreePath]
        delete s.previews[worktreePath]
        if (s.activeWorktreePath === worktreePath) s.activeWorktreePath = null
        return { repos: s.repos.map((r) => (r.repo.id === repoId ? summary : r)), terminals, panes, runningAgents, error: null }
      })
      void get().refreshStatuses()
    } catch (e) {
      set({ error: String(e) })
    }
  },

  async openTerminal(worktreePath: string) {
    try {
      const session = await window.orca.openTerminal(worktreePath)
      const key = `term:${session.id}`
      set((s) => {
        const terminalOrder = { ...s.terminalOrder, [worktreePath]: [...(s.terminalOrder[worktreePath] ?? []), session.id] }
        const panes = { ...s.panes }
        const cardPanes = panes[worktreePath] ?? []
        const pane: Pane = { key, kind: 'terminal', sessionId: session.id }
        if (!cardPanes.some((p) => p.key === key)) cardPanes.push(pane)
        panes[worktreePath] = cardPanes
        return {
          terminals: { ...s.terminals, [session.id]: { session, cols: 100, rows: 30 } },
          terminalOrder,
          panes,
          activePane: { ...s.activePane, [worktreePath]: key },
          activeTerminal: { ...s.activeTerminal, [worktreePath]: session.id },
          activeWorktreePath: worktreePath,
          error: null
        }
      })
      persistSessionSoon()
      return session
    } catch (e) {
      set({ error: String(e) })
      return null
    }
  },

  closeTerminal(worktreePath: string, sessionId: string) {
    void window.orca.closeTerminal(sessionId)
    set((s) => {
      const terminals = { ...s.terminals }
      delete terminals[sessionId]
      const panes = { ...s.panes }
      const cardPanes = (panes[worktreePath] ?? []).filter((p) => p.sessionId !== sessionId)
      panes[worktreePath] = cardPanes
      const activePane = { ...s.activePane }
      const activeTerminal = { ...s.activeTerminal }
      const terminalOrder = { ...s.terminalOrder, [worktreePath]: (s.terminalOrder[worktreePath] ?? []).filter((id) => id !== sessionId) }
      if (activeTerminal[worktreePath] === sessionId) {
        const next = cardPanes.find((p) => p.kind === 'terminal')
        activeTerminal[worktreePath] = next?.sessionId ?? ''
        activePane[worktreePath] = next?.key ?? cardPanes[0]?.key ?? ''
      }
      const runningAgents = { ...s.runningAgents }
      delete runningAgents[sessionId]
      return { terminals, panes, activePane, activeTerminal, terminalOrder, runningAgents }
    })
    terminalBus.dropSession(sessionId)
    persistSessionSoon()
  },

  writeTerminal(sessionId: string, data: string) {
    void window.orca.terminalWrite(sessionId, data)
  },

  interruptTerminal(sessionId: string) {
    void window.orca.terminalInterrupt(sessionId)
  },

  resizeTerminal(sessionId: string, cols: number, rows: number) {
    set((s) => ({ terminals: { ...s.terminals, [sessionId]: { ...s.terminals[sessionId]!, cols, rows } } }))
    void window.orca.terminalResize(sessionId, cols, rows)
  },

  togglePane(worktreePath: string, kind: 'explorer' | 'git-status') {
    set((s) => {
      const panes = { ...s.panes }
      const cardPanes = [...(panes[worktreePath] ?? [])]
      const existing = cardPanes.findIndex((p) => p.kind === kind)
      const activePane = { ...s.activePane }
      const prev = activePane[worktreePath]
      if (existing !== -1) {
        cardPanes.splice(existing, 1)
        panes[worktreePath] = cardPanes
        const first = panes[worktreePath][0]
        activePane[worktreePath] = first?.key ?? ''
        if (kind === 'git-status') void get().refreshStatuses()
      } else {
        const key = `${kind}:${worktreePath}`
        cardPanes.push({ key, kind })
        panes[worktreePath] = cardPanes
        activePane[worktreePath] = key
        if (kind === 'explorer') void get().loadExplorer(worktreePath)
        if (kind === 'git-status') void get().refreshStatuses()
      }
      void prev
      return { panes, activePane }
    })
    persistSessionSoon()
  },

  closePane(worktreePath: string, key: string) {
    // closing an editor pane means closing its file: buffers, tabs, and models
    const target = get().panes[worktreePath]?.find((p) => p.key === key)
    if (target?.kind === 'preview' && target.file) {
      get().closePreview(worktreePath, target.file)
      return
    }
    set((s) => {
      const panes = { ...s.panes }
      const cardPanes = (panes[worktreePath] ?? []).filter((p) => p.key !== key)
      panes[worktreePath] = cardPanes
      const activePane = { ...s.activePane }
      if (activePane[worktreePath] === key) {
        activePane[worktreePath] = cardPanes[0]?.key ?? ''
      }
      // layout: remove the leaf; a split collapses to its surviving child
      const prevLayout = s.layouts[worktreePath]
      let layouts = s.layouts
      if (prevLayout) {
        const next = removeLeaf(prevLayout, key)
        layouts = { ...s.layouts }
        if (next) layouts[worktreePath] = next
        else delete layouts[worktreePath]
      }
      const p = s.panes[worktreePath]?.find((x) => x.key === key)
      if (p?.sessionId) {
        const terminals = { ...s.terminals }
        delete terminals[p.sessionId]
        void window.orca.closeTerminal(p.sessionId)
        const runningAgents = { ...s.runningAgents }
        delete runningAgents[p.sessionId]
        return { panes, activePane, terminals, runningAgents, layouts, terminalOrder: { ...s.terminalOrder, [worktreePath]: (s.terminalOrder[worktreePath] ?? []).filter((id) => id !== p.sessionId) } }
      }
      return { panes, activePane, layouts }
    })
    persistSessionSoon()
  },

  setActivePane(worktreePath: string, key: string) {
    set((s) => {
      const p = s.panes[worktreePath]?.find((x) => x.key === key)
      return {
        activePane: { ...s.activePane, [worktreePath]: key },
        ...(p?.sessionId ? { activeTerminal: { ...s.activeTerminal, [worktreePath]: p.sessionId } } : {})
      }
    })
    persistSessionSoon()
  },

  async splitTerminal(worktreePath: string) {
    const s = get()
    const activeKey = s.activePane[worktreePath]
    const session = await get().openTerminal(worktreePath)
    if (!session) return
    const newKey = `term:${session.id}`
    // split the active pane's leaf: new terminal beside it (row = side-by-side)
    set((st) => {
      const prev = st.layouts[worktreePath]
      let next: LayoutNode
      if (!prev) {
        next = { kind: 'split', dir: 'row', first: { kind: 'leaf', pane: activeKey ?? newKey }, second: { kind: 'leaf', pane: newKey } }
      } else {
        const inserted = insertLeaf(prev, activeKey, newKey)
        next = inserted ?? { kind: 'split', dir: 'row', first: prev, second: { kind: 'leaf', pane: newKey } }
      }
      return { layouts: { ...st.layouts, [worktreePath]: next } }
    })
    if (session) get().selectTerminal(worktreePath, session.id)
    persistSessionSoon()
  },

  selectTerminal(worktreePath: string, sessionId: string) {
    if (!worktreePath || !sessionId) return
    set((s) => {
      const p = s.panes[worktreePath]?.find((x) => x.sessionId === sessionId)
      return {
        activeTerminal: { ...s.activeTerminal, [worktreePath]: sessionId },
        ...(p ? { activePane: { ...s.activePane, [worktreePath]: p.key } } : {})
      }
    })
    persistSessionSoon()
  },

  async loadExplorer(worktreePath: string, prefix = '') {
    try {
      const entries = await window.orca.listFiles(worktreePath, prefix)
      set((s) => ({ explorer: { ...s.explorer, [worktreePath]: entries }, error: null }))
    } catch (e) {
      set({ error: String(e) })
    }
  },

  async openPreview(worktreePath: string, relPath: string) {
    try {
      const content = await window.orca.readFile(worktreePath, relPath)
      const key = `preview:${relPath}`
      set((s) => {
        const existing = s.previews[worktreePath]?.[relPath]
        const previews = {
          ...s.previews,
          [worktreePath]: {
            ...s.previews[worktreePath],
            [relPath]: { ...content, v: (existing?.v ?? 0) + 1, mode: existing?.mode ?? defaultPreviewMode(relPath, s.settings) }
          }
        }
        const panes = { ...s.panes }
        const cardPanes = [...(panes[worktreePath] ?? [])]
        const activePane = { ...s.activePane, [worktreePath]: key }
        // already open somewhere → just focus that pane
        if (cardPanes.some((p) => p.key === key)) return { previews, activePane, error: null }
        // editor tabs: opening a new file retargets the ACTIVE editor pane, not a new split
        const activeKey = s.activePane[worktreePath]
        const active = activeKey ? cardPanes.find((p) => p.key === activeKey) : undefined
        let layouts = s.layouts
        if (active?.kind === 'preview') {
          cardPanes[cardPanes.indexOf(active)] = { ...active, key, file: relPath }
          panes[worktreePath] = cardPanes
          const prevLayout = s.layouts[worktreePath]
          if (prevLayout) layouts = { ...s.layouts, [worktreePath]: replaceLayoutLeafKey(prevLayout, activeKey, key) }
          return { previews, panes, layouts, activePane, error: null }
        }
        cardPanes.push({ key, kind: 'preview', file: relPath })
        panes[worktreePath] = cardPanes
        // a live split tree must include the new pane or it never renders
        if (s.layouts[worktreePath] && !layoutHasLeaf(s.layouts[worktreePath]!, key)) {
          const next = insertLeaf(s.layouts[worktreePath]!, s.activePane[worktreePath], key)
          if (next) layouts = { ...s.layouts, [worktreePath]: next }
        }
        return { previews, panes, layouts, activePane, error: null }
      })
      persistSessionSoon()
    } catch (e) {
      set({ error: String(e) })
    }
  },

  async retargetPreview(worktreePath: string, paneKey: string, relPath: string) {
    try {
      const content = await window.orca.readFile(worktreePath, relPath)
      const key = `preview:${relPath}`
      set((s) => {
        const existing = s.previews[worktreePath]?.[relPath]
        const previews = {
          ...s.previews,
          [worktreePath]: {
            ...s.previews[worktreePath],
            [relPath]: { ...content, v: (existing?.v ?? 0) + 1, mode: existing?.mode ?? defaultPreviewMode(relPath, s.settings) }
          }
        }
        const panes = { ...s.panes }
        const cardPanes = [...(panes[worktreePath] ?? [])]
        const idx = cardPanes.findIndex((p) => p.key === paneKey)
        if (idx === -1 || cardPanes[idx]!.kind !== 'preview') return { error: null }
        // a pane for that file exists elsewhere already: close ours, focus theirs
        const other = cardPanes.findIndex((p) => p.key === key && p.file === relPath)
        let layouts = s.layouts
        if (other !== -1) {
          cardPanes.splice(idx, 1)
          panes[worktreePath] = cardPanes
          const prevLayout = s.layouts[worktreePath]
          if (prevLayout) {
            const pruned = pruneLayoutTo(prevLayout, new Set(cardPanes.map((p) => p.key)))
            layouts = { ...s.layouts }
            if (pruned) layouts[worktreePath] = pruned
            else delete layouts[worktreePath]
          }
          return { previews, panes, layouts, activePane: { ...s.activePane, [worktreePath]: key }, error: null }
        }
        cardPanes[idx] = { ...cardPanes[idx]!, key, file: relPath }
        panes[worktreePath] = cardPanes
        const prevLayout = s.layouts[worktreePath]
        if (prevLayout) layouts = { ...s.layouts, [worktreePath]: replaceLayoutLeafKey(prevLayout, paneKey, key) }
        return { previews, panes, layouts, activePane: { ...s.activePane, [worktreePath]: key }, error: null }
      })
      persistSessionSoon()
    } catch (e) {
      set({ error: String(e) })
    }
  },

  /** Agent/user write-through: replace the file in the worktree and, when the
   *  editor pane is open on it, replace its buffer in place (v bump triggers
   *  the pane to adopt the new content without a disk round-trip). */
  async writePreview(worktreePath: string, relPath: string, content: string) {
    const saved = await window.orca.writeFile(worktreePath, relPath, content)
    const key = `preview:${relPath}`
    set((s) => {
      const existing = s.previews[worktreePath]?.[relPath]
      const previews = {
        ...s.previews,
        [worktreePath]: {
          ...s.previews[worktreePath],
          [relPath]: { ...saved, v: (existing?.v ?? 0) + 1, mode: existing?.mode ?? defaultPreviewMode(relPath, s.settings) }
        }
      }
      const panes = { ...s.panes }
      const cardPanes = [...(panes[worktreePath] ?? [])]
      if (!cardPanes.some((p) => p.kind === 'preview' && p.file === relPath)) {
        cardPanes.push({ key, kind: 'preview', file: relPath })
        panes[worktreePath] = cardPanes
      }
      let layouts = s.layouts
      if (s.layouts[worktreePath] && !layoutHasLeaf(s.layouts[worktreePath]!, key)) {
        const next = insertLeaf(s.layouts[worktreePath]!, s.activePane[worktreePath], key)
        if (next) layouts = { ...s.layouts, [worktreePath]: next }
      }
      return { previews, panes, layouts, activePane: { ...s.activePane, [worktreePath]: key }, error: null }
    })
    persistSessionSoon()
  },

  setPreviewMode(worktreePath: string, relPath: string, mode: PreviewMode) {
    set((s) => {
      const file = s.previews[worktreePath]?.[relPath]
      if (!file || file.mode === mode) return {}
      return {
        previews: { ...s.previews, [worktreePath]: { ...s.previews[worktreePath], [relPath]: { ...file, mode } } }
      }
    })
  },

  /** Open (or retarget) the worktree's single embedded browser pane. */
  openBrowser(worktreePath: string, url: string) {
    const normalized = /^https?:\/\//.test(url) ? url : `https://${url}`
    const key = 'browser:tab'
    set((s) => {
      const panes = { ...s.panes }
      const cardPanes = [...(panes[worktreePath] ?? [])]
      const idx = cardPanes.findIndex((p) => p.kind === 'browser')
      const existed = idx !== -1
      if (existed) {
        cardPanes[idx] = { ...cardPanes[idx]!, url: normalized }
      } else {
        cardPanes.push({ key, kind: 'browser', url: normalized })
      }
      panes[worktreePath] = cardPanes
      let layouts = s.layouts
      if (s.layouts[worktreePath] && !layoutHasLeaf(s.layouts[worktreePath]!, key)) {
        const next = insertLeaf(s.layouts[worktreePath]!, s.activePane[worktreePath], key)
        if (next) layouts = { ...s.layouts, [worktreePath]: next }
      }
      return { panes, layouts, activePane: { ...s.activePane, [worktreePath]: key } }
    })
    persistSessionSoon()
  },

  notePreviewContent(worktreePath: string, relPath: string, content: string) {
    set((s) => {
      const file = s.previews[worktreePath]?.[relPath]
      if (!file || file.content === content) return {}
      return {
        previews: {
          ...s.previews,
          [worktreePath]: { ...s.previews[worktreePath], [relPath]: { ...file, content } }
        }
      }
    })
  },

  closePreview(worktreePath: string, relPath?: string) {
    const closedFiles = relPath !== undefined ? [relPath] : Object.keys(get().previews[worktreePath] ?? {})
    set((s) => {
      const panes = { ...s.panes }
      const cardPanes = (panes[worktreePath] ?? []).filter(
        (p) => p.kind !== 'preview' || (relPath !== undefined && p.file !== relPath)
      )
      panes[worktreePath] = cardPanes
      const previews = { ...s.previews }
      if (relPath === undefined) {
        delete previews[worktreePath]
      } else {
        const files = { ...previews[worktreePath] }
        delete files[relPath]
        if (Object.keys(files).length === 0) delete previews[worktreePath]
        else previews[worktreePath] = files
      }
      const activePane = { ...s.activePane }
      if (!cardPanes.some((p) => p.key === activePane[worktreePath])) {
        activePane[worktreePath] = cardPanes[0]?.key ?? ''
      }
      // preview panes leave the split tree too, or the layout dangles a dead leaf
      let layouts = s.layouts
      const prevLayout = s.layouts[worktreePath]
      if (prevLayout) {
        const pruned = pruneLayoutTo(prevLayout, new Set(cardPanes.map((p) => p.key)))
        layouts = { ...s.layouts }
        if (pruned) layouts[worktreePath] = pruned
        else delete layouts[worktreePath]
      }
      persistSessionSoon()
      return { panes, previews, activePane, layouts }
    })
    // models for files no longer shown anywhere get disposed (memory ceiling)
    for (const f of closedFiles) disposePreviewModel(worktreePath, f)
  },

  /** Drop all per-worktree UI state whose worktree no longer belongs to any repo
   *  (repo removed via CLI/RPC behind the renderer's back, or worktree vanished). */
  pruneRemovedRepos() {
    const live = new Set<string>()
    for (const r of get().repos) for (const w of r.worktrees) live.add(w.path)
    const drop = <T,>(m: Record<string, T>): Record<string, T> => {
      const out: Record<string, T> = {}
      for (const k of Object.keys(m)) if (live.has(k)) out[k] = m[k]!
      return out
    }
    set((s) => ({
      panes: drop(s.panes),
      activePane: drop(s.activePane),
      activeTerminal: drop(s.activeTerminal),
      terminalOrder: drop(s.terminalOrder),
      terminals: drop(s.terminals),
      layouts: drop(s.layouts),
      statuses: drop(s.statuses),
      explorer: drop(s.explorer),
      previews: drop(s.previews),
      busy: drop(s.busy),
      runningAgents: drop(s.runningAgents)
    }))
  },

  async refreshStatuses() {
    const repos = get().repos
    const paths = new Set<string>()
    for (const r of repos) for (const w of r.worktrees) paths.add(w.path)
    if (paths.size === 0) return
    const statuses: Record<string, WorktreeStatus> = {}
    const results = await Promise.allSettled([...paths].map((p) => window.orca.gitStatus(p)))
    let i = 0
    for (const p of paths) {
      const r = results[i++]!
      if (r.status === 'fulfilled') statuses[p] = r.value
    }
    set((s) => {
      // merge poll-sourced statuses; never clear a user-facing error — the poll
      // succeeding doesn't mean the last action's error expired
      return { statuses: { ...s.statuses, ...statuses } }
    })
  },

  async refreshScan(worktreePath: string) {
    try {
      const scan = await window.orca.scanWorktree(worktreePath)
      set((s) => ({ scans: { ...s.scans, [worktreePath]: scan } }))
    } catch {
      // lsof/ps unavailable or sandboxed — leave previous scan; segments stay quiet
    }
  },

  async runAgent(worktreePath: string, command: string) {
    const trimmed = command.trim()
    if (!trimmed) return
    const session = await get().openTerminal(worktreePath)
    if (!session) return
    const runningAgents = {
      ...get().runningAgents,
      [session.id]: { sessionId: session.id, worktreePath, agent: trimmed, startedAt: new Date().toISOString(), state: 'working' as const }
    }
    set({ runningAgents })
    get().writeTerminal(session.id, `${trimmed}\n`)
  },

  stopAgent(sessionId: string) {
    get().interruptTerminal(sessionId)
    // ^C kills the foreground agent; the shell (and PTY) survive, so exit may never
    // fire — clear the chip optimistically; a still-running process re-renders nothing.
    const runningAgents = { ...get().runningAgents }
    delete runningAgents[sessionId]
    set({ runningAgents })
    persistSessionSoon()
  },

  /** Clear a finished (done/cancelled) agent chip without touching the terminal. */
  dismissAgent(sessionId: string) {
    const runningAgents = { ...get().runningAgents }
    delete runningAgents[sessionId]
    set({ runningAgents })
    persistSessionSoon()
  },

  async setSettings(patch: Partial<AppSettings>) {
    try {
      const settings = await window.orca.setSettings(patch)
      set({ settings, error: null })
    } catch (e) {
      set({ error: String(e) })
    }
  },

  setPaletteOpen(open: boolean) {
    set({ paletteOpen: open })
  },

  setSettingsOpen(open: boolean) {
    set({ settingsOpen: open })
  },

  openSettings(section: SettingsSection) {
    set({ settingsOpen: true, settingsSection: section })
  },

  setSidebarOpen(open: boolean) {
    set({ sidebarOpen: open })
  },

  setRightSidebarOpen(open: boolean) {
    set({ rightSidebarOpen: open })
  },

  setSidebarWidth(w: number) {
    set({ sidebarWidth: Math.min(500, Math.max(220, Math.round(w))) })
    persistSessionSoon()
  },

  setRightSidebarWidth(w: number) {
    set({ rightSidebarWidth: Math.min(620, Math.max(240, Math.round(w))) })
    persistSessionSoon()
  },

  resizeSplit(worktreePath: string, splitId: number, pct: number) {
    const prev = get().layouts[worktreePath]
    if (!prev) return
    const clamped = Math.min(85, Math.max(15, pct))
    const next = setSplitSizeById(prev, splitId, clamped, { n: 0 })
    set((s) => ({ layouts: { ...s.layouts, [worktreePath]: next } }))
    persistSessionSoon()
  },

  setRightSidebarTab(tab: 'explorer' | 'git') {
    set({ rightSidebarOpen: true, rightSidebarTab: tab })
  },

  setCreateOpen(open: boolean) {
    set({ createOpen: open })
  },

  setDeleteTarget(path: string | null) {
    set({ deleteTarget: path })
  },

  setActiveRepo(repoId: string | null) {
    set({ activeRepoId: repoId, activeWorktreePath: null })
    if (repoId) {
      const repo = get().repos.find((r) => r.repo.id === repoId)
      void repo
    }
    persistSessionSoon()
  },

  setActiveWorktree(path: string | null) {
    set({ activeWorktreePath: path })
    if (path) {
      void get().loadExplorer(path)
      // Orca activation-terminal-prep: every worktree gets a shell ready on first visit.
      const hasTerminal = (get().panes[path] ?? []).some((p) => p.kind === 'terminal')
      if (!hasTerminal) void get().openTerminal(path)
    }
    persistSessionSoon()
  },
  applyTerminalExit(sessionId: string, _exitCode: number) {
    const s = get()
    // A dead shell closes its pane — no zombie tabs (VS Code/Orca behavior).
    const panes: Record<string, Pane[]> = {}
    let ownerWt: string | null = null
    for (const [wt, list] of Object.entries(s.panes)) {
      const next = list.filter((p) => p.sessionId !== sessionId)
      if (next.length) panes[wt] = next
      if (next.length !== list.length) ownerWt = wt
    }
    // Prune the split tree so no leaf points at the removed pane.
    let layouts = s.layouts
    if (ownerWt && layouts[ownerWt]) {
      const paneKey = `term:${sessionId}`
      const next = removeLeaf(layouts[ownerWt], paneKey)
      layouts = { ...layouts }
      if (next) layouts[ownerWt] = next
      else delete layouts[ownerWt]
    }
    const terminals = { ...s.terminals }
    delete terminals[sessionId]
    const terminalOrder: Record<string, string[]> = {}
    for (const [wt, ids] of Object.entries(s.terminalOrder)) {
      const next = ids.filter((id) => id !== sessionId)
      if (next.length) terminalOrder[wt] = next
    }
    // Fix dangling active references: fall back to the first remaining pane.
    const activePane: Record<string, string> = {}
    for (const [wt, key] of Object.entries(s.activePane)) {
      const list = panes[wt]
      if (list?.some((p) => p.key === key)) activePane[wt] = key
      else if (list?.length) activePane[wt] = list[0]!.key
    }
    const activeTerminal: Record<string, string> = {}
    for (const [wt, id] of Object.entries(s.activeTerminal)) {
      if (id !== sessionId && terminals[id]) activeTerminal[wt] = id
      else {
        const fallback = terminalOrder[wt]?.[0]
        if (fallback) activeTerminal[wt] = fallback
      }
    }
    // exit ends the agent run: drop the row so the chip/Stop bar clears
    const runningAgents = { ...s.runningAgents }
    delete runningAgents[sessionId]
    terminalBus.dropSession(sessionId)
    set({
      panes,
      terminals,
      terminalOrder,
      activePane,
      activeTerminal,
      runningAgents,
      layouts
    })
    persistSessionSoon()
  },

  applyTerminalTitle(sessionId: string, title: string) {
    set((s) => ({
      terminals: Object.fromEntries(
        Object.entries(s.terminals).map(([id, t]) => [
          id,
          id === sessionId ? { ...t, session: { ...t.session, title } } : t
        ])
      )
    }))
  },

  setError(err: string | null) {
    set({ error: err })
  },
  applyAgentHook(sessionId: string, state: string, detail: string) {
    set((s) => {
      const agent = s.runningAgents[sessionId]
      if (!agent) return {}
      const known = ['working', 'permission', 'done', 'note'] as const
      if (!known.includes(state as (typeof known)[number])) return {}
      const runningAgents = { ...s.runningAgents, [sessionId]: { ...agent, state: state as (typeof known)[number], detail: detail || undefined } }
      if (agent.state === state) return {}
      persistSessionSoon()
      return { runningAgents }
    })
  }
}))

/** Debounced workspace-session persist: per-repo slice of user intent only. */
let persistTimer: ReturnType<typeof setTimeout> | undefined = undefined
type WorkspaceSession = NonNullable<PersistedState['workspaceSession']>
export function persistSessionSoon(): void {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = undefined
    const s = useAppStore.getState()
    if (!s.activeRepoId) return
    const repos: WorkspaceSession['repos'] = {}
    for (const r of s.repos) {
      const wtPaths = new Set(r.worktrees.map((w) => w.path))
      const pick = <T,>(rec: Record<string, T>): Record<string, T> =>
        Object.fromEntries(Object.entries(rec).filter(([p]) => wtPaths.has(p)))
      repos[r.repo.id] = {
        panes: pick(s.panes),
        activePane: pick(s.activePane),
        activeTerminal: pick(s.activeTerminal),
        terminalOrder: pick(s.terminalOrder),
        layouts: pick(s.layouts),
        activeWorktreePath: s.activeWorktreePath && wtPaths.has(s.activeWorktreePath) ? s.activeWorktreePath : null
      }
    }
    void window.orca.saveWorkspaceSession({
      activeRepoId: s.activeRepoId,
      repos,
      runningAgents: s.runningAgents,
      ui: { sidebarWidth: s.sidebarWidth, rightSidebarWidth: s.rightSidebarWidth }
    })
  }, 400)
}

// Dev/E2E seam (Orca's own convention, REBUILD_SPEC §9): window.__store exposes
// the live store for driving tests and debugging — never referenced by product code.
declare global {
  interface Window {
    __store?: typeof useAppStore
  }
}
if (typeof window !== 'undefined') {
  window.__store = useAppStore
}