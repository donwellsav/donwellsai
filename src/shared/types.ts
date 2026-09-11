import type { ProjectHandoffApi } from './project-handoff'
import type { ProjectCreationApi } from './project-creation'
import type { PersistedNavigationHistoryV1 } from './navigation-history'
import type { ProjectMemoryApi, ProjectMemoryStorageAction, ProjectMemoryStorageStatus } from './project-memory'
import type { RecoveryApi } from './editor-recovery'
import type { AttentionInboxApi } from './attention-inbox'
import type { AppearanceApi } from './appearance'
import type { BrowserHistoryApi } from './browser-history'
import type { FileWorkspaceApi } from './file-workspace'
import type { MediaPreviewApi } from './media-preview'
import type { SkillPackagesApi } from './skill-packages'
import type { OperationalRunsApi } from './operational-runs'
import type { AgentDeliveryApi } from './agent-delivery'
import type { AgentStartResult } from './agent-runtime'
import type { DiffReviewApi } from './diff-review'
import type { CollaborationApi } from './collaboration'
import type {
  AgentPreset as RuntimeAgentPreset,
  RunningAgent as RuntimeRunningAgent
} from './agent-runtime'

// Contracts shared across main, preload, and renderer.

export type RepoKind = 'git' | 'folder'

export type Repo = {
  taskAuthority?: 'backlog.md'
  id: string
  path: string
  addedAt: string
  /** Absent only in persisted records written before folder workspaces existed. */
  kind?: RepoKind
}

export type Worktree = {
  id: string
  path: string
  branch: string
  isMain: boolean
  head?: string
  locked?: boolean
  bare?: boolean
  detached?: boolean
}

/** One path from a NUL-delimited porcelain v2 status snapshot. */
export type GitStatusCode = '.' | 'M' | 'T' | 'A' | 'D' | 'R' | 'C' | 'U' | '?'

export type GitStatusEntry = {
  /** Current relative path. Exact filesystem spelling; never C-style quoted. */
  path: string
  /** Previous relative path for a rename/copy. */
  originalPath?: string
  kind: 'ordinary' | 'renamed' | 'conflict' | 'untracked'
  index: GitStatusCode
  workingTree: GitStatusCode
  staged: boolean
  unstaged: boolean
  conflict: boolean
}

/** Per-worktree status. New fields are optional so an older host degrades without reparsing raw text. */
export type WorktreeStatus = {
  kind?: RepoKind
  branch: string
  detached?: boolean
  headOid?: string
  upstream?: string
  /** ahead of upstream / behind upstream, when the branch has one */
  ahead: number
  behind: number
  staged: number
  modified: number
  untracked: number
  conflicts: number
  /** NUL-safe typed entries. Absence means the connected host cannot provide actionable path details. */
  entries?: GitStatusEntry[]
  /** relative paths, one per changed file (staged/modified/conflicted/untracked) */
  changedFiles: string[]
  /** Compatibility-only porcelain-like lines. Current clients must use entries. */
  raw: string[]
}

export type GitPathFailure = { path: string; error: string }
export type GitPathOperation = 'stage' | 'unstage' | 'discard'
export type GitPathOperationResult = {
  operation: GitPathOperation
  succeeded: string[]
  failures: GitPathFailure[]
}

export type GitBranchInfo = {
  current: string | null
  detached: boolean
  headOid?: string
  all: string[]
}

export type GitCommit = {
  oid: string
  shortOid: string
  author: string
  authoredAt: string
  subject: string
}

export type GitHistoryPage = {
  commits: GitCommit[]
  nextCursor?: string
}

/** Full repo view: persisted repo meta + live-discovered worktrees + git user info for branch prefixes. */
export type RepoSummary = {
  repo: Repo
  worktrees: Worktree[]
  /** branch → base branch at creation (worktree lineage, for removal-impact UI) */
  lineage?: Record<string, string>
  defaultBranch: string
  currentBranch?: string
}

export type TerminalSession = {
  id: string
  worktreePath: string
  title: string
  createdAt: string
  /** Last known live status */
  exited: boolean
}

