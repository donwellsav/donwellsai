import { useEffect } from 'react'

import { WorkspaceShell } from './components/WorkspaceShell'
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
    const tick = () => {
      if (document.hidden) return
      const st = useAppStore.getState()
      void st.refreshStatuses()
      if (st.activeWorktreePath) void st.refreshScan(st.activeWorktreePath)
    }
    const timer = window.setInterval(tick, settings.statusPollMs)
    const onVisible = () => { if (!document.hidden) tick() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
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
      <WorkspaceShell>
        <div className={`workspace-stage${runsOpen ? ' workspace-stage-hidden' : ''}`} tabIndex={-1}>
          <Workbench />
          {!activeWorktreePath && <Landing />}
          <BrowserHosts />
        </div>
        {runsOpen && <RunsPanel />}
        {rightSidebarOpen && !runsOpen && <RightSidebar />}
      </WorkspaceShell>

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
