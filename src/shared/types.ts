// Contracts shared across main, preload, and renderer.

export type Repo = {
  id: string
  path: string
  addedAt: string
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

/** Per-worktree git status snapshot (porcelain v1 --branch parse). */
export type WorktreeStatus = {
  branch: string
  /** ahead of upstream / behind upstream, when the branch has one */
  ahead: number
  behind: number
  staged: number
  modified: number
  untracked: number
  conflicts: number
  /** relative paths, one per changed file (staged/modified/conflicted/untracked) */
  changedFiles: string[]
  /** raw porcelain v1 lines for diff view / detail */
  raw: string[]
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

export type AgentPreset = {
  name: string
  command: string
  detected: boolean
}

export type AppMeta = {
  version: string
  shell: string
  userDataDir: string
}

/** A running agent bound to a worktree terminal. */
export type RunningAgent = {
  sessionId: string
  worktreePath: string
  agent: string
  startedAt: string
  /** Agent hook state: working (default) | permission | done | note */
  state: 'working' | 'permission' | 'done' | 'note'
  /** Free-form hook payload (e.g. permission reason). */
  detail?: string
}

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
}

export type TerminalThemeName = 'tomorrow-night' | 'dracula' | 'solarized-dark' | 'github-dark'

/** Settings modal sections (nav rail). */
export type SettingsSection = 'general' | 'terminal' | 'editor' | 'skills' | 'automations' | 'orchestration'
/** How an editor pane shows a markdown file. */
export type PreviewMode = 'edit' | 'preview'

export type AppSettings = {
  agentCommand: string
  /** app chrome theme (dark-only UI; terminal palettes live in terminalTheme) */
  theme: 'dark'
  fontSize: number
  /** terminal font family override (Orca terminalFontFamily); empty = default stack */
  fontFamily?: string
  /** cursor: block | bar | underline (Orca terminalCursorStyle) */
  cursorStyle?: 'block' | 'bar' | 'underline'
  cursorBlink?: boolean
  /** xterm scrollback lines for NEW terminals (live terminals keep theirs) */
  scrollback?: number
  /** copy selection to clipboard on mouse-up (Orca terminalCopyOnSelect) */
  copyOnSelect?: boolean
  /** terminal ANSI palette (Orca terminalTheme) */
  terminalTheme?: TerminalThemeName
  /** editor word wrap */
  editorWordWrap?: 'on' | 'off'
  /** editor minimap */
  editorMinimap?: boolean
  /** editor tab size */
  editorTabSize?: 2 | 4 | 8
  /** markdown files open rendered instead of source */
  markdownPreviewDefault?: boolean
  /** worktree/git status poll interval; 0 disables polling */
  statusPollMs: number
}

// Persisted state (subset of orca-data.json; lite keeps user intent + settings, never derived state)
/** Binary split tree, persisted shape (mirrors the renderer's LayoutNode). */
export type PersistedLayoutNode =
  | { kind: 'leaf'; pane: string }
  | { kind: 'split'; dir: 'row' | 'col'; first: PersistedLayoutNode; second: PersistedLayoutNode; size?: number }


export type PersistedState = {
  schemaVersion: 1
  repos: Repo[]
  settings: Partial<AppSettings>
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
    /** persisted chrome widths (panel resizing) */
    ui?: { sidebarWidth?: number; rightSidebarWidth?: number }
    /**
     * Agent chips keyed by PTY session id. Restored only when the daemon still
     * owns the session — a chip must never outlive the process it tracks.
     */
    runningAgents?: Record<string, RunningAgent>
    /** per repo id: pane lists + active pane key + active terminal session */
    repos: Record<string, {
      panes: Record<string, Array<{ key: string; kind: 'terminal' | 'explorer' | 'git-status' | 'preview' | 'diff' | 'browser'; sessionId?: string; file?: string; url?: string }>>
      activePane: Record<string, string>
      activeTerminal: Record<string, string>
      terminalOrder: Record<string, string[]>
      layouts: Record<string, PersistedLayoutNode>
      activeWorktreePath: string | null
    }>
  }
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

/** An installed agent skill (markdown doc under userData/skills). */
export type SkillMeta = {
  name: string
  source: string
  installedAt: string
  size: number
}

// IPC events main -> renderer
export type MainEvents = {
  'terminal:data': { sessionId: string; data: string }
  'terminal:exit': { sessionId: string; exitCode: number }
  'terminal:title': { sessionId: string; title: string }
  'worktree:changed': { repoId: string }
  /** Agent hook envelope: state ∈ working|permission|done|note. */
  'terminal:hook': { sessionId: string; state: string; detail: string }
  /** Menu/accelerator actions routed to the renderer (palette, new worktree, ...) */
  'menu:action': { action: string }
  /** Settings mutated by an RPC/CLI client — renderer re-applies live. */
  'settings:changed': { settings: AppSettings }
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
  | { op: 'sidebar'; side: 'left' | 'right'; open?: boolean | 'toggle'; tab?: 'explorer' | 'git'; width?: number }
  | { op: 'palette'; open?: boolean | 'toggle' }
  | { op: 'settings.open'; section?: SettingsSection }

export type UiCommandResult = { ok: true; result: unknown } | { ok: false; error: string }

export type IpcApi = {
  meta(): Promise<AppMeta>
  listRepos(): Promise<RepoSummary[]>
  /** Browser control surface (renderer executes on its webviews). */
  onBrowserCommand(cb: (env: { id: string; cmd: BrowserCommand }) => void): () => void
  resolveBrowserCommand(id: string, result: BrowserCommandResult): void
  browserRegisterPanes(keys: string[]): void
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
  attachTerminal(sessionId: string): Promise<{ session: TerminalSession; scrollback: string } | null>
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
  gitStage(worktreePath: string, paths: string[]): Promise<void>
  gitUnstage(worktreePath: string, paths: string[]): Promise<void>
  gitDiscard(worktreePath: string, paths: string[]): Promise<void>
  gitCommit(worktreePath: string, message: string): Promise<string>
  gitPush(worktreePath: string): Promise<string>
  gitPull(worktreePath: string): Promise<string>
  gitBranches(worktreePath: string): Promise<{ current: string; all: string[] }>
  gitCheckout(worktreePath: string, branch: string): Promise<void>
  gitDiff(worktreePath: string, relPath: string): Promise<string>
  readFile(worktreePath: string, relPath: string): Promise<FileContent>
  /** Working-tree counterpart at a git ref (diff editor's left side). null = absent at ref. */
  readFileAtRef(worktreePath: string, relPath: string, ref?: string): Promise<{ content: string | null }>
  writeFile(worktreePath: string, relPath: string, content: string): Promise<FileContent>
  listFiles(worktreePath: string, prefix?: string): Promise<FileEntry[]>
  listAllFiles(worktreePath: string): Promise<FileEntry[]>

  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  getWorkspaceSession(): Promise<PersistedState['workspaceSession']>
  saveWorkspaceSession(ws: NonNullable<PersistedState['workspaceSession']>): Promise<void>
  listAgents(): Promise<AgentPreset[]>
  openExternal(url: string): Promise<void>
  pickDirectory(): Promise<string | null>

  /** Sentinel secrets (safeStorage-backed). */
  secretSet(key: string, value: string): Promise<void>
  secretGet(key: string): Promise<string | null>
  secretDelete(key: string): Promise<void>
  secretAvailable(): Promise<boolean>
  /** Tray/Dock attention dot: true while any agent runs. */
  setAttention(on: boolean): void

  /** Skills registry (agent-skill passthrough). */
  skillsList(): Promise<SkillMeta[]>
  skillsInstall(source: string): Promise<SkillMeta>
  skillsRemove(name: string): Promise<void>
  /** Automations (scheduler + persisted runs). */
  automationsList(): Promise<Automation[]>
  automationSave(a: Automation): Promise<void>
  automationRemove(id: string): Promise<void>
  automationRunNow(id: string): Promise<void>
  automationRuns(id: string): Promise<AutomationRun[]>

  /** Orchestration (fan-out agent runs across worktrees). */
  orchestrationList(): Promise<OrchestrationRun[]>
  orchestrationStart(name: string, command: string, worktreePaths: string[], parallel: number): Promise<OrchestrationRun | null>
  orchestrationCancel(id: string): Promise<void>
  on<K extends keyof MainEvents>(event: K, cb: (payload: MainEvents[K]) => void): () => void
}