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

// Persisted state (subset of orca-data.json; lite keeps only user intent, never derived state)
export type PersistedState = {
  schemaVersion: 1
  repos: Repo[]
  settings: {
    agentCommand: string // default command used by "launch agent" in a worktree terminal
  }
}

// IPC events main -> renderer
export type MainEvents = {
  'terminal:data': { sessionId: string; data: string }
  'terminal:exit': { sessionId: string; exitCode: number }
  'terminal:title': { sessionId: string; title: string }
  'terminal:worktree-changed': { sessionId: string; worktreePath: string }
  'worktree:changed': { repoId: string }
}

export type IpcApi = {
  meta(): Promise<AppMeta>
  listRepos(): Promise<RepoSummary[]>
  addRepo(dir: string): Promise<RepoSummary>
  removeRepo(repoId: string): Promise<void>
  refreshRepo(repoId: string): Promise<RepoSummary>

  createWorktree(repoId: string, opts: { name?: string; branch?: string }): Promise<RepoSummary>
  removeWorktree(repoId: string, worktreePath: string): Promise<RepoSummary>

  openTerminal(worktreePath: string, cwd?: string): Promise<TerminalSession>
  closeTerminal(sessionId: string): Promise<void>
  terminalWrite(sessionId: string, data: string): Promise<void>
  terminalResize(sessionId: string, cols: number, rows: number): Promise<void>

  listAgents(): Promise<AgentPreset[]>
  pickDirectory(): Promise<string | null>

  on<K extends keyof MainEvents>(event: K, cb: (payload: MainEvents[K]) => void): () => void
}