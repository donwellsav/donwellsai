import type { AgentExecutable } from '@shared/agent-runtime'
import { restoreWorkspaceLayout, workspacePreset, splitWorkspaceLayout, resizeWorkspaceSplit, type WorkspaceLayout, type WorkspacePreset } from './workspace-layout'
import { ensureNavigationHistoryInitialized, getPersistedNavigationHistory } from './navigation-history'
import { projectRemovalBlockers } from './project-removal'
import { create } from 'zustand'
import { mediaPreviewDescriptorForPath } from '@shared/media-preview'
import { DEFAULT_SETTINGS, resolveSettings } from '@shared/settings'
import {
  disposePreviewModel,
  disposePreviewModelsUnder,
  flushPreviewModel,
  getEditorDocument,
  runWithEditorGuard
} from './editor-models'
import { deleteDocumentViewStates, moveDocumentViewStates } from './document-view-state'
import { normalizeBrowserUrl } from './browser-routing'
import type {
  AgentPreset,
  AppSettings,
  DiffComparison,
  FileContent,
  FileEntry,
  PersistedState,
  PreviewMode,
  RepoSummary,
  RunningAgent,
  RunsSection,
  SettingsSection,
  TerminalSession,
  WorktreeStatus
} from '@shared/types'
import { terminalBus } from './terminal-bus'
import {
  EMPTY_WORKSPACE_NAVIGATION,
  moveWorkspaceNavigation,
  normalizeWorkspaceNavigation,
  renameWorkspaceNavigation,
  restoreWorkspaceNavigation,
  toggleNavigationValue,
  type WorkspaceNavigationState
} from './workspace-navigation'

type TerminalView = {
  session: TerminalSession
  /** current cols/rows the xterm instance is rendered at (for resize sync) */
  cols: number
  rows: number
}

