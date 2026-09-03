import { useEffect } from 'react'
import { WorktreeSidebar } from './components/WorktreeSidebar'
import { TitlebarTabs } from './components/TitlebarTabs'
import { Workbench } from './components/Workbench'
import { RightSidebar } from './components/RightSidebar'
import { Landing } from './components/Landing'
import { CreateWorktreeModal } from './components/CreateWorktreeModal'
import { CommandPalette } from './components/CommandPalette'
import { SettingsModal } from './components/SettingsModal'
import { Icon } from './components/Icon'
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
      s.setCreateOpen(true)
      break
    case 'command-palette':
      s.setPaletteOpen(true)
      break
    case 'new-terminal': {
      const target = pinnedWorktree()
      if (target) void s.openTerminal(target)
      break
    }
    case 'split-terminal': {
      const target = pinnedWorktree()
      if (target) void s.splitTerminal(target)
      break
    }
    case 'toggle-sidebar':
      s.setSidebarOpen(!s.sidebarOpen)
      break
    case 'toggle-explorer':
      if (s.rightSidebarOpen && s.rightSidebarTab === 'explorer') s.setRightSidebarOpen(false)
      else s.setRightSidebarTab('explorer')
      break
    case 'toggle-git-status':
      if (s.rightSidebarOpen && s.rightSidebarTab === 'git') s.setRightSidebarOpen(false)
      else s.setRightSidebarTab('git')
      break
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

/** Resolve the worktree a global action should pin to: focused, else first non-main, else main. */
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
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const setRightSidebarOpen = useAppStore((s) => s.setRightSidebarOpen)
  const activeWorktreePath = useAppStore((s) => s.activeWorktreePath)
  const repos = useAppStore((s) => s.repos)
  const statuses = useAppStore((s) => s.statuses)
  const runningAgents = useAppStore((s) => s.runningAgents)
  const settings = useAppStore((s) => s.settings)
  const paletteOpen = useAppStore((s) => s.paletteOpen)
  const settingsOpen = useAppStore((s) => s.settingsOpen)

  useEffect(() => {
    // Wire PTY event stream once; terminal data bypasses React entirely.
    initTerminalEvents(
      (sessionId) => {
        useAppStore.getState().applyTerminalExit(sessionId, 0)
      },
      (sessionId, title) => {
        useAppStore.getState().applyTerminalTitle(sessionId, title)
      },
      (sessionId, state, detail) => {
        useAppStore.getState().applyAgentHook(sessionId, state, detail)
      }
    )
    // Repos/worktrees may be mutated by CLI/RPC clients behind our back — resync + prune.
    const offWt = window.orca.on('worktree:changed', () => void useAppStore.getState().syncRepos())
    void load()
    return () => {
      offWt()
    }
  }, [load])

  // Tray/Dock attention dot follows running agents (orcad attention semantics).
  useEffect(() => {
    const agentCount = Object.keys(useAppStore.getState().runningAgents).length
    window.orca.setAttention(agentCount > 0)
  }, [runningAgents])

  // Live status polling: every statusPollMs refresh worktree statuses for the active repo.
  useEffect(() => {
    if (settings.statusPollMs <= 0) return
    const timer = window.setInterval(() => {
      void useAppStore.getState().refreshStatuses()
    }, settings.statusPollMs)
    return () => window.clearInterval(timer)
  }, [settings.statusPollMs])

  // Global keyboard: ⌘K palette, ⌘+Enter run agent, ⌘N new worktree.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const meta = navigator.userAgent.includes('Mac') ? e.metaKey : e.ctrlKey
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        dispatchAction('command-palette')
      } else if (meta && e.key === 'Enter') {
        e.preventDefault()
        dispatchAction('run-agent')
      } else if (meta && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        dispatchAction('new-worktree')
      } else if (meta && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        dispatchAction('toggle-sidebar')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const dirtyCount = activeWorktreePath
    ? (statuses[activeWorktreePath]?.modified ?? 0) + (statuses[activeWorktreePath]?.staged ?? 0)
    : 0
  const agentCount = Object.keys(runningAgents).length

  if (loading) {
    return (
      <div className="app-layout">
        <div className="landing">
          <div className="landing-inner">
            <div className="landing-logo">O</div>
            <p className="landing-sub">Loading donwells.ai…</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app-layout">
      {/* Titlebar strip: traffic-light pad · logo · toggles · terminal tabs · + */}
      <div className="titlebar">
        <div className="titlebar-left-pad" />
        <div className="titlebar-section">
          <span className="titlebar-logo"><span className="logo-dot" />donwells.ai</span>
          <button className="titlebar-icon-button" title="Toggle sidebar" onClick={() => setSidebarOpen(!sidebarOpen)}>
            <Icon name="dir" size={15} />
          </button>
        </div>
        <div id="titlebar-tabs">
          <TitlebarTabs />
        </div>
        <div className="titlebar-section">
          <button
            className="titlebar-icon-button"
            title="Toggle right sidebar"
            style={rightSidebarOpen ? { color: 'var(--foreground)' } : undefined}
            onClick={() => setRightSidebarOpen(!rightSidebarOpen)}
          >
            <Icon name="file" size={15} />
          </button>
        </div>
      </div>

      <div className="app-body">
        {sidebarOpen && <WorktreeSidebar />}
        <div style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {activeWorktreePath ? <Workbench /> : repos.length > 0 ? <Landing /> : <Landing />}
        </div>
        {rightSidebarOpen && <RightSidebar />}
      </div>

      <div className="status-bar">
        <span className="sb-item">{repos.length} repos</span>
        {agentCount > 0 && <span className="sb-item"><span className="spinner" /> {agentCount} agent{agentCount > 1 ? 's' : ''}</span>}
        <span className="sb-spacer" />
        {activeWorktreePath && <span className="sb-item" title={activeWorktreePath}>{activeWorktreePath.split('/').slice(-2).join('/')}</span>}
        {dirtyCount > 0 && <span className="sb-item"><span className="dot dirty" /> {dirtyCount} changed</span>}
      </div>

      {error && (
        <div className="toast error" onClick={() => useAppStore.getState().setError(null)}>{error}</div>
      )}
      <CommandPalette open={paletteOpen} />
      <SettingsModal open={settingsOpen} />
      <CreateWorktreeModal />
    </div>
  )
}