export type AgentPreset = RuntimeAgentPreset

export type AppMeta = {
  version: string
  shell: string
  userDataDir: string
  memoryMcp?: { command: string; args: string[]; env: Record<string, string> }
}

/** A daemon-owned finite agent run bound to a workspace terminal. */
export type RunningAgent = RuntimeRunningAgent

/** Explorer tree built from `git ls-files -co --exclude-standard` + fs dirs. */
export type FileEntry = {
  /** relative path from worktree root */
  path: string
  name: string
  type: 'dir' | 'file'
}

export type FileContent = {
  path: string
  content: string
  truncated: boolean
  bytes: number
  /** True only when inspected bytes contain NUL or invalid UTF-8; never writable as text. */
  binary?: boolean
  /** Opaque full-file revision; absent on hosts that cannot guard writes. */
  revision?: string
}

export type DiffComparison = 'working' | 'staged' | 'unstaged'

export type TerminalThemeName = 'donwells' | 'tomorrow-night' | 'dracula' | 'solarized-dark' | 'github-dark'

/** Stable settings route ids used by the UI and runtime command contract. */
export type SettingsSection =
  | 'project'
  | 'agents'
  | 'editor'
  | 'source-control'
  | 'browser'
  | 'appearance'
  | 'terminal'
  | 'shortcuts'
  | 'notifications'
  | 'privacy'
  | 'advanced'
export type RunsSection = 'agents' | 'automations' | 'orchestration'
export type AttentionState = {
  /** Whether the tray and Dock should show a current needs-attention marker. */
  indicator: boolean
  /** Whether a background window should request native attention for a new attention state. */
  flash: boolean
}
/** How an editor pane shows a markdown file. */
export type PreviewMode = 'edit' | 'preview'

export type AppSettings = {
  agentCommand: string
  theme: 'system' | 'dark' | 'light'
  uiScale: number
  interfaceFont: 'geist' | 'system'
  interfaceMotion: 'system' | 'reduced'
  interfaceDensity: 'compact' | 'comfortable'
  navigationLabels: 'icons' | 'labels'
  toolPanelSide: 'left' | 'right'
  browserAutoPreview: boolean
  recordBrowserHistory: boolean
  externalAgentAccess: boolean
  terminalRenderer: 'xterm' | 'ghostty'
  terminalFontFamily: string
  terminalFontSize: number
  terminalFontWeight: 400 | 500 | 600 | 700
  terminalLineHeight: number
  cursorStyle: 'block' | 'bar' | 'underline'
  cursorBlink: boolean
  scrollback: number
  copyOnSelect: boolean
  terminalTheme: TerminalThemeName
  /** null inherits the terminal preference. */
  editorFontFamily: string | null
  /** null inherits terminalFontSize. */
  editorFontSize: number | null
  editorWordWrap: 'on' | 'off'
  editorMinimap: boolean
  editorTabSize: 2 | 4 | 8
  editorStickyScroll: boolean
  editorRenderWhitespace: 'none' | 'boundary' | 'selection' | 'trailing' | 'all'
  editorAutoSaveMode: 'after-delay' | 'manual'
  editorAutoSaveDelayMs: number
  markdownPreviewDefault: boolean
  diffViewStyle: 'split' | 'unified'
  diffWordWrap: boolean
  /** null inherits the effective editor font family. */
  diffFontFamily: string | null
  /** null inherits the effective editor font size. */
  diffFontSize: number | null
  browserHomeUrl: string
  browserSearchEngine: 'duckduckgo' | 'google' | 'bing'
  imageViewerFit: 'contain' | 'width' | 'actual'
  pdfViewerFit: 'page' | 'width' | 'actual'
  notificationActivityIndicator: boolean
  notificationFlashWindow: boolean
  keyboardShortcutOverrides: Record<string, string>
  /** Worktree/git status poll interval; 0 disables polling. */
  statusPollMs: number
  /** UI language code (IETF BCP 47). */
  language: string
}

export type SettingKey = keyof AppSettings
export type SettingsResetRequest = { keys: SettingKey[] } | { section: SettingsSection }

