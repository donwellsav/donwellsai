import { useEffect } from 'react'
import { WorktreeSidebar } from './components/WorktreeSidebar'
import { TitlebarTabs } from './components/TitlebarTabs'
import { Workbench } from './components/Workbench'
import { RightSidebar } from './components/RightSidebar'
import { Landing } from './components/Landing'
import { CreateWorktreeModal } from './components/CreateWorktreeModal'
import { CommandPalette } from './components/CommandPalette'
import { SettingsModal } from './components/SettingsModal'
import { DeleteWorktreeModal } from './components/DeleteWorktreeModal'
import { Icon } from './components/Icon'
import { isMarkdownFile, useAppStore } from './store'
import { initTerminalEvents } from './terminal-bus'
import { executeUiCommand } from './agent-ui-commands'

/** Actions reachable from the menu, ⌘K palette, and keyboard shortcuts. `arg` = tab index for select-tab. */
export function dispatchAction(action: string, arg?: number): void {
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
      s.openSettings('general')
      break
    case 'close-active-pane': {
      const target = s.activeWorktreePath
      const key = target ? s.activePane[target] : ''
      if (target && key) s.closePane(target, key)
      break
    }
    case 'select-tab': {
      const target = pinnedWorktree()
      if (!target) break
      const tabs = (s.panes[target] ?? []).filter(
        (p) => p.kind === 'terminal' || p.kind === 'preview' || p.kind === 'browser'
      )
      const pane = arg !== undefined ? tabs[arg] : undefined
      if (pane) s.setActivePane(target, pane.key)
      break
    }
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
  const scans = useAppStore((s) => s.scans)
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
    // Settings may be mutated by CLI/RPC clients — re-apply live.
    const offSettings = window.orca.on('settings:changed', ({ settings }) => useAppStore.setState({ settings }))
    // Menu accelerators route through the same dispatch as keyboard shortcuts.
    const offMenu = window.orca.on('menu:action', ({ action }) => dispatchAction(action))
    // Agents drive panels/settings over the runtime RPC (ui.* / settings.set).
    const offUi = window.orca.onUiCommand(async ({ id, cmd }) => {
      try {
        const result = await executeUiCommand(cmd)
        window.orca.resolveUiCommand(id, { ok: true, result })
      } catch (e) {
        window.orca.resolveUiCommand(id, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    })
    void load()
    return () => {
      offWt()
      offSettings()
      offMenu()
      offUi()
    }
  }, [load])

  // Tray/Dock attention dot follows RUNNING agents only (done chips don't count).
  useEffect(() => {
    const active = Object.values(runningAgents).filter((a) => a.state !== 'done').length
    window.orca.setAttention(active > 0)
  }, [runningAgents])

  // Live status polling: every statusPollMs refresh worktree statuses for the active repo.
  useEffect(() => {
    if (settings.statusPollMs <= 0) return
    const timer = window.setInterval(() => {
      const st = useAppStore.getState()
      void st.refreshStatuses()
      if (st.activeWorktreePath) void st.refreshScan(st.activeWorktreePath)
    }, settings.statusPollMs)
    return () => window.clearInterval(timer)
  }, [settings.statusPollMs])

  // Global keyboard: ⌘K/⌘P palette, ⌘↩ run agent, ⌘N new worktree, ⌘B sidebar,
  // ⌘T/⌘W tabs, ⌘1–9 tab switch, ⌘, settings. Tab actions are inert
  // while a modal owns the screen so keystrokes can't hit hidden panes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const meta = navigator.userAgent.includes('Mac') ? e.metaKey : e.ctrlKey
      if (!meta) return
      const st = useAppStore.getState()
      const modalOpen = st.paletteOpen || st.settingsOpen || st.createOpen
      const k = e.key.toLowerCase()
      if (k === 'k' || k === 'p') {
        e.preventDefault()
        dispatchAction('command-palette')
      } else if (e.key === 'Enter') {
        e.preventDefault()
        dispatchAction('run-agent')
      } else if (k === 'n') {
        e.preventDefault()
        dispatchAction('new-worktree')
      } else if (k === 'b') {
        e.preventDefault()
        dispatchAction('toggle-sidebar')
      } else if (k === 'v' && e.shiftKey) {
        // ⌘⇧V flips the active markdown editor between source and rendered preview (VS Code parity)
        const wt = st.activeWorktreePath
        const pane = wt ? (st.panes[wt] ?? []).find((p) => p.key === st.activePane[wt]) : undefined
        if (wt && pane?.kind === 'preview' && pane.file && isMarkdownFile(pane.file)) {
          e.preventDefault()
          const cur = st.previews[wt]?.[pane.file]?.mode ?? 'edit'
          st.setPreviewMode(wt, pane.file, cur === 'preview' ? 'edit' : 'preview')
        }
      } else if (e.key === ',') {
        e.preventDefault()
        dispatchAction('settings')
      } else if (modalOpen) {
        return
      } else if (k === 't') {
        e.preventDefault()
        dispatchAction('new-terminal')
      } else if (k === 'w') {
        e.preventDefault()
        dispatchAction('close-active-pane')
      } else if (/^[1-9]$/.test(e.key)) {
        e.preventDefault()
        dispatchAction('select-tab', Number(e.key) - 1)
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
            <Icon name="panelLeft" size={15} />
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
            <Icon name="panelRight" size={15} />
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
        {activeWorktreePath && <span className="sb-item" title={activeWorktreePath}>{activeWorktreePath.split('/').slice(-2).join('/')}</span>}
        <span className="sb-spacer" />
        {(scans[activeWorktreePath ?? '']?.ports ?? []).map((p) => (
          <button
            key={p.port}
            className="sb-port"
            title={`${p.command} listening on :${p.port} — open in browser pane`}
            onClick={() => void useAppStore.getState().openBrowser(activeWorktreePath!, `http://localhost:${p.port}`)}
          >
            <Icon name="bolt" size={11} /> {p.port}
          </button>
        ))}
        {(() => {
          const u = scans[activeWorktreePath ?? '']
          return u && (u.cpuPercent > 0 || u.memMB > 0) ? (
            <span className="sb-item sb-usage" title={`worktree processes: ${u.cpuPercent}% cpu, ${u.memMB} MB ram`}>
              <Icon name="activity" size={11} /> {u.cpuPercent}% · {u.memMB}M
            </span>
          ) : null
        })()}
      </div>

      {error && (
        <div className="toast error" onClick={() => useAppStore.getState().setError(null)}>{error}</div>
      )}
      <CommandPalette open={paletteOpen} />
      <SettingsModal open={settingsOpen} />
      <CreateWorktreeModal />
      <DeleteWorktreeModal />
    </div>
  )
}
