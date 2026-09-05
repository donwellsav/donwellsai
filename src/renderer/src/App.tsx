import { useEffect } from 'react'

import { WorktreeSidebar } from './components/WorktreeSidebar'
import { TitlebarTabs } from './components/TitlebarTabs'
import { Workbench } from './components/Workbench'
import { RightSidebar } from './components/RightSidebar'
import { Landing } from './components/Landing'
import { CreateWorktreeModal } from './components/CreateWorktreeModal'
import { CommandPalette } from './components/CommandPalette'
import { SettingsModal } from './components/SettingsModal'
import { RunsPanel } from './components/RunsPanel'
import { BrowserHosts } from './components/BrowserHosts'
import { DeleteWorktreeModal } from './components/DeleteWorktreeModal'
import { TerminalCloseDialog } from './components/TerminalCloseDialog'
import { Icon } from './components/Icon'
import { useAppStore } from './store'
import { useAppearance } from './appearance'
import { dispatchAppCommand, installAppShortcuts } from './commands'
import { initTerminalEvents } from './terminal-bus'
import { executeUiCommand } from './agent-ui-commands'
import { ProjectMemoryEditor } from './components/ProjectMemoryEditor'
import { useProjectMemoryEditor } from './project-memory-editor'
import { startEditorRecoveryController } from './editor-recovery'
import { useNavigationHistoryController } from './navigation-controller'
import { ProjectSetupDialog } from './components/ProjectSetupDialog'


export function App() {
  const load = useAppStore((s) => s.load)
  const loading = useAppStore((s) => s.loading)
  const error = useAppStore((s) => s.error)
  const initializationError = useAppStore((s) => s.initializationError)
  const scans = useAppStore((s) => s.scans)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const activeWorktreePath = useAppStore((s) => s.activeWorktreePath)
  const settings = useAppStore((s) => s.settings)
  const paletteOpen = useAppStore((s) => s.paletteOpen)
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const runsOpen = useAppStore((s) => s.runsOpen)

  useAppearance(settings)
  useNavigationHistoryController()

  useEffect(() => {
    // Wire PTY event stream once; terminal data bypasses React entirely.
    const offTerminals = initTerminalEvents(
      (sessionId, exitCode) => {
        useAppStore.getState().applyTerminalExit(sessionId, exitCode)
      },
      (sessionId, title) => {
        useAppStore.getState().applyTerminalTitle(sessionId, title)
      }
    )
    // Repos/worktrees may be mutated by CLI/RPC clients behind our back — resync + prune.
    const offWt = window.donwells.on('worktree:changed', () => void useAppStore.getState().syncRepos())
    // Settings may be mutated by CLI/RPC clients — re-apply live.
    const offSettings = window.donwells.on('settings:changed', ({ settings }) => useAppStore.getState().syncSettings(settings))
    // The native runtime is the authority for every agent lifecycle transition.
    const offAgentChanged = window.donwells.on('agent:changed', ({ run }) => {
      useAppStore.getState().applyAgentRun(run)
    })
    const offAgentDismissed = window.donwells.on('agent:dismissed', ({ sessionId }) => {
      useAppStore.getState().applyAgentDismissed(sessionId)
    })
    // Menu accelerators route through the same dispatch as keyboard shortcuts.
    const offMenu = window.donwells.on('menu:action', ({ action }) => dispatchAppCommand(action))
    // Agents drive panels/settings over the runtime RPC (ui.* / settings.set).
    const offUi = window.donwells.onUiCommand(async ({ id, cmd }) => {
      try {
        const result = await executeUiCommand(cmd)
        window.donwells.resolveUiCommand(id, { ok: true, result })
      } catch (e) {
        window.donwells.resolveUiCommand(id, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    })
    window.donwells.uiRouterReady?.()
    startEditorRecoveryController(window.donwells)
    const offMemory = window.donwells.on('project-memory:changed', () => useProjectMemoryEditor.getState().refresh())
    void load()
    return () => {
      offMemory()
      offWt()
      offSettings()
      offAgentChanged()
      offAgentDismissed()
      offMenu()
      offUi()
      offTerminals()
    }
  }, [load])

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

  useEffect(() => installAppShortcuts(), [])


  if (loading) {
    return (
      <div className="app-layout">
        <div className="landing">
          <div className="landing-inner">
            <div className="landing-logo" aria-label="donwells.ai">dw</div>
            <p className="landing-sub">Loading donwells.ai…</p>
          </div>
        </div>
      </div>
    )
  }

  if (initializationError) {
    return (
      <main className="app-layout">
        <div className="landing"><div className="landing-inner">
          <h1 className="landing-title">Workspace could not be loaded</h1>
          <p className="landing-sub">Your saved projects have not been replaced. Retry the connection before continuing.</p>
          <p className="lifecycle-error" role="alert">{initializationError}</p>
          <button className="btn btn-primary" onClick={() => void load()}>Retry loading workspace</button>
        </div></div>
      </main>
    )
  }

  return (
    <div className="app-layout">
      <header className="titlebar">
        {/Mac/.test(navigator.userAgent) && <div className="titlebar-left-pad" />}
        <div className="titlebar-section">
          <button className="titlebar-logo" aria-label="Go to Projects" onClick={() => useAppStore.getState().setActiveRepo(null)}>donwells.ai</button>
          <button className="titlebar-icon-button" aria-label={sidebarOpen ? 'Hide projects sidebar' : 'Show projects sidebar'} aria-pressed={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}><Icon name="panelLeft" size={16} /></button>
        </div>


      </header>
      <div className="app-body">
        {sidebarOpen && <WorktreeSidebar />}
        <div className={`workspace-stage${runsOpen ? ' workspace-stage-hidden' : ''}`}>
          {activeWorktreePath && <div id="titlebar-tabs"><TitlebarTabs /></div>}
          {activeWorktreePath ? <Workbench /> : <Landing />}
          <BrowserHosts />
        </div>
        {runsOpen && <RunsPanel />}
        {rightSidebarOpen && !runsOpen && <RightSidebar />}
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
      <ProjectSetupDialog />
      <DeleteWorktreeModal />
      <TerminalCloseDialog />
      <ProjectMemoryEditor />
    </div>
  )
}