// Persisted state (subset of donwells-data.json; lite keeps user intent + settings, never derived state)
/** Binary split tree, persisted shape (mirrors the renderer's LayoutNode). */
export type PersistedLayoutNode =
  | { kind: 'leaf'; pane: string }
  | { kind: 'split'; dir: 'row' | 'col'; first: PersistedLayoutNode; second: PersistedLayoutNode; size?: number }


export type PersistedState = {
  schemaVersion: 2
  repos: Repo[]
  settings: Partial<AppSettings>
  windowState?: { x: number; y: number; width: number; height: number; maximized: boolean }
  /**
   * Retired worktree names per repo id — a deleted name never returns in the
   * same repo namespace (upstream worktree-name-retirement rule). Monotonic.
   */
  retiredNames?: Record<string, string[]>
  /** Worktree lineage per repo id: branch → base branch at creation. */
  worktreeLineage?: Record<string, Record<string, string>>
  /**
   * Workspace session (upstream workspace-session model): what the user had
   * open, per repo — panes/worktrees/active selection. Restored on launch;
   * terminals reattach to the same daemon-owned PTY sessions.
   */
  workspaceSession?: {
    activeRepoId: string | null
    navigationHistory?: PersistedNavigationHistoryV1
    /** persisted chrome widths (panel resizing) */
    ui?: { railCollapsed?: boolean; projectListPercent?: number; sidebarWidth?: number; rightSidebarWidth?: number; sidebarOpen?: boolean; rightSidebarOpen?: boolean; rightSidebarTab?: 'explorer' | 'git' | 'memory' | 'recovery' | 'search' | 'computer'; runsOpen?: boolean; runsSection?: RunsSection }
    /** User-owned workspace organization; hidden entries remain registered and restorable. */
    workspaceNav?: {
      collapsedRepoIds?: string[]
      pinnedPaths?: string[]
      order?: string[]
      renames?: Record<string, string>
      hiddenPaths?: string[]
    }
    /** Commit messages stay with the workspace session and survive app restarts. */
    gitCommitDrafts?: Record<string, string>
    /** Bounded Quick Open MRU paths keyed by workspace path. */
    fileSearchMru?: Record<string, string[]>
    /**
     * Agent chips keyed by PTY session id. Restored only when the daemon still
     * owns the session — a chip must never outlive the process it tracks.
     */
    runningAgents?: Record<string, RunningAgent>
    /** per repo id: pane lists + active pane key + active terminal session */
    repos: Record<string, {
      panes: Record<string, Array<{ key: string; kind: 'terminal' | 'explorer' | 'git-status' | 'preview' | 'diff' | 'browser' | 'memory' | 'recovery' | 'search' | 'computer' | 'environments'; sessionId?: string; file?: string; url?: string; comparison?: DiffComparison; label?: string }>>
      activePane: Record<string, string>
      activeTerminal: Record<string, string>
      terminalOrder: Record<string, string[]>
      layouts: Record<string, PersistedLayoutNode>
      /** Versioned docking data is validated against surviving pane identities by the renderer. */
      docking?: Record<string, unknown>
      /** First legacy layout retained independently of later docking edits. */
      preDockingLayouts?: Record<string, PersistedLayoutNode>
      activeWorktreePath: string | null
    }>
  }
  /** Unknown top-level data is retained for independent state owners. */
  [key: string]: unknown
}

/** An automation: a command fired into a worktree terminal on a schedule. */
export type AutomationSchedule =
  | { kind: 'interval'; minutes: number }
  | { kind: 'daily'; time: string } // HH:MM local

export type Automation = {
  id: string
  name: string
  worktreePath: string
  command: string
  schedule: AutomationSchedule
  enabled: boolean
  createdAt: string
  nextRunAt?: string
  lastRunAt?: string
  lastStatus?: 'running' | 'ok' | 'failed' | 'interrupted'
}

export type AutomationRun = {
  id: string
  automationId: string
  startedAt: string
  finishedAt?: string
  status: 'running' | 'ok' | 'failed' | 'interrupted'
  tail?: string
}