/** A pane inside a worktree: terminal tab, preview, or embedded browser. */
export type PaneKind = 'terminal' | 'explorer' | 'git-status' | 'preview' | 'diff' | 'browser' | 'memory' | 'recovery' | 'search' | 'computer'
export type Pane = {
  key: string
  kind: PaneKind
  sessionId?: string
  file?: string
  comparison?: DiffComparison
  /** browser pane start URL */
  url?: string
  /** Stable user-facing pane label. Terminal OSC titles remain live metadata. */
  label?: string
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

export type ExplorerDirectoryState = {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  entries: FileEntry[]
  error?: string
  truncated: boolean
  requestId: number
}

export type ExplorerWorkspaceState = {
  directories: Record<string, ExplorerDirectoryState>
  expanded: string[]
  selected: string | null
  showHidden: boolean
  includeIgnored: boolean
}

export type DocumentNavigationTarget = {
  generation: number
  mode?: PreviewMode
  line?: number
  column?: number
  anchor?: string
}

function emptyExplorerWorkspace(): ExplorerWorkspaceState {
  return { directories: {}, expanded: [], selected: null, showHidden: false, includeIgnored: false }
}

function parentDirectory(relPath: string): string {
  const index = relPath.lastIndexOf('/')
  return index < 0 ? '' : relPath.slice(0, index)
}

function replacePathPrefix(relPath: string, sourcePath: string, destinationPath: string): string {
  return relPath === sourcePath ? destinationPath : destinationPath + relPath.slice(sourcePath.length)
}

function previewFileContent(worktreePath: string, relPath: string): Promise<FileContent> {
  if (mediaPreviewDescriptorForPath(relPath)) {
    return Promise.resolve({ path: relPath, content: '', truncated: false, bytes: 0 })
  }
  return window.donwells.readFile(worktreePath, relPath)
}

const PREVIEW_KEY_SEPARATOR = String.fromCharCode(0)
const previewRequests = new Map<string, symbol>()
let explorerRequestSequence = 0

function beginPreviewRequest(worktreePath: string, relPath: string): { key: string; token: symbol } {
  const key = worktreePath + PREVIEW_KEY_SEPARATOR + relPath
  const token = Symbol(key)
  previewRequests.set(key, token)
  return { key, token }
}

function invalidatePreviewRequestsUnder(worktreePath: string, relPath?: string): void {
  const worktreePrefix = worktreePath + PREVIEW_KEY_SEPARATOR
  for (const key of previewRequests.keys()) {
    if (!key.startsWith(worktreePrefix)) continue
    const file = key.slice(worktreePrefix.length)
    if (relPath === undefined || file === relPath || file.startsWith(relPath + '/')) previewRequests.delete(key)
  }
}

export function layoutHasLeaf(node: LayoutNode, key: string): boolean {
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
function setSplitSizeById(node: LayoutNode, targetId: number, pct: number, cursor: { n: number; found: boolean }): LayoutNode {
  if (node.kind === 'leaf') return node
  const id = cursor.n++
  if (id === targetId) {
    cursor.found = true
    return node.size === pct ? node : { ...node, size: pct }
  }
  const first = setSplitSizeById(node.first, targetId, pct, cursor)
  if (cursor.found) return first === node.first ? node : { ...node, first }
  const second = setSplitSizeById(node.second, targetId, pct, cursor)
  return second === node.second ? node : { ...node, second }
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
  initializationError: string | null
  activeRepoId: string | null
  /** the worktree path a card is expanded/arrowed; null = main worktree */
  activeWorktreePath: string | null

  /** live git status per worktree path (polled) */
  statuses: Record<string, WorktreeStatus>
  /** per-worktree scan: listening ports + cpu/mem usage (polled; upstream status segments) */
  scans: Record<string, { ports: Array<{ port: number; pid: number; command: string }>; cpuPercent: number; memMB: number }>
  /** Controlled, lazily loaded explorer state per worktree. */
  explorer: Record<string, ExplorerWorkspaceState>
  /** open editor buffers: worktree path → file relPath → versioned content (+ markdown view mode) */
  previews: Record<string, Record<string, FileContent & { v: number; mode?: PreviewMode }>>
  documentNavigation: Record<string, Record<string, DocumentNavigationTarget>>
  fileSearchMru: Record<string, string[]>
  contentSearch: { source?: 'all' | 'file' | 'code' | 'document' | 'memory' | 'session'; query: string; hidden: boolean; ignored: boolean; graphQuery?: string; graphOpen?: boolean }
  gitCommitDrafts: Record<string, string>
  /** loading flags */
  busy: Record<string, boolean>

  /** Terminal records keyed by session ID; each session owns its worktree. */
  terminals: Record<string, TerminalView>
  /** RCU order of open terminals per worktree path */
  terminalOrder: Record<string, string[]>
  /** Persisted sidebar organization; all arrays use stable repo ids or workspace paths. */
  workspaceNavigation: WorkspaceNavigationState
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
  /** Monotonic renderer revision used to reject drafts based on stale RPC state. */
  settingsRevision: number
  /** split-tree layout per worktree path; undefined = flat single active pane */
  layouts: Record<string, LayoutNode>
  docking: Record<string, WorkspaceLayout>
  paletteOpen: boolean
  paletteMode: 'commands' | 'files'
  settingsOpen: boolean
  runsOpen: boolean
  runsSection: RunsSection

  /** which settings section the modal shows (nav rail selection; deep-linkable) */
  settingsSection: SettingsSection
  /** app chrome (upstream shell state) */
  sidebarOpen: boolean
  sidebarWidth: number
  rightSidebarWidth: number
  rightSidebarOpen: boolean
  rightSidebarTab: 'explorer' | 'git' | 'memory' | 'recovery' | 'search' | 'computer'
  createOpen: boolean
  /** worktree path pending styled delete confirmation (null = closed) */
  deleteTarget: string | null
  closeRequest: { worktreePath: string; key: string; sessionId: string; label: string } | null
  load(): Promise<void>
  addRepo(dir: string): Promise<void>
  openImportedProject(repoId: string): Promise<void>
  openProject(summary: RepoSummary): void
  removeRepo(repoId: string): Promise<{ ok: true } | { ok: false; error: string }>
  /** Re-pull the repo list after a CLI/RPC client mutates repos behind our back. */
  syncRepos(): Promise<void>
  refresh(repoId?: string): Promise<void>
  createWorktree(repoId: string, name?: string, branch?: string): Promise<{ ok: true } | { ok: false; error: string }>
  removeWorktree(worktreePath: string, force?: boolean): Promise<{ ok: true } | { ok: false; error: string }>
  setDeleteTarget(path: string | null): void
  openProjectTaskTool(worktreePath: string, tool: 'lazygit' | 'backlog'): Promise<void>
  openTerminal(worktreePath: string): Promise<TerminalSession | null>
  closeTerminal(worktreePath: string, sessionId: string): Promise<boolean>
  writeTerminal(sessionId: string, data: string): void
  interruptTerminal(sessionId: string): void
  resizeTerminal(sessionId: string, cols: number, rows: number): void
  togglePane(worktreePath: string, kind: 'explorer' | 'git-status'): void
  closePane(worktreePath: string, key: string): Promise<boolean>
  saveDocking(worktreePath: string, layout: WorkspaceLayout): void
  arrangeWorkspace(worktreePath: string, preset: WorkspacePreset): void
  hidePaneView(worktreePath: string, key: string): void
  openWorkspaceModule(worktreePath: string, kind: 'explorer' | 'git-status' | 'memory' | 'recovery' | 'search' | 'computer'): void
  requestClosePane(worktreePath: string, key: string): void
  confirmClosePane(): Promise<void>
  cancelClosePane(): void
  setActivePane(worktreePath: string, key: string): void
  focusRelativePane(worktreePath: string, delta: -1 | 1): void
  reorderPane(worktreePath: string, sourceKey: string, targetKey: string): void
  renamePane(worktreePath: string, key: string, label: string): void
  splitTerminal(worktreePath: string, direction?: 'row' | 'col'): Promise<TerminalSession | null>
  selectTerminal(worktreePath: string, sessionId: string): void

  refreshExplorer(worktreePath: string, directory?: string): Promise<void>
  setExplorerExpanded(worktreePath: string, directory: string, expanded: boolean): void
  setExplorerSelected(worktreePath: string, relPath: string | null): void
  setExplorerVisibility(worktreePath: string, options: { showHidden?: boolean; includeIgnored?: boolean }): void
  collapseExplorer(worktreePath: string): void
  createWorkspaceEntry(worktreePath: string, relPath: string, kind: 'file' | 'directory'): Promise<boolean>
  moveWorkspaceEntry(worktreePath: string, sourcePath: string, destinationPath: string): Promise<boolean>
  duplicateWorkspaceEntry(worktreePath: string, sourcePath: string, destinationPath: string): Promise<boolean>
  deleteWorkspaceEntry(worktreePath: string, relPath: string): Promise<boolean>
  openPreview(worktreePath: string, relPath: string, navigation?: Omit<DocumentNavigationTarget, 'generation'>): Promise<boolean>
  reloadOpenPreviews(worktreePath: string, relPaths?: readonly string[]): Promise<void>
  /** HEAD↔worktree diff editor for one file (component loads its own content). */
  openDiff(worktreePath: string, relPath: string, comparison?: DiffComparison): void
  /** Switch an open editor pane to another file (tab switch semantics). */
  retargetPreview(worktreePath: string, paneKey: string, relPath: string): Promise<void>
  openBrowser(worktreePath: string, url: string): void
  noteBrowserNavigation(worktreePath: string, url: string): void
  writePreview(worktreePath: string, relPath: string, content: string): Promise<FileContent>
  /** Acknowledgements never advance the external-write epoch. */
  ackPreviewSave(worktreePath: string, relPath: string, saved: FileContent, sourceEpoch: number): void
  /** Close one file (relPath) or every editor of the worktree when omitted. */
  closePreview(worktreePath: string, relPath?: string): Promise<boolean>
  /** Set an editor buffer's view mode (markdown files: 'edit' source / 'preview' rendered). */
  setPreviewMode(worktreePath: string, relPath: string, mode: PreviewMode): Promise<boolean>
  pruneRemovedRepos(): void
  refreshStatuses(): Promise<void>
  /** Scan ports + resource usage for the active worktree (status segments). */
  refreshScan(worktreePath: string): Promise<void>

  focusAgentSession(sessionId: string): Promise<boolean>
  runAgent(worktreePath: string, command: string | AgentExecutable, task?: import('@shared/agent-runtime').AgentTaskIntent): Promise<{ ok: true } | { ok: false; error: string }>
  stopAgent(sessionId: string): Promise<{ ok: true } | { ok: false; error: string }>
  dismissAgent(sessionId: string): Promise<{ ok: true } | { ok: false; error: string }>

  setPaletteOpen(open: boolean, mode?: 'commands' | 'files'): void
  setGitCommitDraft(worktreePath: string, value: string): void
  setSettingsOpen(open: boolean): void
  openSettings(section: SettingsSection): void
  openRuns(section?: RunsSection): void
  setRunsOpen(open: boolean): void
  syncSettings(settings: AppSettings): void
  setSettings(patch: Partial<AppSettings>): Promise<{ ok: true } | { ok: false; error: string }>
  setSidebarOpen(open: boolean): void
  setSidebarWidth(w: number): void
  setRightSidebarWidth(w: number): void
  resizeSplit(worktreePath: string, splitId: number, pct: number): number | null
  setRightSidebarOpen(open: boolean): void
  setRightSidebarTab(tab: 'explorer' | 'git' | 'memory' | 'recovery' | 'search' | 'computer'): void
  setCreateOpen(open: boolean): void

  toggleRepoCollapsed(repoId: string): void
  toggleWorkspacePinned(path: string): void
  renameWorkspace(path: string, label: string): void
  hideWorkspace(path: string): void
  restoreWorkspace(path?: string): void
  moveWorkspace(path: string, delta: -1 | 1): void

  setActiveRepo(repoId: string | null): void
  setActiveWorktree(path: string | null): void
  applyTerminalExit(sessionId: string, exitCode?: number): void
  applyTerminalTitle(sessionId: string, title: string): void
  setError(err: string | null): void
  applyAgentRun(run: RunningAgent): void
  applyAgentDismissed(sessionId: string): void
}

/** Restore per-workspace panes while reconciling them with daemon-owned PTYs and agent runs. */
async function restoreSession(
  saved: NonNullable<PersistedState['workspaceSession']> | null,
  repos: RepoSummary[],
  state: Partial<AppState>,
  agentRuns: RunningAgent[]
): Promise<void> {
  const restored: {
    panes: Record<string, Pane[]>
    activePane: Record<string, string>
    activeTerminal: Record<string, string>
    terminalOrder: Record<string, string[]>
    terminals: Record<string, TerminalView>
    layouts: Record<string, LayoutNode>
  } = { panes: {}, activePane: {}, activeTerminal: {}, terminalOrder: {}, terminals: {}, layouts: {} }
  const liveSessions = await window.donwells.terminalSessions()
  const restoredPreviews: Record<string, Record<string, FileContent & { v: number }>> = {}
  const liveById = new Map(liveSessions.map((session) => [session.id, session]))
  const worktreePaths = new Set(repos.flatMap((repo) => repo.worktrees.map((worktree) => worktree.path)))
  const managedAgentIds = new Set<string>()
  for (const run of agentRuns) managedAgentIds.add(run.sessionId)
  const savedRepos = saved?.repos ?? {}

  for (const repo of repos) {
    const savedRepo = savedRepos[repo.repo.id]
    if (!savedRepo) continue
    for (const [worktreePath, panes] of Object.entries(savedRepo.panes)) {
      if (!worktreePaths.has(worktreePath)) continue
      const valid: Pane[] = []
      const seen = new Set<string>()
      for (const pane of panes) {
        if (seen.has(pane.key)) { state.error = 'Duplicate saved panel references were removed.'; continue }
        seen.add(pane.key)
        if (pane.kind !== 'terminal') {
          if (pane.kind === 'preview' && pane.file) {
            try {
              const files = (restoredPreviews[worktreePath] ??= {})
              if (pane.file in files) {
                valid.push(pane)
                continue
              }
              if (Object.keys(files).length >= 12) continue
              const content = await previewFileContent(worktreePath, pane.file)
              files[pane.file] = { ...content, v: 0 }
            } catch (cause) {
              state.error = `Could not restore ${pane.file}: ${String(cause)}. Any protected draft remains in Recover.`
              continue
            }
          }
          valid.push(pane)
          continue
        }
        const live = pane.sessionId ? liveById.get(pane.sessionId) : undefined
        if (live && pane.sessionId && (!live.exited || managedAgentIds.has(pane.sessionId))) {
          valid.push(pane)
          restored.terminals[pane.sessionId] ??= { session: live, cols: 100, rows: 30 }
          continue
        }
        // Lost shells may be replaced; managed agents require a daemon-owned PTY.
        if (pane.sessionId && managedAgentIds.has(pane.sessionId)) continue
        try {
          const fresh = await window.donwells.openTerminal(worktreePath, worktreePath)
          restored.terminals[fresh.id] = { session: fresh, cols: 100, rows: 30 }
          valid.push({ ...pane, key: pane.sessionId ? 'term:' + fresh.id : pane.key, sessionId: fresh.id })
        } catch {
          // The workspace disappeared; dropping only this pane preserves siblings.
        }
      }
      if (!valid.length) continue
      restored.panes[worktreePath] = valid
      restored.terminalOrder[worktreePath] = valid.flatMap((pane) => pane.sessionId ? [pane.sessionId] : [])
      const savedLayout = savedRepo.layouts?.[worktreePath]
      if (savedLayout) {
        const pruned = pruneLayoutTo(savedLayout, new Set(valid.map((pane) => pane.key)))
        if (pruned) restored.layouts[worktreePath] = pruned
      }
    }
    restored.activePane = { ...restored.activePane, ...savedRepo.activePane }
    restored.activeTerminal = { ...restored.activeTerminal, ...savedRepo.activeTerminal }
  }

  // Retained agent output remains inspectable until explicit dismissal.
  for (const run of agentRuns) {
    const live = liveById.get(run.sessionId)
    if (!live || !worktreePaths.has(run.workspacePath)) continue
    restored.terminals[run.sessionId] ??= { session: live, cols: 100, rows: 30 }
    const workspacePanes = restored.panes[run.workspacePath] ?? []
    const key = 'term:' + run.sessionId
    if (!workspacePanes.some((pane) => pane.key === key)) {
      const terminalNumber = workspacePanes.filter((pane) => pane.kind === 'terminal').length + 1
      workspacePanes.push({ key, kind: 'terminal', sessionId: run.sessionId, label: 'Terminal ' + terminalNumber })
    }
    restored.panes[run.workspacePath] = workspacePanes
    const order = restored.terminalOrder[run.workspacePath] ?? []
    if (!order.includes(run.sessionId)) restored.terminalOrder[run.workspacePath] = [...order, run.sessionId]
    restored.activePane[run.workspacePath] ??= key
    restored.activeTerminal[run.workspacePath] ??= run.sessionId
  }

  state.docking = {}
  for (const repo of repos) for (const worktree of repo.worktrees) {
    const savedLayout = savedRepos[repo.repo.id]?.docking?.[worktree.path]
    const result = restoreWorkspaceLayout(savedLayout, restored.panes[worktree.path] ?? [], restored.layouts[worktree.path])
    state.docking[worktree.path] = result.layout
    if (result.recovered) state.error = 'Some saved panel references were invalid. Existing resources were recovered into a usable layout.'
  }
  state.panes = restored.panes
  state.activePane = restored.activePane
  state.activeTerminal = restored.activeTerminal
  state.terminalOrder = restored.terminalOrder
  state.terminals = restored.terminals
  state.previews = restoredPreviews
  state.layouts = restored.layouts
  state.fileSearchMru = Object.fromEntries(
    Object.entries(saved?.fileSearchMru ?? {}).filter(([worktreePath]) => worktreePaths.has(worktreePath))
  )
  state.gitCommitDrafts = Object.fromEntries(
    Object.entries(saved?.gitCommitDrafts ?? {}).filter(([worktreePath]) => worktreePaths.has(worktreePath))
  )
  const savedActive = savedRepos[state.activeRepoId ?? '']?.activeWorktreePath
  state.activeWorktreePath = savedActive && worktreePaths.has(savedActive) ? savedActive : null
}

function activateTerminalSession(state: AppState, session: TerminalSession): Partial<AppState> {
  const worktreePath = session.worktreePath
  const key = 'term:' + session.id
  const previous = state.panes[worktreePath] ?? []
  const cardPanes = [...previous]
  if (!cardPanes.some((pane) => pane.key === key)) {
    const terminalNumber = cardPanes.filter((pane) => pane.kind === 'terminal').length + 1
    cardPanes.push({ key, kind: 'terminal', sessionId: session.id, label: 'Terminal ' + terminalNumber })
  }
  const previousOrder = state.terminalOrder[worktreePath] ?? []
  const terminalOrder = previousOrder.includes(session.id) ? previousOrder : [...previousOrder, session.id]
  return {
    terminals: { ...state.terminals, [session.id]: { cols: state.terminals[session.id]?.cols ?? 100, rows: state.terminals[session.id]?.rows ?? 30, session } },
    terminalOrder: { ...state.terminalOrder, [worktreePath]: terminalOrder },
    panes: { ...state.panes, [worktreePath]: cardPanes },
    activePane: { ...state.activePane, [worktreePath]: key },
    activeTerminal: { ...state.activeTerminal, [worktreePath]: session.id },
    activeWorktreePath: worktreePath,
    ...(state.docking[worktreePath]?.hidden.includes(key) ? { docking: { ...state.docking, [worktreePath]: { ...state.docking[worktreePath]!, hidden: state.docking[worktreePath]!.hidden.filter(item => item !== key) } } } : {}),
    error: null
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  repos: [],
  loading: true,
  error: null,
  initializationError: null,
  activeRepoId: null,
  activeWorktreePath: null,
  statuses: {},
  scans: {},
  explorer: {},
  previews: {},
  documentNavigation: {},
  fileSearchMru: {},
  contentSearch: { query: '', hidden: false, ignored: false },
  gitCommitDrafts: {},
  busy: {},
  settings: structuredClone(DEFAULT_SETTINGS),
  settingsRevision: 0,
  terminals: {},
  terminalOrder: {},
  workspaceNavigation: structuredClone(EMPTY_WORKSPACE_NAVIGATION),
  panes: {},
  layouts: {},
  docking: {},
  activePane: {},
  activeTerminal: {},
  sidebarOpen: true,
  sidebarWidth: 280,
  rightSidebarWidth: 350,
  rightSidebarOpen: false,
  rightSidebarTab: 'explorer',
  createOpen: false,
  deleteTarget: null,
  closeRequest: null,
  paletteOpen: false,
  paletteMode: 'commands',
  settingsOpen: false,
  runsOpen: false,
  runsSection: 'orchestration',
  settingsSection: 'agents',
  runningAgents: {},
  agents: [],

  async load() {
    set({ loading: true, initializationError: null })
    try {
      const settingsRevision = get().settingsRevision
      const [repos, agents, agentRuns, settings, wsSession] = await Promise.all([
        window.donwells.listRepos(),
        window.donwells.listAgents(),
        window.donwells.agentList(),
        window.donwells.getSettings(),
        window.donwells.getWorkspaceSession()
      ])
      const currentSettingsRevision = get().settingsRevision
      const acceptLoadedSettings = currentSettingsRevision === settingsRevision
      const state: Partial<AppState> = {
        repos,
        agents,
        runningAgents: Object.fromEntries(agentRuns.map((run) => [run.sessionId, run])),
        workspaceNavigation: normalizeWorkspaceNavigation(wsSession?.workspaceNav, repos),
        settings: acceptLoadedSettings ? resolveSettings(settings) : get().settings,
        settingsRevision: acceptLoadedSettings ? currentSettingsRevision + 1 : currentSettingsRevision,
        loading: false,
        error: null,
        initializationError: null
      }
      const saved = wsSession ?? null
      if (saved?.activeRepoId && repos.some((r) => r.repo.id === saved.activeRepoId)) {
        state.activeRepoId = saved.activeRepoId
      } else if (repos.length > 0) {
        state.activeRepoId = repos[0]!.repo.id
      }
      // Session reconciliation completes before the renderer publishes state,
      // so live agent terminals never flash as missing after a restart.
      await restoreSession(saved, repos, state, agentRuns)
      set(state)
      const ui = saved?.ui
      if (ui) {
        set({
          sidebarWidth: ui.sidebarWidth ?? get().sidebarWidth,
          rightSidebarWidth: ui.rightSidebarWidth ?? get().rightSidebarWidth,
        })
      }
      if (repos.length > 0) void get().refreshStatuses()
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause)
      set({ loading: false, initializationError: error, error })
    }
  },

  async openImportedProject(repoId: string) {
    if (get().repos.some(repo => repo.repo.id === repoId)) throw new Error('Restored project is already open')
    const summary = await window.donwells.refreshRepo(repoId), path = summary.repo.path
    const saved = await window.donwells.getWorkspaceSession()
    const restored: Partial<AppState> = { activeRepoId: summary.repo.id }
    await restoreSession(saved ?? null, [summary], restored, [])
    set(state => ({
      repos: [...state.repos, summary], activeRepoId: summary.repo.id, activeWorktreePath: path,
      panes: { ...state.panes, ...restored.panes }, activePane: { ...state.activePane, ...restored.activePane },
      activeTerminal: { ...state.activeTerminal, ...restored.activeTerminal }, terminalOrder: { ...state.terminalOrder, ...restored.terminalOrder },
      terminals: { ...state.terminals, ...restored.terminals }, docking: { ...state.docking, ...restored.docking },
      layouts: { ...state.layouts, ...restored.layouts }, error: restored.error ?? null
    }))
  },

  openProject(summary: RepoSummary) {
    set((state) => {
      const repos = [...state.repos.filter((repo) => repo.repo.id !== summary.repo.id), summary]
      return {
        repos,
        activeRepoId: summary.repo.id,
        workspaceNavigation: normalizeWorkspaceNavigation(state.workspaceNavigation, repos),
        error: null
      }
    })
    get().setActiveWorktree(summary.worktrees.find((worktree) => worktree.isMain)?.path ?? summary.worktrees[0]?.path ?? null)
    void get().refreshStatuses()
  },

  async addRepo(dir: string) {
    try {
      get().openProject(await window.donwells.addRepo(dir))
    } catch (e) {
      set({ error: String(e) })
    }
  },

  async removeRepo(repoId: string) {
    const repo = get().repos.find((candidate) => candidate.repo.id === repoId)
    if (!repo) {
      const error = 'Project is no longer registered.'
      set({ error })
      return { ok: false as const, error }
    }

    const blockers = projectRemovalBlockers(repo, get())
    if (blockers.length > 0) {
      const error = 'Cannot remove project. ' + blockers.map((blocker) => blocker.message).join(' ')
      set({ error })
      return { ok: false as const, error }
    }

    try {
      await window.donwells.removeRepo(repoId)
      const repos = get().repos.filter((candidate) => candidate.repo.id !== repoId)
      const removingActive = get().activeRepoId === repoId
      set({
        repos,
        ...(removingActive ? { activeRepoId: repos[0]?.repo.id ?? null, activeWorktreePath: null } : {}),
        error: null
      })
      get().pruneRemovedRepos()
      return { ok: true as const }
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause)
      set({ error })
      return { ok: false as const, error }
    }
  },

  async syncRepos() {
    try {
      const repos = await window.donwells.listRepos()
      set((state) => ({
        repos,
        workspaceNavigation: normalizeWorkspaceNavigation(state.workspaceNavigation, repos),
        error: null
      }))
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
      const summary = await window.donwells.refreshRepo(id)
      set((state) => {
        const repos = state.repos.map((repo) => (repo.repo.id === id ? summary : repo))
        return {
          repos,
          workspaceNavigation: normalizeWorkspaceNavigation(state.workspaceNavigation, repos),
          error: null
        }
      })
      void get().refreshStatuses()
    } catch (e) {
      set({ error: String(e) })
    }
  },

  async createWorktree(repoId: string, name?: string, branch?: string) {
    const previous = get().repos.find((candidate) => candidate.repo.id === repoId)
    if (!previous || previous.repo.kind === 'folder') {
      const error = previous ? 'Worktrees require a Git project.' : 'Select a registered Git project.'
      set({ error })
      return { ok: false as const, error }
    }
    try {
      const summary = await window.donwells.createWorktree(repoId, { name, branch })
      const previousPaths = new Set(previous.worktrees.map((worktree) => worktree.path))
      const created = summary.worktrees.find((worktree) => !previousPaths.has(worktree.path))
      set((state) => {
        const repos = state.repos.map((repo) => (repo.repo.id === repoId ? summary : repo))
        return {
          repos,
          activeRepoId: repoId,
          workspaceNavigation: normalizeWorkspaceNavigation(state.workspaceNavigation, repos),
          error: null
        }
      })
      if (created) get().setActiveWorktree(created.path)
      return { ok: true as const }
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause)
      set({ error })
      return { ok: false as const, error }
    }
  },

  async removeWorktree(worktreePath: string, force = false) {
    const repo = get().repos.find((candidate) => candidate.worktrees.some((worktree) => worktree.path === worktreePath))
    const worktree = repo?.worktrees.find((candidate) => candidate.path === worktreePath)
    try {
      if (!repo || !worktree) throw new Error('The worktree is no longer registered.')
      if (worktree.isMain) throw new Error('The main workspace cannot be removed as a worktree.')
      const blockers = projectRemovalBlockers({ ...repo, worktrees: [worktree] }, get())
      if (blockers.length) throw new Error(blockers.map((blocker) => blocker.message).join(' '))
      await runWithEditorGuard(worktreePath, undefined, async () => {
        const [sessions, agents] = await Promise.all([window.donwells.terminalSessions(), window.donwells.agentList()])
        if (sessions.some((session) => session.worktreePath === worktreePath && !session.exited)) throw new Error('Close the live terminals in this worktree first.')
        if (agents.some((run) => run.workspacePath === worktreePath && run.liveness !== 'exited')) throw new Error('Stop or reconcile active agents in this worktree first.')
        const summary = await window.donwells.removeWorktree(repo.repo.id, worktreePath, force)
        const files = Object.keys(get().previews[worktreePath] ?? {})
        invalidatePreviewRequestsUnder(worktreePath)
        set((state) => ({
          repos: state.repos.map((candidate) => candidate.repo.id === repo.repo.id ? summary : candidate),
          activeWorktreePath: state.activeWorktreePath === worktreePath ? null : state.activeWorktreePath,
          error: null
        }))
        get().pruneRemovedRepos()
        for (const file of files) disposePreviewModel(worktreePath, file)
      })
      return { ok: true as const }
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause)
      set({ error })
      return { ok: false as const, error }
    }
  },

  async openProjectTaskTool(worktreePath: string, tool: 'lazygit' | 'backlog') {
    const session = await window.donwells.projectTaskTool(worktreePath, tool)
    set(state => ({ ...activateTerminalSession(state, session), runsOpen: false }))
    get().renamePane(worktreePath, 'term:' + session.id, tool === 'lazygit' ? 'Lazygit' : 'Backlog board')
    persistSessionSoon()
  },

  async openTerminal(worktreePath: string) {
    try {
      const session = await window.donwells.openTerminal(worktreePath)
      set((state) => activateTerminalSession(state, session))
      persistSessionSoon()
      return session
    } catch (error) {
      set({ error: 'Terminal open failed: ' + String(error) })
      return null
    }
  },

  async closeTerminal(worktreePath: string, sessionId: string) {
    try {
      const agent = get().runningAgents[sessionId]
      if (agent) {
        if (agent.liveness !== 'exited') {
          get().applyAgentRun(await window.donwells.agentStop(sessionId))
          return false
        }
        await window.donwells.agentDismiss(sessionId)
        get().applyAgentDismissed(sessionId)
        return true
      }
      await window.donwells.closeTerminal(sessionId)
    } catch (error) {
      set({ error: `Terminal close is unverifiable: ${String(error)}` })
      return false
    }
    set((s) => {
      const terminals = { ...s.terminals }
      delete terminals[sessionId]
      const previous = s.panes[worktreePath] ?? []
      const removedKeys = new Set(previous.filter((p) => p.sessionId === sessionId).map((p) => p.key))
      const cardPanes = previous.filter((p) => p.sessionId !== sessionId)
      const panes = { ...s.panes, [worktreePath]: cardPanes }
      const activePane = { ...s.activePane }
      const activeTerminal = { ...s.activeTerminal }
      const terminalOrder = { ...s.terminalOrder, [worktreePath]: (s.terminalOrder[worktreePath] ?? []).filter((id) => id !== sessionId) }
      if (activeTerminal[worktreePath] === sessionId) {
        activeTerminal[worktreePath] = cardPanes.find((p) => p.kind === 'terminal')?.sessionId ?? ''
      }
      if (removedKeys.has(activePane[worktreePath] ?? '')) {
        activePane[worktreePath] = cardPanes[0]?.key ?? ''
      }
      const layouts = { ...s.layouts }
      const previousLayout = layouts[worktreePath]
      if (previousLayout) {
        const next = pruneLayoutTo(previousLayout, new Set(cardPanes.map((p) => p.key)))
        if (next) layouts[worktreePath] = next
        else delete layouts[worktreePath]
      }
      return { terminals, panes, activePane, activeTerminal, terminalOrder, layouts, error: null }
    })
    terminalBus.dropSession(sessionId)
    persistSessionSoon()
    return true
  },


  writeTerminal(sessionId: string, data: string) {
    void window.donwells.terminalWrite(sessionId, data).catch((error: unknown) => {
      set({ error: 'Terminal input failed: ' + String(error) })
    })
  },

  interruptTerminal(sessionId: string) {
    void window.donwells.terminalInterrupt(sessionId).catch((error: unknown) => {
      set({ error: 'Terminal interrupt failed: ' + String(error) })
    })
  },

  resizeTerminal(sessionId: string, cols: number, rows: number) {
    const current = get().terminals[sessionId]
    if (!current) return
    set((s) => ({ terminals: { ...s.terminals, [sessionId]: { ...current, cols, rows } } }))
    void window.donwells.terminalResize(sessionId, cols, rows).catch((error: unknown) => {
      set({ error: 'Terminal resize failed: ' + String(error) })
    })
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
        if (kind === 'explorer') void get().refreshExplorer(worktreePath)
        if (kind === 'git-status') void get().refreshStatuses()
      }
      void prev
      return { panes, activePane }
    })
    persistSessionSoon()
  },

  async closePane(worktreePath: string, key: string) {
    // closing an editor pane means closing its file: buffers, tabs, and models
    const target = get().panes[worktreePath]?.find((p) => p.key === key)
    if (target?.kind === 'preview' && target.file) {
      return get().closePreview(worktreePath, target.file)
    }
    if (target?.sessionId) {
      return get().closeTerminal(worktreePath, target.sessionId)
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

      return { panes, activePane, layouts }
    })
    persistSessionSoon()
    return true
  },

  saveDocking(worktreePath, layout) {
    set(state => ({ docking: { ...state.docking, [worktreePath]: layout } }))
    persistSessionSoon()
  },

  arrangeWorkspace(worktreePath, preset) {
    get().saveDocking(worktreePath, workspacePreset(preset, get().panes[worktreePath] ?? [], get().activePane[worktreePath]))
  },

  hidePaneView(worktreePath, key) {
    const state = get(), panes = state.panes[worktreePath] ?? []
    if (!panes.some(pane => pane.key === key)) return
    const layout = restoreWorkspaceLayout(state.docking[worktreePath], panes, state.layouts[worktreePath]).layout
    const hidden = [...new Set([...layout.hidden, key])]
    get().saveDocking(worktreePath, restoreWorkspaceLayout({ ...layout, hidden }, panes).layout)
    if (state.activePane[worktreePath] === key) get().setActivePane(worktreePath, panes.find(pane => !hidden.includes(pane.key))?.key ?? '')
  },

  openWorkspaceModule(worktreePath, kind) {
    const key = `${kind}:${worktreePath}`
    if (!(get().panes[worktreePath] ?? []).some(pane => pane.key === key)) {
      set(state => ({ panes: { ...state.panes, [worktreePath]: [...(state.panes[worktreePath] ?? []), { key, kind }] } }))
    }
    get().setActivePane(worktreePath, key)
    set({ rightSidebarOpen: false })
  },

  requestClosePane(worktreePath: string, key: string) {
    const target = get().panes[worktreePath]?.find((pane) => pane.key === key)
    const terminal = target?.sessionId ? get().terminals[target.sessionId] : undefined
    if (target?.sessionId && terminal && !terminal.session.exited) {
      set({
        closeRequest: {
          worktreePath,
          key,
          sessionId: target.sessionId,
          label: target.label ?? terminal.session.title ?? 'Terminal'
        }
      })
      return
    }
    void get().closePane(worktreePath, key)
  },

  async confirmClosePane() {
    const request = get().closeRequest
    if (!request) return
    if (await get().closePane(request.worktreePath, request.key)) set({ closeRequest: null })
  },

  cancelClosePane() {
    set({ closeRequest: null })
  },

  setActivePane(worktreePath: string, key: string) {
    const current = get()
    if (current.activePane[worktreePath] === key && !current.runsOpen && !current.docking[worktreePath]?.hidden.includes(key)) return
    set((s) => {
      const p = s.panes[worktreePath]?.find((x) => x.key === key)
      return {
        runsOpen: false,
        ...(s.docking[worktreePath]?.hidden.includes(key) ? { docking: { ...s.docking, [worktreePath]: { ...s.docking[worktreePath]!, hidden: s.docking[worktreePath]!.hidden.filter(item => item !== key) } } } : {}),
        activePane: { ...s.activePane, [worktreePath]: key },
        ...(p?.sessionId ? { activeTerminal: { ...s.activeTerminal, [worktreePath]: p.sessionId } } : {})
      }
    })
    persistSessionSoon()
  },

  focusRelativePane(worktreePath: string, delta: -1 | 1) {
    const panes = (get().panes[worktreePath] ?? []).filter((pane) =>
      !get().docking[worktreePath]?.hidden.includes(pane.key)
    )
    if (!panes.length) return
    const current = panes.findIndex((pane) => pane.key === get().activePane[worktreePath])
    const next = panes[(current < 0 ? 0 : current + delta + panes.length) % panes.length]
    if (next) get().setActivePane(worktreePath, next.key)
  },

  reorderPane(worktreePath: string, sourceKey: string, targetKey: string) {
    if (sourceKey === targetKey) return
    set((state) => {
      const previous = state.panes[worktreePath] ?? []
      const source = previous.find((pane) => pane.key === sourceKey)
      if (!source || !previous.some((pane) => pane.key === targetKey)) return {}
      const panes = previous.filter((pane) => pane.key !== sourceKey)
      const insertAt = panes.findIndex((pane) => pane.key === targetKey)
      panes.splice(insertAt < 0 ? panes.length : insertAt, 0, source)
      return {
        panes: { ...state.panes, [worktreePath]: panes },
        terminalOrder: {
          ...state.terminalOrder,
          [worktreePath]: panes.flatMap((pane) => pane.sessionId ? [pane.sessionId] : [])
        }
      }
    })
    persistSessionSoon()
  },

  renamePane(worktreePath: string, key: string, label: string) {
    const normalized = label.trim().replace(/\s+/g, ' ').slice(0, 80)
    set((state) => ({
      panes: {
        ...state.panes,
        [worktreePath]: (state.panes[worktreePath] ?? []).map((pane) =>
          pane.key === key ? { ...pane, label: normalized || undefined } : pane
        )
      }
    }))
    persistSessionSoon()
  },

  async splitTerminal(worktreePath: string, direction) {
    const state = get()
    const activeKey = state.activePane[worktreePath]
    if (!activeKey || !state.panes[worktreePath]?.some((pane) => pane.key === activeKey)) {
      set({ error: 'Select a pane before splitting this workspace.' })
      return null
    }
    const session = await get().openTerminal(worktreePath)
    if (!session) return null
    const newKey = 'term:' + session.id
    const dir = direction ?? (window.innerWidth < 900 ? 'col' : 'row')
    set((current) => {
      if (current.docking[worktreePath]) return { docking: { ...current.docking, [worktreePath]: splitWorkspaceLayout(current.docking[worktreePath]!, current.panes[worktreePath] ?? [], activeKey, newKey, dir) } }
      const previous = current.layouts[worktreePath]
      let next: LayoutNode
      if (!previous) {
        next = { kind: 'split', dir, first: { kind: 'leaf', pane: activeKey }, second: { kind: 'leaf', pane: newKey } }
      } else {
        const inserted = insertAt(previous, activeKey, newKey)
        next = inserted ?? { kind: 'split', dir, first: previous, second: { kind: 'leaf', pane: newKey } }
      }
      return { layouts: { ...current.layouts, [worktreePath]: next } }
    })
    get().selectTerminal(worktreePath, session.id)
    persistSessionSoon()
    return session
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

  async refreshExplorer(worktreePath: string, directory = '') {
    const workspace = get().explorer[worktreePath] ?? emptyExplorerWorkspace()
    const previous = workspace.directories[directory]
    const requestId = ++explorerRequestSequence
    set((state) => ({
      explorer: {
        ...state.explorer,
        [worktreePath]: {
          ...workspace,
          directories: {
            ...workspace.directories,
            [directory]: {
              phase: 'loading',
              entries: previous?.entries ?? [],
              truncated: previous?.truncated ?? false,
              requestId
            }
          }
        }
      }
    }))
    try {
      const result = await window.donwells.listWorkspaceDirectory(worktreePath, {
        directory,
        showHidden: workspace.showHidden,
        includeIgnored: workspace.includeIgnored
      })
      set((state) => {
        const current = state.explorer[worktreePath]
        if (current?.directories[directory]?.requestId !== requestId) return {}
        return {
          explorer: {
            ...state.explorer,
            [worktreePath]: {
              ...current,
              directories: {
                ...current.directories,
                [directory]: { phase: 'ready', entries: result.entries, truncated: result.truncated, requestId }
              }
            }
          }
        }
      })
    } catch (error) {
      set((state) => {
        const current = state.explorer[worktreePath]
        if (current?.directories[directory]?.requestId !== requestId) return {}
        return {
          explorer: {
            ...state.explorer,
            [worktreePath]: {
              ...current,
              directories: {
                ...current.directories,
                [directory]: {
                  phase: 'error',
                  entries: current.directories[directory]?.entries ?? [],
                  error: String(error),
                  truncated: false,
                  requestId
                }
              }
            }
          }
        }
      })
    }
  },

  setExplorerExpanded(worktreePath: string, directory: string, expanded: boolean) {
    const workspace = get().explorer[worktreePath] ?? emptyExplorerWorkspace()
    const next = new Set(workspace.expanded)
    if (expanded) next.add(directory)
    else next.delete(directory)
    set((state) => ({ explorer: { ...state.explorer, [worktreePath]: { ...workspace, expanded: [...next] } } }))
    if (expanded && workspace.directories[directory]?.phase !== 'ready') void get().refreshExplorer(worktreePath, directory)
  },

  setExplorerSelected(worktreePath: string, relPath: string | null) {
    const workspace = get().explorer[worktreePath] ?? emptyExplorerWorkspace()
    set((state) => ({ explorer: { ...state.explorer, [worktreePath]: { ...workspace, selected: relPath } } }))
  },

  setExplorerVisibility(worktreePath: string, options: { showHidden?: boolean; includeIgnored?: boolean }) {
    const workspace = get().explorer[worktreePath] ?? emptyExplorerWorkspace()
    const next = {
      ...workspace,
      directories: {},
      showHidden: options.showHidden ?? workspace.showHidden,
      includeIgnored: options.includeIgnored ?? workspace.includeIgnored
    }
    set((state) => ({ explorer: { ...state.explorer, [worktreePath]: next } }))
    void get().refreshExplorer(worktreePath)
  },

  collapseExplorer(worktreePath: string) {
    const workspace = get().explorer[worktreePath] ?? emptyExplorerWorkspace()
    set((state) => ({ explorer: { ...state.explorer, [worktreePath]: { ...workspace, expanded: [] } } }))
  },

  async createWorkspaceEntry(worktreePath: string, relPath: string, kind: 'file' | 'directory') {
    try {
      await window.donwells.createWorkspaceEntry(worktreePath, { path: relPath, kind: kind === 'directory' ? 'dir' : 'file' })
      await get().refreshExplorer(worktreePath, parentDirectory(relPath))
      if (kind === 'file') await get().openPreview(worktreePath, relPath, { mode: 'edit' })
      return true
    } catch (error) {
      set({ error: String(error) })
      return false
    }
  },

  async duplicateWorkspaceEntry(worktreePath: string, sourcePath: string, destinationPath: string) {
    try {
      await runWithEditorGuard(worktreePath, [sourcePath], async () => {
        await window.donwells.duplicateWorkspaceEntry(worktreePath, { sourcePath, destinationPath })
      })
      await get().refreshExplorer(worktreePath, parentDirectory(destinationPath))
      return true
    } catch (error) {
      set({ error: String(error) })
      return false
    }
  },

  async moveWorkspaceEntry(worktreePath: string, sourcePath: string, destinationPath: string) {
    try {
      await runWithEditorGuard(worktreePath, [sourcePath], async () => {
        await window.donwells.moveWorkspaceEntry(worktreePath, { sourcePath, destinationPath })
        invalidatePreviewRequestsUnder(worktreePath, sourcePath)
        invalidatePreviewRequestsUnder(worktreePath, destinationPath)
        set((state) => {
          const sourcePrefix = sourcePath + '/'
          const movedFiles: Record<string, FileContent & { v: number; mode?: PreviewMode }> = {}
          for (const [relPath, file] of Object.entries(state.previews[worktreePath] ?? {})) {
            if (relPath !== sourcePath && !relPath.startsWith(sourcePrefix)) {
              movedFiles[relPath] = file
              continue
            }
            const movedPath = replacePathPrefix(relPath, sourcePath, destinationPath)
            movedFiles[movedPath] = { ...file, path: movedPath }
          }
          const keyReplacements: Record<string, string> = {}
          const cardPanes: Pane[] = []
          for (const pane of state.panes[worktreePath] ?? []) {
            if (!pane.file || (pane.file !== sourcePath && !pane.file.startsWith(sourcePrefix))) {
              cardPanes.push(pane)
              continue
            }
            if (pane.kind === 'diff') continue
            const movedPath = replacePathPrefix(pane.file, sourcePath, destinationPath)
            const key = pane.kind === 'preview' ? 'preview:' + movedPath : pane.key
            keyReplacements[pane.key] = key
            cardPanes.push({ ...pane, key, file: movedPath })
          }
          let layout: LayoutNode | undefined = state.layouts[worktreePath]
          if (layout) {
            for (const [from, to] of Object.entries(keyReplacements)) layout = replaceLayoutLeafKey(layout, from, to)
            layout = pruneLayoutTo(layout, new Set(cardPanes.map((pane) => pane.key))) ?? undefined
          }
          const layouts = { ...state.layouts }
          if (layout) layouts[worktreePath] = layout
          else delete layouts[worktreePath]
          const activeKey = state.activePane[worktreePath]
          const activePane = {
            ...state.activePane,
            [worktreePath]: keyReplacements[activeKey] ?? (cardPanes.some((pane) => pane.key === activeKey) ? activeKey : cardPanes[0]?.key ?? '')
          }
          const previousExplorer = state.explorer[worktreePath] ?? emptyExplorerWorkspace()
          const movedNavigation: Record<string, DocumentNavigationTarget> = {}
          for (const [relPath, target] of Object.entries(state.documentNavigation[worktreePath] ?? {})) {
            const movedPath = relPath === sourcePath || relPath.startsWith(sourcePrefix)
              ? replacePathPrefix(relPath, sourcePath, destinationPath)
              : relPath
            movedNavigation[movedPath] = target
          }
          return {
            previews: { ...state.previews, [worktreePath]: movedFiles },
            panes: { ...state.panes, [worktreePath]: cardPanes },
            layouts,
            activePane,
            explorer: {
              ...state.explorer,
              [worktreePath]: {
                ...previousExplorer,
                directories: {},
                selected: previousExplorer.selected && (previousExplorer.selected === sourcePath || previousExplorer.selected.startsWith(sourcePrefix))
                  ? replacePathPrefix(previousExplorer.selected, sourcePath, destinationPath)
                  : previousExplorer.selected,
                expanded: previousExplorer.expanded.map((path) =>
                  path === sourcePath || path.startsWith(sourcePrefix)
                    ? replacePathPrefix(path, sourcePath, destinationPath)
                    : path
                )
              }
            },
            documentNavigation: { ...state.documentNavigation, [worktreePath]: movedNavigation },
            fileSearchMru: {
              ...state.fileSearchMru,
              [worktreePath]: (state.fileSearchMru[worktreePath] ?? []).map((path) =>
                path === sourcePath || path.startsWith(sourcePrefix)
                  ? replacePathPrefix(path, sourcePath, destinationPath)
                  : path
              )
            },
            error: null
          }
        })
        disposePreviewModelsUnder(worktreePath, sourcePath)
        moveDocumentViewStates(worktreePath, sourcePath, destinationPath)
      })
      for (const directory of new Set([parentDirectory(sourcePath), parentDirectory(destinationPath)])) {
        await get().refreshExplorer(worktreePath, directory)
      }
      persistSessionSoon()
      return true
    } catch (error) {
      set({ error: String(error) })
      return false
    }
  },

  async deleteWorkspaceEntry(worktreePath: string, relPath: string) {
    try {
      await runWithEditorGuard(worktreePath, [relPath], async () => {
        await window.donwells.deleteWorkspaceEntry(worktreePath, { path: relPath })
        invalidatePreviewRequestsUnder(worktreePath, relPath)
        set((state) => {
          const prefix = relPath + '/'
          const retainedFiles = Object.fromEntries(
            Object.entries(state.previews[worktreePath] ?? {}).filter(([path]) => path !== relPath && !path.startsWith(prefix))
          )
          const cardPanes = (state.panes[worktreePath] ?? []).filter(
            (pane) => !pane.file || (pane.file !== relPath && !pane.file.startsWith(prefix))
          )
          const layouts = { ...state.layouts }
          const previousLayout = state.layouts[worktreePath]
          const layout = previousLayout ? pruneLayoutTo(previousLayout, new Set(cardPanes.map((pane) => pane.key))) : null
          if (layout) layouts[worktreePath] = layout
          else delete layouts[worktreePath]
          const activeKey = state.activePane[worktreePath]
          const previousExplorer = state.explorer[worktreePath] ?? emptyExplorerWorkspace()
          const retainedNavigation = Object.fromEntries(
            Object.entries(state.documentNavigation[worktreePath] ?? {}).filter(([path]) => path !== relPath && !path.startsWith(prefix))
          )
          return {
            previews: { ...state.previews, [worktreePath]: retainedFiles },
            panes: { ...state.panes, [worktreePath]: cardPanes },
            layouts,
            activePane: {
              ...state.activePane,
              [worktreePath]: cardPanes.some((pane) => pane.key === activeKey) ? activeKey : cardPanes[0]?.key ?? ''
            },
            explorer: {
              ...state.explorer,
              [worktreePath]: {
                ...previousExplorer,
                directories: {},
                selected: previousExplorer.selected && (previousExplorer.selected === relPath || previousExplorer.selected.startsWith(prefix))
                  ? null
                  : previousExplorer.selected,
                expanded: previousExplorer.expanded.filter((path) => path !== relPath && !path.startsWith(prefix))
              }
            },
            documentNavigation: { ...state.documentNavigation, [worktreePath]: retainedNavigation },
            fileSearchMru: {
              ...state.fileSearchMru,
              [worktreePath]: (state.fileSearchMru[worktreePath] ?? []).filter((path) => path !== relPath && !path.startsWith(prefix))
            },
            error: null
          }
        })
        disposePreviewModelsUnder(worktreePath, relPath)
        deleteDocumentViewStates(worktreePath, relPath)
      })
      await get().refreshExplorer(worktreePath, parentDirectory(relPath))
      persistSessionSoon()
      return true
    } catch (error) {
      set({ error: String(error) })
      return false
    }
  },

  async openPreview(worktreePath: string, relPath: string, navigation?: Omit<DocumentNavigationTarget, 'generation'>) {
    try {
      let content: FileContent | undefined = get().previews[worktreePath]?.[relPath]
      if (!content) {
        const request = beginPreviewRequest(worktreePath, relPath)
        content = await previewFileContent(worktreePath, relPath)
        if (previewRequests.get(request.key) !== request.token) return false
        previewRequests.delete(request.key)
      }
      const key = 'preview:' + relPath
      set((state) => {
        const existing = state.previews[worktreePath]?.[relPath]
        const mode = navigation?.mode ?? existing?.mode ?? defaultPreviewMode(relPath, state.settings)
        const previews = {
          ...state.previews,
          [worktreePath]: {
            ...state.previews[worktreePath],
            [relPath]: { ...content, v: existing?.v ?? 0, mode }
          }
        }
        const nextMru = [relPath, ...(state.fileSearchMru[worktreePath] ?? []).filter((path) => path !== relPath)].slice(0, 64)
        let documentNavigation = state.documentNavigation
        if (navigation) {
          const previousTarget = state.documentNavigation[worktreePath]?.[relPath]
          const targets = {
            ...state.documentNavigation[worktreePath],
            [relPath]: { ...navigation, generation: (previousTarget?.generation ?? 0) + 1 }
          }
          const targetPaths = Object.keys(targets)
          while (targetPaths.length > 64) {
            const stale = targetPaths.shift()
            if (stale) delete targets[stale]
          }
          documentNavigation = { ...state.documentNavigation, [worktreePath]: targets }
        }
        const panes = { ...state.panes }
        const cardPanes = [...(panes[worktreePath] ?? [])]
        const activePane = { ...state.activePane, [worktreePath]: key }
        const shared = {
          previews,
          documentNavigation,
          fileSearchMru: { ...state.fileSearchMru, [worktreePath]: nextMru },
          activePane,
          error: null
        }
        if (cardPanes.some((pane) => pane.key === key)) return shared
        const activeKey = state.activePane[worktreePath]
        const active = activeKey ? cardPanes.find((pane) => pane.key === activeKey) : undefined
        let layouts = state.layouts
        if (active?.kind === 'preview') {
          cardPanes[cardPanes.indexOf(active)] = { ...active, key, file: relPath }
          panes[worktreePath] = cardPanes
          const previousLayout = state.layouts[worktreePath]
          if (previousLayout) layouts = { ...state.layouts, [worktreePath]: replaceLayoutLeafKey(previousLayout, activeKey, key) }
          return { ...shared, panes, layouts }
        }
        cardPanes.push({ key, kind: 'preview', file: relPath })
        panes[worktreePath] = cardPanes
        const currentLayout = state.layouts[worktreePath]
        if (currentLayout && !layoutHasLeaf(currentLayout, key)) {
          const next = insertLeaf(currentLayout, state.activePane[worktreePath], key)
          if (next) layouts = { ...state.layouts, [worktreePath]: next }
        }
        return { ...shared, panes, layouts }
      })
      persistSessionSoon()
      return true
    } catch (error) {
      set({ error: String(error) })
      return false
    }
  },

  async reloadOpenPreviews(worktreePath: string, relPaths?: readonly string[]) {
    const matches = (relPath: string): boolean => relPaths === undefined || relPaths.some(
      (target) => relPath === target || relPath.startsWith(target + '/')
    )
    try {
      const paths = Object.keys(get().previews[worktreePath] ?? {}).filter(matches)
      const loaded = await Promise.all(paths.map(async (relPath) => [relPath, await previewFileContent(worktreePath, relPath)] as const))
      set((state) => {
        const files = { ...state.previews[worktreePath] }
        for (const [relPath, content] of loaded) {
          const existing = files[relPath]
          if (existing) files[relPath] = { ...content, v: existing.v + 1, mode: existing.mode }
        }
        return { previews: { ...state.previews, [worktreePath]: files }, error: null }
      })
    } catch (error) {
      set({ error: String(error) })
      throw error
    }
  },

  async retargetPreview(worktreePath: string, paneKey: string, relPath: string) {
    try {
      let content: FileContent | undefined = get().previews[worktreePath]?.[relPath]
      if (!content) {
        const request = beginPreviewRequest(worktreePath, relPath)
        content = await previewFileContent(worktreePath, relPath)
        if (previewRequests.get(request.key) !== request.token) return
        previewRequests.delete(request.key)
      }
      const key = 'preview:' + relPath
      set((state) => {
        const existing = state.previews[worktreePath]?.[relPath]
        const previews = {
          ...state.previews,
          [worktreePath]: {
            ...state.previews[worktreePath],
            [relPath]: { ...content, v: existing?.v ?? 0, mode: existing?.mode ?? defaultPreviewMode(relPath, state.settings) }
          }
        }
        const panes = { ...state.panes }
        const cardPanes = [...(panes[worktreePath] ?? [])]
        const index = cardPanes.findIndex((pane) => pane.key === paneKey)
        if (index === -1 || cardPanes[index]?.kind !== 'preview') return { error: null }
        const other = cardPanes.findIndex((pane) => pane.key === key && pane.file === relPath)
        let layouts = state.layouts
        if (other !== -1) {
          cardPanes.splice(index, 1)
          panes[worktreePath] = cardPanes
          const previousLayout = state.layouts[worktreePath]
          if (previousLayout) {
            const pruned = pruneLayoutTo(previousLayout, new Set(cardPanes.map((pane) => pane.key)))
            layouts = { ...state.layouts }
            if (pruned) layouts[worktreePath] = pruned
            else delete layouts[worktreePath]
          }
          return { previews, panes, layouts, activePane: { ...state.activePane, [worktreePath]: key }, error: null }
        }
        cardPanes[index] = { ...cardPanes[index], key, file: relPath }
        panes[worktreePath] = cardPanes
        const previousLayout = state.layouts[worktreePath]
        if (previousLayout) layouts = { ...state.layouts, [worktreePath]: replaceLayoutLeafKey(previousLayout, paneKey, key) }
        const nextMru = [relPath, ...(state.fileSearchMru[worktreePath] ?? []).filter((path) => path !== relPath)].slice(0, 64)
        return {
          previews,
          panes,
          layouts,
          fileSearchMru: { ...state.fileSearchMru, [worktreePath]: nextMru },
          activePane: { ...state.activePane, [worktreePath]: key },
          error: null
        }
      })
      persistSessionSoon()
    } catch (error) {
      set({ error: String(error) })
    }
  },

  /** Revision-checked external write-through. Dirty editor text always wins: an
   *  agent write is rejected before disk I/O instead of creating a late conflict. */
  async writePreview(worktreePath: string, relPath: string, content: string) {
    const document = getEditorDocument(worktreePath, relPath)
    if (document?.save.isDirty()) throw new Error('Refusing to overwrite unsaved editor changes in ' + relPath)
    const release = document?.save.beginMutationLock()
    try {
      let expectedRevision = document?.save.snapshot().revision ?? get().previews[worktreePath]?.[relPath]?.revision
      if (!expectedRevision) {
        const current = await window.donwells.readFile(worktreePath, relPath)
        expectedRevision = current.revision
      }
      if (!expectedRevision) throw new Error('Cannot safely write an unversioned file: ' + relPath)
      const saved = await window.donwells.writeFile(worktreePath, relPath, content, expectedRevision)
      const key = 'preview:' + relPath
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
        if (!cardPanes.some((pane) => pane.kind === 'preview' && pane.file === relPath)) {
          cardPanes.push({ key, kind: 'preview', file: relPath })
          panes[worktreePath] = cardPanes
        }
        let layouts = s.layouts
        if (s.layouts[worktreePath] && !layoutHasLeaf(s.layouts[worktreePath], key)) {
          const next = insertLeaf(s.layouts[worktreePath], s.activePane[worktreePath], key)
          if (next) layouts = { ...s.layouts, [worktreePath]: next }
        }
        return { previews, panes, layouts, activePane: { ...s.activePane, [worktreePath]: key }, error: null }
      })
      persistSessionSoon()
      return saved
    } finally {
      release?.()
    }
  },

  async setPreviewMode(worktreePath: string, relPath: string, mode: PreviewMode) {
    if (mode === 'preview') {
      try { await flushPreviewModel(worktreePath, relPath) }
      catch (error) { set({ error: String(error) }); return false }
    }
    set((s) => {
      const file = s.previews[worktreePath]?.[relPath]
      if (!file || file.mode === mode) return {}
      return {
        previews: { ...s.previews, [worktreePath]: { ...s.previews[worktreePath], [relPath]: { ...file, mode } } }
      }
    })
    return true
  },
  openDiff(worktreePath: string, relPath: string, comparison: DiffComparison = 'working') {
    const key = comparison === 'working' ? `diff:${relPath}` : `diff:${comparison}:${relPath}`
    set((s) => {
      const panes = { ...s.panes }
      const cardPanes = [...(panes[worktreePath] ?? [])]
      const activePane = { ...s.activePane, [worktreePath]: key }
      // already open → focus only
      if (cardPanes.some((p) => p.key === key)) return { activePane, error: null }
      cardPanes.push({ key, kind: 'diff', file: relPath, comparison })
      panes[worktreePath] = cardPanes
      let layouts = s.layouts
      if (s.layouts[worktreePath] && !layoutHasLeaf(s.layouts[worktreePath]!, key)) {
        const next = insertLeaf(s.layouts[worktreePath]!, s.activePane[worktreePath], key)
        if (next) layouts = { ...s.layouts, [worktreePath]: next }
      }
      return { panes, layouts, activePane, error: null }
    })
    persistSessionSoon()
  },

  noteBrowserNavigation(worktreePath: string, url: string) {
    set((s) => {
      const panes = s.panes[worktreePath]
      const current = panes?.find((pane) => pane.kind === 'browser')
      if (!current || current.url === url) return {}
      return { panes: { ...s.panes, [worktreePath]: panes!.map((pane) => pane === current ? { ...pane, url } : pane) } }
    })
    persistSessionSoon()
  },

  /** Open (or retarget) the worktree's single embedded browser pane. */
  openBrowser(worktreePath: string, url: string) {
    if (!get().repos.some((repo) => repo.worktrees.some((worktree) => worktree.path === worktreePath))) {
      throw new Error(`No workspace owns ${worktreePath}`)
    }
    const normalized = normalizeBrowserUrl(url)
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

  ackPreviewSave(worktreePath: string, relPath: string, saved: FileContent, sourceEpoch: number) {
    set((s) => {
      const file = s.previews[worktreePath]?.[relPath]
      if (!file || file.v !== sourceEpoch) return {}
      return {
        previews: { ...s.previews, [worktreePath]: { ...s.previews[worktreePath], [relPath]: { ...file, ...saved } } }
      }
    })
  },

  async closePreview(worktreePath: string, relPath?: string) {
    const closedFiles = relPath !== undefined ? [relPath] : Object.keys(get().previews[worktreePath] ?? {})
    invalidatePreviewRequestsUnder(worktreePath, relPath)
    try {
      await Promise.all(closedFiles.map((file) => flushPreviewModel(worktreePath, file)))
      for (const file of closedFiles) {
        const document = getEditorDocument(worktreePath, file)
        if (document && !document.save.canDispose()) throw new Error(`Unsaved changes remain in ${file}`)
      }
    } catch (error) { set({ error: String(error) }); return false }
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
      const documentNavigation = { ...s.documentNavigation }
      if (relPath === undefined) {
        delete documentNavigation[worktreePath]
      } else {
        const targets = { ...documentNavigation[worktreePath] }
        delete targets[relPath]
        if (Object.keys(targets).length === 0) delete documentNavigation[worktreePath]
        else documentNavigation[worktreePath] = targets
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
      return { panes, previews, documentNavigation, activePane, layouts }
    })
    // models for files no longer shown anywhere get disposed (memory ceiling)
    for (const f of closedFiles) disposePreviewModel(worktreePath, f)
    return true
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
      terminals: s.terminals,
      layouts: drop(s.layouts),
      docking: drop(s.docking),
      statuses: drop(s.statuses),
      explorer: drop(s.explorer),
      previews: drop(s.previews),
      documentNavigation: drop(s.documentNavigation),
      fileSearchMru: drop(s.fileSearchMru),
      gitCommitDrafts: drop(s.gitCommitDrafts),
      busy: drop(s.busy),
      workspaceNavigation: normalizeWorkspaceNavigation(s.workspaceNavigation, s.repos),
    }))
    for (const terminal of Object.values(get().terminals)) {
      if (!live.has(terminal.session.worktreePath)) void get().closeTerminal(terminal.session.worktreePath, terminal.session.id)
    }
    persistSessionSoon()
  },

  async refreshStatuses() {
    const repos = get().repos
    const paths = new Set<string>()
    for (const r of repos) for (const w of r.worktrees) paths.add(w.path)
    if (paths.size === 0) return
    const statuses: Record<string, WorktreeStatus> = {}
    const results = await Promise.allSettled([...paths].map((p) => window.donwells.gitStatus(p)))
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
      const scan = await window.donwells.scanWorktree(worktreePath)
      set((s) => ({ scans: { ...s.scans, [worktreePath]: scan } }))
    } catch {
      // lsof/ps unavailable or sandboxed — leave previous scan; segments stay quiet
    }
  },

  async focusAgentSession(sessionId: string) {
    try {
      const sessions = await window.donwells.terminalSessions()
      const session = sessions.find((item) => item.id === sessionId)
      if (!session) throw new Error('The retained terminal is no longer available.')
      const run = (await window.donwells.agentList()).find((item) => item.sessionId === sessionId)
      if (!run || run.workspacePath !== session.worktreePath) throw new Error('The agent no longer owns this terminal.')
      const repo = get().repos.find((item) => item.worktrees.some((worktree) => worktree.path === session.worktreePath))
      if (!repo) throw new Error('The workspace is no longer registered.')
      set((state) => ({
        ...activateTerminalSession(state, session),
        activeRepoId: repo.repo.id,
        runsOpen: false,
        runningAgents: { ...state.runningAgents, [sessionId]: run }
      }))
      persistSessionSoon()
      return true
    } catch (error) {
      set({ error: 'Could not open agent terminal: ' + String(error) })
      return false
    }
  },

  async runAgent(worktreePath: string, command: string | AgentExecutable, task?: import('@shared/agent-runtime').AgentTaskIntent) {
    const trimmed = typeof command === 'string' ? command.trim() : command
    if (!trimmed) {
      const error = 'Enter an agent command.'
      set({ error })
      return { ok: false as const, error }
    }
    try {
      const preset = typeof trimmed === 'string' ? get().agents.find(agent => agent.command === trimmed && agent.executablePath) : undefined
      const result = await window.donwells.agentStart(worktreePath, preset?.executablePath ? { executable: preset.executablePath, args: [] } : trimmed, task)
      set((state) => ({
        ...activateTerminalSession(state, result.session),
        runningAgents: { ...state.runningAgents, [result.run.sessionId]: result.run },
        runsOpen: false,
        error: null
      }))
      persistSessionSoon()
      return { ok: true as const }
    } catch (cause) {
      const error = 'Agent start failed: ' + (cause instanceof Error ? cause.message : String(cause))
      set({ error })
      return { ok: false as const, error }
    }
  },

  async stopAgent(sessionId: string) {
    try {
      const run = await window.donwells.agentStop(sessionId)
      get().applyAgentRun(run)
      return { ok: true as const }
    } catch (cause) {
      const error = 'Agent stop failed: ' + (cause instanceof Error ? cause.message : String(cause))
      set({ error })
      return { ok: false as const, error }
    }
  },

  async dismissAgent(sessionId: string) {
    try {
      await window.donwells.agentDismiss(sessionId)
      get().applyAgentDismissed(sessionId)
      return { ok: true as const }
    } catch (cause) {
      const error = 'Agent dismissal failed: ' + (cause instanceof Error ? cause.message : String(cause))
      set({ error })
      return { ok: false as const, error }
    }
  },

  syncSettings(settings: AppSettings) {
    const validated = resolveSettings(settings)
    set((state) => ({
      settings: validated,
      settingsRevision: state.settingsRevision + 1,
      error: null
    }))
  },

  async setSettings(patch: Partial<AppSettings>) {
    try {
      const revision = get().settingsRevision
      const settings = await window.donwells.setSettings(patch)
      // A newer authoritative broadcast wins over this request's response.
      if (get().settingsRevision === revision) get().syncSettings(settings)
      return { ok: true as const }
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause)
      set({ error })
      return { ok: false as const, error }
    }
  },

  setPaletteOpen(open: boolean, mode?: 'commands' | 'files') {
    set((state) => ({ paletteOpen: open, paletteMode: mode ?? state.paletteMode }))
  },

  setGitCommitDraft(worktreePath: string, value: string) {
    set((state) => ({ gitCommitDrafts: { ...state.gitCommitDrafts, [worktreePath]: value } }))
    persistSessionSoon()
  },

  setSettingsOpen(open: boolean) {
    set({ settingsOpen: open })
  },

  openSettings(section: SettingsSection) {
    set({ settingsOpen: true, settingsSection: section })
  },

  openRuns(section: RunsSection = get().runsSection) {
    set({ runsOpen: true, runsSection: section, settingsOpen: false })
  },

  setRunsOpen(open: boolean) {
    set({ runsOpen: open })
  },

  setSidebarOpen(open: boolean) {
    set({ sidebarOpen: open })
  },

  setRightSidebarOpen(open: boolean) {
    const wasOpen = get().rightSidebarOpen
    if (open && !wasOpen) { get().setRightSidebarTab(get().rightSidebarTab); return }
    set({ rightSidebarOpen: open })
    if (wasOpen && !open && typeof document !== 'undefined') requestAnimationFrame(() => {
      const state = get(), path = state.activeWorktreePath
      const key = path ? state.activePane[path] : undefined
      if (state.rightSidebarOpen || !key) return
      const pane = document.querySelector<HTMLElement>(`[data-pane-key="${CSS.escape(key)}"]`)
      ;(pane?.querySelector<HTMLElement>('.xterm-helper-textarea, .monaco-editor textarea') ?? pane)?.focus()
    })
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
    const docking = get().docking[worktreePath]
    if (docking) {
      const resized = resizeWorkspaceSplit(docking, splitId, pct)
      if (!resized) return null
      get().saveDocking(worktreePath, resized)
      return Math.min(85, Math.max(15, pct))
    }
    const previous = get().layouts[worktreePath]
    if (!previous || !Number.isInteger(splitId) || splitId < 0 || !Number.isFinite(pct)) return null
    const clamped = Math.min(85, Math.max(15, pct))
    const cursor = { n: 0, found: false }
    const next = setSplitSizeById(previous, splitId, clamped, cursor)
    if (!cursor.found) return null
    if (next !== previous) {
      set((state) => ({ layouts: { ...state.layouts, [worktreePath]: next } }))
      persistSessionSoon()
    }
    return clamped
  },

  setRightSidebarTab(tab: 'explorer' | 'git' | 'memory' | 'recovery' | 'search' | 'computer') {
    set({ rightSidebarOpen: true, rightSidebarTab: tab })
    if (typeof document !== 'undefined') requestAnimationFrame(() => {
      const state = get()
      if (state.rightSidebarOpen && state.rightSidebarTab === tab && !document.querySelector('dialog[open]')) {
        document.querySelector<HTMLElement>(`[data-right-sidebar-tab="${tab}"]`)?.focus()
      }
    })
  },

  setCreateOpen(open: boolean) {
    set({ createOpen: open })
  },

  setDeleteTarget(path: string | null) {
    set({ deleteTarget: path })
  },

  toggleRepoCollapsed(repoId: string) {
    set((state) => ({
      workspaceNavigation: toggleNavigationValue(state.workspaceNavigation, 'collapsedRepoIds', repoId)
    }))
    persistSessionSoon()
  },

  toggleWorkspacePinned(path: string) {
    set((state) => ({
      workspaceNavigation: toggleNavigationValue(state.workspaceNavigation, 'pinnedPaths', path)
    }))
    persistSessionSoon()
  },

  renameWorkspace(path: string, label: string) {
    set((state) => ({ workspaceNavigation: renameWorkspaceNavigation(state.workspaceNavigation, path, label) }))
    persistSessionSoon()
  },

  hideWorkspace(path: string) {
    set((state) => ({
      workspaceNavigation: state.workspaceNavigation.hiddenPaths.includes(path)
        ? state.workspaceNavigation
        : { ...state.workspaceNavigation, hiddenPaths: [...state.workspaceNavigation.hiddenPaths, path] },
      ...(state.activeWorktreePath === path ? { activeWorktreePath: null } : {})
    }))
    persistSessionSoon()
  },

  restoreWorkspace(path?: string) {
    set((state) => ({ workspaceNavigation: restoreWorkspaceNavigation(state.workspaceNavigation, path) }))
    persistSessionSoon()
  },

  moveWorkspace(path: string, delta: -1 | 1) {
    set((state) => ({
      workspaceNavigation: moveWorkspaceNavigation(state.workspaceNavigation, state.repos, path, delta)
    }))
    persistSessionSoon()
  },

  setActiveRepo(repoId: string | null) {
    set({ activeRepoId: repoId, activeWorktreePath: null, runsOpen: false })
    persistSessionSoon()
  },

  setActiveWorktree(path: string | null) {
    set({ activeWorktreePath: path, runsOpen: false })
    if (path) {
      void get().refreshExplorer(path)
      // upstream activation-terminal-prep: every worktree gets a shell ready on first visit.
      const hasTerminal = (get().panes[path] ?? []).some((p) => p.kind === 'terminal')
      if (!hasTerminal) void get().openTerminal(path)
    }
    persistSessionSoon()
  },
  applyTerminalExit(sessionId: string, _exitCode?: number) {
    const s = get()
    if (s.runningAgents[sessionId]) {
      const terminal = s.terminals[sessionId]
      if (terminal) {
        set({ terminals: { ...s.terminals, [sessionId]: { ...terminal, session: { ...terminal.session, exited: true } } } })
        persistSessionSoon()
      }
      return
    }
    // A dead shell closes its pane — no zombie tabs (VS Code/upstream behavior).
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
    terminalBus.dropSession(sessionId)
    set({
      panes,
      terminals,
      terminalOrder,
      activePane,
      activeTerminal,
      closeRequest: s.closeRequest?.sessionId === sessionId ? null : s.closeRequest,
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
  applyAgentRun(run: RunningAgent) {
    set((state) => ({
      runningAgents: { ...state.runningAgents, [run.sessionId]: run }
    }))
  },

  applyAgentDismissed(sessionId: string) {
    const exitCode = get().runningAgents[sessionId]?.exitCode ?? 0
    set((state) => {
      const runningAgents = { ...state.runningAgents }
      delete runningAgents[sessionId]
      return { runningAgents }
    })
    get().applyTerminalExit(sessionId, exitCode)
  }
}))

