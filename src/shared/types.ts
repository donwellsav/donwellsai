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

export type AppSettings = {
  agentCommand: string
  /** terminal theme: dark default; future themes land here */
  theme: 'dark'
  fontSize: number
  /** poll interval for per-worktree git status, ms; 0 = off */
  statusPollMs: number
}

// Persisted state (subset of orca-data.json; lite keeps user intent + settings, never derived state)
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
    /** per repo id: pane lists + active pane key + active terminal session */
    repos: Record<string, {
      panes: Record<string, Array<{ key: string; kind: 'terminal' | 'explorer' | 'git-status' | 'preview' | 'browser'; sessionId?: string; file?: string; url?: string }>>
      activePane: Record<string, string>
      activeTerminal: Record<string, string>
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
  'terminal:worktree-changed': { sessionId: string; worktreePath: string }
  'worktree:changed': { repoId: string }
  /** Agent hook envelope: state ∈ working|permission|done|note. */
  'terminal:hook': { sessionId: string; state: string; detail: string }
  /** Menu/accelerator actions routed to the renderer (palette, new worktree, ...) */
  'menu:action': { action: string }
}

export type IpcApi = {
  meta(): Promise<AppMeta>
  listRepos(): Promise<RepoSummary[]>
  addRepo(dir: string): Promise<RepoSummary>
  removeRepo(repoId: string): Promise<void>
  refreshRepo(repoId: string): Promise<RepoSummary>

  createWorktree(repoId: string, opts: { name?: string; branch?: string }): Promise<RepoSummary>
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
  listFiles(worktreePath: string, prefix?: string): Promise<FileEntry[]>

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
  skillsRead(name: string): Promise<string | null>

  /** Automations (scheduler + persisted runs). */
  automationsList(): Promise<Automation[]>
  automationSave(a: Automation): Promise<void>
  automationRemove(id: string): Promise<void>
  automationRunNow(id: string): Promise<void>
  automationRuns(id: string): Promise<AutomationRun[]>
  on<K extends keyof MainEvents>(event: K, cb: (payload: MainEvents[K]) => void): () => void
}