export type OrchestrationTaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
export type OrchestrationRunStatus = 'running' | 'done' | 'failed' | 'cancelled'

export type OrchestrationTask = {
  id: string
  worktreePath: string
  prompt: string
  status: OrchestrationTaskStatus
  sessionId?: string
  startedAt?: string
  finishedAt?: string
  error?: string
  output?: string
}

export type OrchestrationRun = {
  id: string
  name: string
  command: string
  /** Max concurrent tasks. */
  parallel: number
  status: OrchestrationRunStatus
  createdAt: string
  finishedAt?: string
  tasks: OrchestrationTask[]
}


export type BrowserShortcutAction = 'focusAddress' | 'find' | 'zoomIn' | 'zoomOut' | 'zoomReset'

// IPC events main -> renderer
export type MainEvents = {
  'project-search:hit': { requestId: string; workspacePath: string; hit: import('./project-tools').ProjectSearchHit }
  'terminal:disconnected': Record<string, never>
  'terminal:data': { sessionId: string; data: string; sequence?: number }
  'terminal:exit': { sessionId: string; exitCode?: number }
  'terminal:title': { sessionId: string; title: string }
  'worktree:changed': { repoId: string }
  'agent:changed': { run: RunningAgent }
  'agent:dismissed': { sessionId: string }
  'project-memory:changed': { projectKey: string }
  /** Collaboration presence updated. */
  'collaboration:presence': { roomName: string; collaborators: import('./collaboration').Collaborator[] }
  /** Collaboration status changed (connected/disconnected). */
  'collaboration:status': { roomName: string; connected: boolean; reason?: string }
  /** Menu/accelerator actions routed to the renderer (palette, new worktree, ...) */
  'menu:action': { action: string }
  /** BrowserWindow accelerator forwarded while focus is inside a guest. */
  'browser:shortcut': { action: BrowserShortcutAction; guestId: number }
  /** Settings mutated by an RPC/CLI client — renderer re-applies live. */
  'settings:changed': { settings: AppSettings }
  /** The autonomous loop needs a decision on a gated action. */
  'autonomous:action-request': { actionId: string; type: string; description: string }
}

/** One browser-pane control command (agent control over runtime RPC). */
export type BrowserCommand =
  | { op: 'navigate'; key: string; url: string }
  | { op: 'back'; key: string }
  | { op: 'forward'; key: string }
  | { op: 'reload'; key: string }
  | { op: 'snapshot'; key: string }
  | { op: 'eval'; key: string; js: string }
  | { op: 'list' }
  | { op: 'open'; key: string; url: string }

export type BrowserSnapshot = { key: string; url: string; title: string; text: string }

export type BrowserCommandResult = { ok: true; result: unknown } | { ok: false; error: string }

/** One UI/panel control command (agent control over runtime RPC). */
export type UiCommand =
  | { op: 'state' }
  | { op: 'activate'; worktreePath?: string; repoId?: string }
  | { op: 'terminal.open'; worktreePath: string }
  | { op: 'split'; worktreePath: string }
  | { op: 'pane.focus'; worktreePath: string; key: string }
  | { op: 'pane.close'; worktreePath: string; key: string }
  | { op: 'pane.resize'; worktreePath: string; splitId: number; pct: number }
  | { op: 'preview.open'; worktreePath: string; relPath: string }
  | { op: 'preview.close'; worktreePath: string; relPath?: string }
  | { op: 'diff.open'; worktreePath: string; relPath: string }
  | { op: 'editor.open'; worktreePath: string; relPath: string }
  | { op: 'editor.write'; worktreePath: string; relPath: string; content: string }
  | { op: 'editor.read'; worktreePath: string; relPath?: string }
  | { op: 'sidebar'; side: 'left' | 'right'; open?: boolean | 'toggle'; tab?: 'explorer' | 'git' | 'memory' | 'recovery' | 'search' | 'computer'; width?: number }
  | { op: 'palette'; open?: boolean | 'toggle'; mode?: 'commands' | 'files' }
  | { op: 'settings.open'; section?: SettingsSection }
  | { op: 'runs.open'; section?: RunsSection }
  | { op: 'workspace.flush' }