type WorkspaceSession = NonNullable<PersistedState['workspaceSession']>
let persistTimer: ReturnType<typeof setTimeout> | null = null
let persistWrite: Promise<void> = Promise.resolve()

async function saveWorkspaceSnapshot(): Promise<void> {
  await ensureNavigationHistoryInitialized(async () => (await window.donwells.getWorkspaceSession())?.navigationHistory)
  const s = useAppStore.getState()
  if (s.initializationError) throw new Error('Workspace state was not loaded; the saved session has not been overwritten.')
  const repos: WorkspaceSession['repos'] = {}
  for (const r of s.repos) {
    const wtPaths = new Set(r.worktrees.map((w) => w.path))
    const pick = <T,>(rec: Record<string, T>): Record<string, T> =>
      Object.fromEntries(Object.entries(rec).filter(([path]) => wtPaths.has(path)))
    repos[r.repo.id] = {
      panes: pick(s.panes), activePane: pick(s.activePane), activeTerminal: pick(s.activeTerminal),
      terminalOrder: pick(s.terminalOrder), layouts: pick(s.layouts), docking: pick(s.docking),
      activeWorktreePath: s.activeWorktreePath && wtPaths.has(s.activeWorktreePath) ? s.activeWorktreePath : null
    }
  }
  const worktreePaths = new Set(s.repos.flatMap((repo) => repo.worktrees.map((worktree) => worktree.path)))
  const snapshot: WorkspaceSession = {
    activeRepoId: s.activeRepoId,
    navigationHistory: getPersistedNavigationHistory(),
    repos,
    workspaceNav: normalizeWorkspaceNavigation(s.workspaceNavigation, s.repos),
    gitCommitDrafts: Object.fromEntries(Object.entries(s.gitCommitDrafts).filter(([path]) => worktreePaths.has(path))),
    fileSearchMru: Object.fromEntries(Object.entries(s.fileSearchMru).filter(([path]) => worktreePaths.has(path))),
    ui: { sidebarWidth: s.sidebarWidth, rightSidebarWidth: s.rightSidebarWidth }
  }
  persistWrite = persistWrite.catch(() => {}).then(() => window.donwells.saveWorkspaceSession(snapshot))
  return persistWrite
}

export function persistSessionSoon(): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    void saveWorkspaceSnapshot().catch((error) => useAppStore.getState().setError(`Workspace save failed: ${String(error)}`))
  }, 400)
}

export function flushWorkspaceSession(): Promise<void> {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = null
  return saveWorkspaceSnapshot()
}

// Dev/E2E seam (upstream's own convention, REBUILD_SPEC §9): window.__store exposes
// the live store for driving tests and debugging — never referenced by product code.
declare global {
  interface Window {
    __store?: typeof useAppStore
  }
}
if (typeof window !== 'undefined') {
  window.__store = useAppStore
}
