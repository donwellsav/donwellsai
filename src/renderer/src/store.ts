import { create } from 'zustand'
import type { AgentPreset, RepoSummary, TerminalSession } from '@shared/types'

type TerminalView = {
  session: TerminalSession
  /** current cols/rows the xterm instance is rendered at (for resize sync) */
  cols: number
  rows: number
}

type AppState = {
  repos: RepoSummary[]
  loading: boolean
  error: string | null
  activeRepoId: string | null
  activeWorktreePath: string | null
  terminals: Record<string, TerminalView>
  /** order of terminal ids per worktree path, for tabs */
  terminalOrder: string[]
  agents: AgentPreset[]
  agentCommand: string

  load(): Promise<void>
  addRepo(dir: string): Promise<void>
  removeRepo(repoId: string): Promise<void>
  refresh(repoId?: string): Promise<void>
  createWorktree(name?: string, branch?: string): Promise<void>
  removeWorktree(worktreePath: string): Promise<void>

  openTerminal(worktreePath: string): Promise<TerminalSession | null>
  closeTerminal(sessionId: string): void
  writeTerminal(sessionId: string, data: string): void
  resizeTerminal(sessionId: string, cols: number, rows: number): void
  runInSession(sessionId: string, command: string): void

  setActiveRepo(repoId: string | null): void
  setActiveWorktree(path: string | null): void
  applyTerminalData(sessionId: string, data: string): void
  applyTerminalExit(sessionId: string, exitCode: number): void
  applyTerminalTitle(sessionId: string, title: string): void
  setError(err: string | null): void
}

export const useAppStore = create<AppState>((set, get) => ({
  repos: [],
  loading: false,
  error: null,
  activeRepoId: null,
  activeWorktreePath: null,
  terminals: {},
  terminalOrder: [],
  agents: [],
  agentCommand: 'codex',

  async load() {
    set({ loading: true, error: null })
    try {
      const [repos, agents] = await Promise.all([window.orca.listRepos(), window.orca.listAgents()])
      const state: Partial<AppState> = { repos, agents, loading: false }
      if (repos.length > 0 && !get().activeRepoId) state.activeRepoId = repos[0]!.repo.id
      set(state)
    } catch (e) {
      set({ loading: false, error: String(e) })
    }
  },

  async addRepo(dir: string) {
    try {
      const summary = await window.orca.addRepo(dir)
      const repos = [...get().repos.filter((r) => r.repo.id !== summary.repo.id), summary]
      set({ repos, activeRepoId: summary.repo.id, error: null })
    } catch (e) {
      set({ error: String(e) })
    }
  },

  async removeRepo(repoId: string) {
    await window.orca.removeRepo(repoId)
    set({ repos: get().repos.filter((r) => r.repo.id !== repoId) })
    if (get().activeRepoId === repoId) set({ activeRepoId: get().repos[0]?.repo.id ?? null })
  },

  async refresh(repoId?: string) {
    try {
      const id = repoId ?? get().activeRepoId
      if (!id) return
      const summary = await window.orca.refreshRepo(id)
      set({ repos: get().repos.map((r) => (r.repo.id === id ? summary : r)), error: null })
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

  async removeWorktree(worktreePath: string) {
    const repoId = get().activeRepoId
    if (!repoId) return
    try {
      const summary = await window.orca.removeWorktree(repoId, worktreePath)
      set({ repos: get().repos.map((r) => (r.repo.id === repoId ? summary : r)), error: null })
    } catch (e) {
      set({ error: String(e) })
    }
  },

  async openTerminal(worktreePath: string) {
    try {
      const session = await window.orca.openTerminal(worktreePath)
      set((s) => ({
        terminals: { ...s.terminals, [session.id]: { session, cols: 100, rows: 30 } },
        terminalOrder: [...s.terminalOrder, session.id],
        activeWorktreePath: worktreePath,
        error: null
      }))
      return session
    } catch (e) {
      set({ error: String(e) })
      return null
    }
  },

  closeTerminal(sessionId: string) {
    void window.orca.closeTerminal(sessionId)
    set((s) => {
      const terminals = { ...s.terminals }
      delete terminals[sessionId]
      return { terminals, terminalOrder: s.terminalOrder.filter((id) => id !== sessionId) }
    })
  },

  writeTerminal(sessionId: string, data: string) {
    void window.orca.terminalWrite(sessionId, data)
  },

  resizeTerminal(sessionId: string, cols: number, rows: number) {
    set((s) => ({ terminals: { ...s.terminals, [sessionId]: { ...s.terminals[sessionId]!, cols, rows } } }))
    void window.orca.terminalResize(sessionId, cols, rows)
  },

  runInSession(sessionId: string, command: string) {
    get().writeTerminal(sessionId, command.endsWith('\n') ? command : `${command}\n`)
  },

  setActiveRepo(repoId: string | null) {
    set({ activeRepoId: repoId, activeWorktreePath: null })
  },

  setActiveWorktree(path: string | null) {
    set({ activeWorktreePath: path })
  },

  applyTerminalData(sessionId: string, data: string) {
    // sessions are rendered by components that subscribe to their own buffers; see TerminalPane
    void sessionId
    void data
  },

  applyTerminalExit(sessionId: string) {
    set({
      terminals: Object.fromEntries(
        Object.entries(get().terminals).map(([id, t]) => [
          id,
          id === sessionId ? { ...t, session: { ...t.session, exited: true } } : t
        ])
      )
    })
  },

  applyTerminalTitle(sessionId: string, title: string) {
    set({
      terminals: Object.fromEntries(
        Object.entries(get().terminals).map(([id, t]) => [
          id,
          id === sessionId ? { ...t, session: { ...t.session, title } } : t
        ])
      )
    })
  },

  setError(err: string | null) {
    set({ error: err })
  }
}))