export type UiCommandResult = { ok: true; result: unknown } | { ok: false; error: string }

export type AgentMemorySetupResult = { path: string; changed: boolean; backupPath?: string; launchArgs?: string[]; setupArgs?: string[]; replacement?: { revision: string; current: unknown; proposed: unknown } }
export type IpcApi = import('./project-temporal-knowledge').ProjectTemporalKnowledgeApi & import('./project-language-tools').ProjectLanguageApi & import('./project-knowledge').ProjectKnowledgeApi & import('./project-export').ProjectKitApi & import('./browser-view').BrowserViewApi & import('./project-session-history').ProjectSessionHistoryApi & ProjectHandoffApi & ProjectCreationApi & ProjectMemoryApi & RecoveryApi & AttentionInboxApi & AppearanceApi & BrowserHistoryApi & FileWorkspaceApi & MediaPreviewApi & SkillPackagesApi & OperationalRunsApi & AgentDeliveryApi & DiffReviewApi & CollaborationApi & {
  projectDoctorPreviewBackup(workspacePath: string, name: string): Promise<import('./project-doctor').ProjectToolConfiguration>
  projectDoctorInspect(workspacePath: string): Promise<import('./project-doctor').ProjectDoctorReport>
  projectBrowserArtifactReveal(workspacePath: string, path: string, sha256: string): Promise<void>
  projectDoctorSetup(workspacePath: string, field: string, revision: string | null): Promise<import('./project-doctor').ProjectDoctorReport>
  projectDoctorConfigure(workspacePath: string, config: import('./project-doctor').ProjectToolConfiguration, revision: string | null): Promise<import('./project-doctor').ProjectDoctorReport>
  projectDoctorRetry(workspacePath: string, id: string): Promise<import('./project-tools').ToolServiceState>
  projectToolsList(workspacePath: string): Promise<import('./project-tools').ToolServiceState[]>
  projectToolCall(workspacePath: string, id: string, operation: string, args: Record<string, unknown>): Promise<unknown>
  projectToolStop(workspacePath: string, id: string): Promise<void>
  projectMemoryStorageStatus(): Promise<ProjectMemoryStorageStatus>
  projectMemoryStorageAction(action: ProjectMemoryStorageAction): Promise<{ status: ProjectMemoryStorageStatus; exportPath?: string }>
  meta(): Promise<AppMeta>
  listRepos(): Promise<RepoSummary[]>
  /** Browser control surface (renderer executes on its webviews). */
  onBrowserCommand(cb: (env: { id: string; cmd: BrowserCommand }) => void): () => void
  resolveBrowserCommand(id: string, result: BrowserCommandResult): void
  browserRouterReady?(): void
  uiRouterReady?(): void
  /** UI/panel control surface (renderer executes against its store). */
  onUiCommand(cb: (env: { id: string; cmd: UiCommand }) => void): () => void
  resolveUiCommand(id: string, result: UiCommandResult): void
  createWorktree(repoId: string, opts: { name?: string; branch?: string }): Promise<RepoSummary>
  addRepo(dir: string): Promise<RepoSummary>
  removeRepo(repoId: string): Promise<void>
  refreshRepo(repoId: string): Promise<RepoSummary>

  removeWorktree(repoId: string, worktreePath: string, force?: boolean): Promise<RepoSummary>

  openTerminal(worktreePath: string, cwd?: string): Promise<TerminalSession>
  /** Reattach to a daemon-owned session: returns live state + scrollback replay. */
  nativeTerminal(request: import('./native-terminal').NativeTerminalRequest): Promise<import('./native-terminal').NativeTerminalResult>
  onNativeTerminal(callback: (event: import('./native-terminal').NativeTerminalEvent) => void): () => void
  attachTerminal(sessionId: string): Promise<{ session: TerminalSession; scrollback: string; sequence?: number; truncated?: boolean; replay?: import('./terminal-stream').TerminalReplayChunk[] } | null>
  closeTerminal(sessionId: string): Promise<void>
  /** Live daemon-owned sessions (for reattach after app restart). */
  terminalSessions(): Promise<TerminalSession[]>
  terminalWrite(sessionId: string, data: string): Promise<void>
  terminalResize(sessionId: string, cols: number, rows: number): Promise<void>
  /** Send Ctrl-C byte to interrupt a foreground process (Stops a running agent TUI). */
  terminalInterrupt(sessionId: string): Promise<void>
  gitStatus(worktreePath: string): Promise<WorktreeStatus>
  /** Ports + cpu/mem of processes whose cwd is inside the worktree. */
  scanWorktree(worktreePath: string): Promise<{ ports: Array<{ port: number; pid: number; command: string }>; cpuPercent: number; memMB: number }>
  gitStage(worktreePath: string, paths: string[]): Promise<GitPathOperationResult>
  gitUnstage(worktreePath: string, paths: string[]): Promise<GitPathOperationResult>
  gitDiscard(worktreePath: string, paths: string[]): Promise<GitPathOperationResult>
  gitCommit(worktreePath: string, message: string, options?: { amend?: boolean }): Promise<string>
  gitFetch(worktreePath: string): Promise<string>
  gitPush(worktreePath: string): Promise<string>
  gitPull(worktreePath: string): Promise<string>
  gitBranches(worktreePath: string): Promise<GitBranchInfo>
  gitCheckout(worktreePath: string, branch: string): Promise<GitBranchInfo>
  gitCreateBranch(worktreePath: string, branch: string, startPoint?: string): Promise<GitBranchInfo>
  gitHistory(worktreePath: string, options?: { cursor?: string; limit?: number }): Promise<GitHistoryPage>
  gitDiff(worktreePath: string, relPath: string): Promise<string>
  /** Empty ref selects the index. null means absent, not an unreadable object. */
  revealWorkspaceEntry(worktreePath: string, relPath: string): Promise<void>
  workspacePreviewUrl(worktreePath: string, relPath: string): Promise<string>
  readFileAtRef(worktreePath: string, relPath: string, ref?: string): Promise<{ content: string | null }>

  guiDraftsRead(): Promise<Array<[string, string]>>
  guiDraftsWrite(name: string, entries: string): Promise<void>
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  resetSettings(request: SettingsResetRequest): Promise<AppSettings>
  getWorkspaceSession(): Promise<PersistedState['workspaceSession']>
  saveWorkspaceSession(ws: NonNullable<PersistedState['workspaceSession']>): Promise<void>
  listAgents(): Promise<AgentPreset[]>
  projectTasksInspect(workspacePath: string): Promise<import('./agent-runtime').ProjectTasksInspection>
  projectTaskAuthority(workspacePath: string, enabled: boolean): Promise<void>
  projectTaskTool(workspacePath: string, tool: 'lazygit' | 'backlog'): Promise<TerminalSession>
  agentStart(workspacePath: string, command: string | import('./agent-runtime').AgentExecutable, task?: import('./agent-runtime').AgentTaskIntent): Promise<AgentStartResult>
  agentList(): Promise<RunningAgent[]>
  agentSwitchMode(workspacePath: string, sessionId: string, target: 'native' | 'acp', requestId: string, context?: string): Promise<import('./agent-runtime').AgentModeSwitchReceipt>
  agentSwitchResult(workspacePath: string, requestId: string): Promise<import('./agent-runtime').AgentModeSwitchReceipt>
  agentAcpStart(workspacePath: string, requestId: string, loadRunId?: string): Promise<import('./agent-runtime').AcpAgentSnapshot>
  agentAcpList(workspacePath: string): Promise<import('./agent-runtime').AcpAgentSnapshot[]>
  agentAcpObserve(workspacePath: string, sessionId: string, afterSequence?: number): Promise<import('./agent-runtime').AcpObservation>
  agentAcpPrompt(workspacePath: string, sessionId: string, requestId: string, text: string): Promise<import('./agent-runtime').AcpPromptRecord>
  agentAcpControl(workspacePath: string, sessionId: string, operation: 'cancel' | 'stop' | 'permission' | 'dismiss', permissionId?: string, optionId?: string): Promise<import('./agent-runtime').AcpAgentSnapshot>
  agentInterrupt(sessionId: string): Promise<RunningAgent>
  agentStop(sessionId: string): Promise<RunningAgent>
  agentConfigureMemory(workspacePath: string, provider: string, launchArgs?: string[], replacement?: { action: 'preview' } | { action: 'apply'; revision: string }): Promise<AgentMemorySetupResult>
  agentDismiss(sessionId: string): Promise<void>
  openExternal(url: string): Promise<void>
  pickDirectory(): Promise<string | null>
  pickProjectKitPath(kind: 'export' | 'archive' | 'destination'): Promise<string | null>

  /** Sentinel secrets (safeStorage-backed). */
  secretSet(key: string, value: string): Promise<void>
  secretGet(key: string): Promise<string | null>
  secretDelete(key: string): Promise<void>
  secretAvailable(): Promise<boolean>
  // Auto-updater IPC surface
  autoUpdaterCheck(): Promise<boolean>
  autoUpdaterDownload(): Promise<void>
  autoUpdaterQuitAndInstall(): Promise<void>

  /** Independently controls the current attention marker and background-window flash. */
  setAttention(state: AttentionState): void

  on<K extends keyof MainEvents>(event: K, cb: (payload: MainEvents[K]) => void): () => void

  /** Performance monitoring queries */
  perfGetStats(): Promise<{
    ipcCalls: number
    ipcAvg: number
    ipcP95: number
    renders: number
    renderAvg: number
    renderP95: number
    memoryMB: number | null
  }>

  /** Track an analytics event from the renderer. */
  analyticsTrack(
    name: string,
    category: 'app' | 'agent' | 'project' | 'ui' | 'performance' | 'error',
    properties?: Record<string, string | number | boolean | null>
  ): Promise<void>

  /** Session template operations */
  sessionTemplateList(): Promise<Array<{ id: string; name: string; description: string; category: string }>>
  sessionTemplateGet(id: string): Promise<{ id: string; name: string; description: string; category: string } | null>
  sessionTemplateCreate(template: { id: string; name: string; description: string; category: string; systemPrompt?: string }): Promise<{ id: string }>
  sessionTemplateDelete(id: string): Promise<void>

  /** Autonomous agent operations */
  autonomousStart(
    goal: string,
    job?: { workspacePath: string; command: string }
  ): Promise<{
    success: boolean
    finalResult: string
    iterations: number
    totalTokens: number | null
    totalDurationMs: number
    stoppedReason?: string
  }>
  autonomousStop(): Promise<void>
  autonomousActionDecide(actionId: string, approved: boolean): Promise<boolean>
  autonomousState(): Promise<{ iterations: number; totalTokens: number | null; durationMs: number; stopped: boolean }>

  /** Plugin operations */
  pluginList(): Promise<PluginStateView[]>
  pluginInvoke(id: string, method: string, args?: unknown): Promise<unknown>
  pluginUnload(id: string): Promise<void>
  pluginEnable(pluginId: string): Promise<void>
  pluginDisable(pluginId: string): Promise<void>

  /** Event store queries (session replay) */
  eventStoreQuery(filter: { sessionId?: string; type?: string; since?: number }): Promise<Array<Record<string, unknown>>>
  eventStoreAppend(event: Record<string, unknown>): Promise<void>
}

/**
 * Structural view of a discovered plugin for renderer code (mirrors the main
 * process PluginManifest without importing a main-only module).
 */
export interface PluginStateView {
  manifest: {
    id: string
    name: string
    version: string
    description?: string
    author?: string
    main: string
    apiVersion: string
    permissions?: string[]
    commands?: Array<{ id: string; title: string; description?: string }>
  }
  /** User has consented to this plugin running (persisted activation). */
  enabled: boolean
  /** Plugin module is imported and registered right now. */
  active: boolean
}
