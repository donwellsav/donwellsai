import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { WorktreeGrid } from './components/WorktreeGrid'
import { CommandPalette } from './components/CommandPalette'
import { SettingsModal } from './components/SettingsModal'
import { useAppStore } from './store'
import { initTerminalEvents } from './terminal-bus'

/** Actions reachable from the menu, ⌘K palette, and keyboard shortcuts. */
export function dispatchAction(action: string): void {
  const s = useAppStore.getState()
  switch (action) {
    case 'add-repo':
      void (async () => {
        const dir = await window.orca.pickDirectory()
        if (dir) void s.addRepo(dir)
      })()
      break
    case 'new-worktree':
      s.setPaletteOpen(false)
      s.setActiveWorktree(null)
      break
    case 'command-palette':
      s.setPaletteOpen(true)
      break
    case 'new-terminal':
    case 'split-terminal': {
      const wt = s.activeWorktreePath ?? s.activeRepoId ? null : null
      void wt
      // open in the focused worktree card: use the first visible worktree if none focused
      const repo = s.repos.find((r) => r.repo.id === s.activeRepoId)
      const target = repo?.worktrees.find((w) => w.path === s.activeWorktreePath) ?? repo?.worktrees.find((w) => !w.isMain) ?? repo?.worktrees[0]
      if (target) void s.openTerminal(target.path)
      break
    }
    case 'toggle-explorer': {
      const target = pinnedWorktree()
      if (target) s.togglePane(target, 'explorer')
      break
    }
    case 'toggle-git-status': {
      const target = pinnedWorktree()
      if (target) s.togglePane(target, 'git-status')
      break
    }
    case 'run-agent': {
      const target = pinnedWorktree()
      if (target) void s.runAgent(target, s.settings.agentCommand)
      break
    }
    case 'settings':
      s.setSettingsOpen(true)
      break
  }
}

/** Resolve the worktree a global action should pin to: focused card, else first non-main, else main. */
function pinnedWorktree(): string | null {
  const s = useAppStore.getState()
  const repo = s.repos.find((r) => r.repo.id === s.activeRepoId)
  if (!repo || repo.worktrees.length === 0) return null
  if (s.activeWorktreePath) return s.activeWorktreePath
  const nonMain = repo.worktrees.find((w) => !w.isMain)
  const main = repo.worktrees.find((w) => w.isMain)
  return (nonMain ?? main)?.path ?? null
}

export function App() {
  const load = useAppStore((s) => s.load)
  const loading = useAppStore((s) => s.loading)
  const error = useAppStore((s) => s.error)
  const setError = useAppStore((s) => s.setError)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const paletteOpen = useAppStore((s) => s.paletteOpen)
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const settings = useAppStore((s) => s.settings)

  useEffect(() => {
    // Wire PTY event stream once; terminal data bypasses React entirely.
    initTerminalEvents(
      (sessionId) => {
        useAppStore.getState().applyTerminalExit(sessionId, 0)
      },
      (sessionId, title) => {
        useAppStore.getState().applyTerminalTitle(sessionId, title)
      }
    )
    // Menu accelerators + any keyboard shortcuts route through dispatchAction.
    const offMenu = window.orca.on('menu:action', ({ action }) => dispatchAction(action))
    const offData = window.orca.on('terminal:data', () => {})
    void offData
    void load()
    return () => {
      offMenu()
    }
  }, [load])

  // Live status polling: every statusPollMs refresh worktree statuses for the active repo.
  useEffect(() => {
    if (!activeRepoId || settings.statusPollMs <= 0) return
    const timer = window.setInterval(() => {
      void useAppStore.getState().refreshStatuses()
    }, settings.statusPollMs)
    return () => window.clearInterval(timer)
  }, [activeRepoId, settings.statusPollMs])

  // Global keyboard: ⌘K palette, ⌘+Enter run agent, ⌘N new worktree focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      const k = e.key.toLowerCase()
      if (k === 'k') {
        e.preventDefault()
        useAppStore.getState().setPaletteOpen(!useAppStore.getState().paletteOpen)
      } else if (k === 'enter') {
        e.preventDefault()
        dispatchAction('run-agent')
      } else if (k === 'n') {
        e.preventDefault()
        dispatchAction('new-worktree')
      } else if (k === ',') {
        e.preventDefault()
        dispatchAction('settings')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        {loading ? (
          <div className="loading">Loading Orca Lite…</div>
        ) : (
          <WorktreeGrid key={activeRepoId ?? 'none'} />
        )}
      </main>
      {error && (
        <div className="error-toast" onClick={() => setError(null)} title={error}>
          {error}
        </div>
      )}
      <CommandPalette open={paletteOpen} />
      <SettingsModal open={settingsOpen} />
    </div>
  )
}