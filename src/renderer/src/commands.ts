import {
  appCommand,
  appCommandPlatform,
  createAppShortcutMatcher,
  type AppCommand,
  type AppCommandId
} from '@shared/app-commands'
import { DEFAULT_SETTINGS, steppedTerminalFontSize } from '@shared/settings'
import { isMarkdownFile, useAppStore } from './store'
import { requestTerminalFind } from './terminal-ui'
import { requestPaletteFileScope } from './global-navigator'
import { focusPaneTarget, getNavigationCapabilities, navigateHistory, switchNavigationMru } from './navigation-controller'
import { moveWorkspacePane, restoreWorkspaceLayout, workspaceTabKeys } from './workspace-layout'
import { nextWaitingSession } from '@shared/agent-presentation'
import { openProjectSetup } from './project-setup'
import { openAttentionInbox } from './attention-inbox'

export type CommandContext = Pick<ReturnType<typeof useAppStore.getState>,
  'repos' | 'activeRepoId' | 'activeWorktreePath' | 'panes' | 'activePane' | 'runsOpen' | 'settings'> & Partial<Pick<ReturnType<typeof useAppStore.getState>, 'previews' | 'providerCatalog'>>

/** A global action never targets a workspace outside the selected project. */
export function pinnedWorktree(state: CommandContext = useAppStore.getState()): string | null {
  const repo = state.repos.find((candidate) => candidate.repo.id === state.activeRepoId)
  if (!repo) return null
  if (repo.worktrees.some((worktree) => worktree.path === state.activeWorktreePath)) return state.activeWorktreePath
  return (repo.worktrees.find((worktree) => !worktree.isMain) ?? repo.worktrees[0])?.path ?? null
}

export function commandUnavailableReason(id: AppCommandId, state: CommandContext = useAppStore.getState()): string | undefined {
  const target = pinnedWorktree(state)
  const active = state.activeWorktreePath
  const registered = active && state.repos.some((repo) => repo.worktrees.some((worktree) => worktree.path === active))
  const visible = registered && !state.runsOpen
  const pane = visible ? state.panes[active]?.find((item) => item.key === state.activePane[active]) : undefined
  switch (id) {
    case 'new-worktree':
      return state.repos.some((repo) => repo.repo.kind !== 'folder') ? undefined : 'Add a Git repository to create a worktree.'
    case 'new-terminal':
    case 'split-terminal':
      return target ? undefined : 'Select a registered workspace first.'
    case 'run-agent': {
      // Availability now depends on an admitted default instance, not on a
      // configured command string.
      if (!target) return 'Select a registered workspace first.'
      if ((state.providerCatalog?.defaultInstanceId ?? null) === null) return 'Choose a default provider instance in Settings → Agents.'
      return undefined
    }
    case 'global-navigator':
      return state.repos.length > 0 ? undefined : 'Add a project to search across workspaces.'
    case 'navigate-back':
      return getNavigationCapabilities().canGoBack ? undefined : 'There is no earlier location in this project.'
    case 'navigate-forward':
      return getNavigationCapabilities().canGoForward ? undefined : 'There is no later location in this project.'
    case 'switch-mru-next':
    case 'switch-mru-previous':
      return getNavigationCapabilities().canSwitchMru ? undefined : 'Open another location in this project first.'
    case 'show-project-search':
      return registered ? undefined : 'Open a registered workspace to search.'
    case 'show-computer-control':
      return registered ? undefined : 'Open a registered workspace to use computer control.'
    case 'show-project-memory':
      return registered ? undefined : 'Open a registered workspace to view project memory.'
    case 'show-editor-recovery':
      return undefined
    case 'quick-open':
    case 'toggle-explorer':
      return registered ? undefined : 'Open a workspace to browse files.'
    case 'toggle-git-status':
      return registered && state.repos.some((repo) => repo.repo.kind !== 'folder' && repo.worktrees.some((worktree) => worktree.path === active)) ? undefined : 'Open a Git workspace for source control.'
    case 'find':
      return pane?.kind === 'terminal' || pane?.kind === 'preview' && pane.file && isMarkdownFile(pane.file) && active && state.previews?.[active]?.[pane.file]?.mode === 'preview' ? undefined : 'Focus a terminal, or use the active view’s Find control.'
    case 'stop-active-process':
      return pane?.sessionId ? undefined : 'Focus a terminal process first.'
    case 'layout-focus':
    case 'layout-pair':
    case 'layout-build':
    case 'layout-review':
      return visible ? undefined : 'Open a workspace first.'
    case 'move-pane-left':
    case 'move-pane-right':
    case 'move-pane-up':
    case 'move-pane-down':
    case 'close-active-pane':
      return pane ? undefined : 'Open a workspace tab first.'
    case 'focus-next-pane':
    case 'focus-previous-pane':
      return visible && (state.panes[active]?.length ?? 0) > 1 ? undefined : 'Open another workspace tab first.'
    case 'toggle-markdown-preview':
      return pane?.kind === 'preview' && pane.file && isMarkdownFile(pane.file) ? undefined : 'Open a Markdown document first.'
    case 'refresh-workspace':
      return target ? undefined : 'Select a registered workspace first.'
    default:
      if (id.startsWith('select-tab-')) {
        const index = Number(id.slice('select-tab-'.length)) - 1
        return visible && numberedTabs(active)[index] ? undefined : 'That workspace tab is not open.'
      }
      return undefined
  }
}

function numberedTabs(path: string): string[] {
  const state = useAppStore.getState(), panes = state.panes[path] ?? []
  return workspaceTabKeys(restoreWorkspaceLayout(state.docking[path], panes, state.layouts[path]).layout, panes, state.activePane[path])
}
function selectTab(commandId: AppCommandId): boolean {
  if (!commandId.startsWith('select-tab-')) return false
  const state = useAppStore.getState(), path = state.activeWorktreePath
  const key = path ? numberedTabs(path)[Number(commandId.slice('select-tab-'.length)) - 1] : undefined
  if (path && key) { state.setActivePane(path, key); void focusPaneTarget() }
  return true
}

/** Menu, command-palette, and keyboard commands all enter through this dispatcher. */
export function dispatchAppCommand(action: string): void {
  const command = appCommand(action)
  if (!command || !commandAllowedWhileModalOpen(command)) return
  const state = useAppStore.getState()
  const unavailable = commandUnavailableReason(command.id, state)
  if (unavailable) {
    useAppStore.setState({ error: unavailable })
    return
  }
  if (selectTab(command.id)) return
  switch (command.id) {
    case 'next-waiting-session': {
      const repo = state.repos.find(item => item.repo.id === state.activeRepoId)
      const path = state.activeWorktreePath
      const current = path ? state.panes[path]?.find(pane => pane.key === state.activePane[path])?.sessionId : undefined
      const next = nextWaitingSession(Object.values(state.runningAgents), repo?.worktrees.map(worktree => worktree.path) ?? [], current)
      if (next) void state.focusAgentSession(next.sessionId).then(focused => { if (!focused) state.setError('The waiting terminal is no longer available.') }).catch(error => state.setError(String(error)))
      else state.setError('No live sessions are waiting for input in this project.')
      break
    }
    case 'new-project':
      state.setPaletteOpen(false)
      openProjectSetup()
      break
    case 'add-repo':
      void (async () => {
        const directory = await window.donwells.pickDirectory()
        if (directory) await useAppStore.getState().addRepo(directory)
      })()
      break
    case 'new-worktree':
      state.setPaletteOpen(false)
      state.setCreateOpen(true)
      break
    case 'quick-open':
      requestPaletteFileScope('active')
      state.setPaletteOpen(true, 'files')
      break
    case 'global-navigator':
      requestPaletteFileScope('global')
      state.setPaletteOpen(true, 'files')
      break
    case 'command-palette':
      state.setPaletteOpen(true, 'commands')
      break
    case 'navigate-back':
      void navigateHistory(-1)
      break
    case 'navigate-forward':
      void navigateHistory(1)
      break
    case 'switch-mru-next':
      void switchNavigationMru(1)
      break
    case 'switch-mru-previous':
      void switchNavigationMru(-1)
      break
    case 'new-terminal': {
      const worktreePath = pinnedWorktree()
      if (worktreePath) void state.openTerminal(worktreePath)
      break
    }
    case 'split-terminal': {
      const worktreePath = pinnedWorktree()
      if (worktreePath) void state.splitTerminal(worktreePath)
      break
    }
    case 'find': {
      const worktreePath = state.activeWorktreePath
      const paneKey = worktreePath ? state.activePane[worktreePath] : undefined
      const pane = worktreePath ? state.panes[worktreePath]?.find((candidate) => candidate.key === paneKey) : undefined
      if (pane?.kind === 'terminal' && pane.sessionId) requestTerminalFind(pane.sessionId)
      else if (pane?.file) window.dispatchEvent(new CustomEvent('donwells:document-find', { detail: { worktreePath, file: pane.file } }))
      break
    }
    case 'focus-next-pane':
    case 'focus-previous-pane': {
      const worktreePath = state.activeWorktreePath
      if (worktreePath) {
        state.focusRelativePane(worktreePath, command.id === 'focus-next-pane' ? 1 : -1)
        void focusPaneTarget()
      }
      break
    }
    case 'move-pane-left':
    case 'move-pane-right':
    case 'move-pane-up':
    case 'move-pane-down': {
      const path = state.activeWorktreePath
      if (path && state.activePane[path]) {
        const panes = state.panes[path] ?? []
        const layout = restoreWorkspaceLayout(state.docking[path], panes, state.layouts[path]).layout
        state.saveDocking(path, moveWorkspacePane(layout, panes, state.activePane[path]!, command.id.slice(10) as 'left' | 'right' | 'up' | 'down'))
      }
      break
    }
    case 'stop-active-process': {
      const path = state.activeWorktreePath
      if (path && state.activePane[path]) state.requestClosePane(path, state.activePane[path]!)
      break
    }
    case 'layout-focus':
    case 'layout-pair':
    case 'layout-build':
    case 'layout-review':
      if (state.activeWorktreePath) state.arrangeWorkspace(state.activeWorktreePath, command.id.slice(7) as 'focus' | 'pair' | 'build' | 'review')
      break
    case 'close-active-pane': {
      const worktreePath = state.activeWorktreePath
      const paneKey = worktreePath ? state.activePane[worktreePath] : undefined
      if (worktreePath && paneKey) state.requestClosePane(worktreePath, paneKey)
      break
    }
    case 'toggle-sidebar':
      state.setSidebarOpen(!state.sidebarOpen)
      break
    case 'toggle-explorer':
      state.setRightSidebarTab('explorer', true)
      break
    case 'toggle-git-status':
      state.setRightSidebarTab('git', true)
      break
    case 'toggle-markdown-preview': {
      const worktreePath = state.activeWorktreePath
      const pane = worktreePath
        ? (state.panes[worktreePath] ?? []).find((candidate) => candidate.key === state.activePane[worktreePath])
        : undefined
      if (worktreePath && pane?.kind === 'preview' && pane.file && isMarkdownFile(pane.file)) {
        const mode = state.previews[worktreePath]?.[pane.file]?.mode ?? 'edit'
        void state.setPreviewMode(worktreePath, pane.file, mode === 'preview' ? 'edit' : 'preview')
      }
      break
    }
    case 'run-agent': {
      const worktreePath = pinnedWorktree()
      // The default provider instance is the launch authority after the Stage 3
      // cutover. A missing default is a configuration-required state, not a
      // reason to fall back to a command string.
      const defaultInstanceId = state.providerCatalog?.defaultInstanceId ?? null
      if (worktreePath && defaultInstanceId !== null) void state.launchProviderInstance(worktreePath, defaultInstanceId)
      break
    }
    case 'refresh-workspace':
      if (state.activeRepoId) void state.refresh(state.activeRepoId)
      if (state.activeWorktreePath) {
        void state.refreshExplorer(state.activeWorktreePath)
        void state.refreshScan(state.activeWorktreePath)
      }
      void state.refreshStatuses()
      break
    case 'show-agents':
      state.openRuns('agents')
      break
    case 'show-project-search':
      state.setPaletteOpen(false)
      state.setRightSidebarTab('search')
      requestAnimationFrame(() => [...document.querySelectorAll<HTMLInputElement>('.project-search input[type=search]')].find(input => input.offsetParent !== null)?.focus())
      break
    case 'show-computer-control':
      state.setRightSidebarTab('computer')
      break
    case 'show-project-memory':
      state.setRightSidebarTab('memory')
      break
    case 'show-editor-recovery':
      state.setRightSidebarTab('recovery')
      break
    case 'show-parallel-runs':
      state.openRuns('orchestration')
      break
    case 'show-scheduled-runs':
      state.openRuns('automations')
      break
    case 'show-attention-inbox':
      openAttentionInbox()
      break
    case 'increase-terminal-font-size':
      void state.setSettings({ terminalFontSize: steppedTerminalFontSize(state.settings.terminalFontSize, 1) })
      break
    case 'decrease-terminal-font-size':
      void state.setSettings({ terminalFontSize: steppedTerminalFontSize(state.settings.terminalFontSize, -1) })
      break
    case 'reset-terminal-font-size':
      void state.setSettings({ terminalFontSize: DEFAULT_SETTINGS.terminalFontSize })
      break
    case 'toggle-quick-terminal':
      if (state.quickTerminalSessionId) void state.closeQuickTerminal()
      else void state.openQuickTerminal()
      break
    case 'settings':
      state.openSettings(state.settingsSection)
      break
    default:
      break
  }
}

function commandAllowedWhileModalOpen(command: AppCommand): boolean {
  const state = useAppStore.getState()
  if (state.settingsOpen || state.createOpen || state.deleteTarget || state.closeRequest) return false
  if (typeof document !== 'undefined' && document.querySelector('dialog[open]:not(.palette-dialog)')) return false
  return !state.paletteOpen || command.allowWhilePaletteOpen === true
}

function commandAppliesInContext(command: AppCommand): boolean {
  return commandUnavailableReason(command.id) === undefined
}

/** Install one live shortcut resolver. Settings changes rebuild its matcher in place. */
export function installAppShortcuts(): () => void {
  const platform = appCommandPlatform(navigator.platform || navigator.userAgent)
  let matcher = createAppShortcutMatcher(useAppStore.getState().settings.keyboardShortcutOverrides, platform)
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (state.settings.keyboardShortcutOverrides !== previous.settings.keyboardShortcutOverrides) {
      matcher = createAppShortcutMatcher(state.settings.keyboardShortcutOverrides, platform)
    }
  })
  const onKeyDown = (event: KeyboardEvent): void => {
    const command = matcher(event)
    if (!command || !commandAllowedWhileModalOpen(command) || !commandAppliesInContext(command)) return
    event.preventDefault()
    event.stopPropagation()
    dispatchAppCommand(command.id)
  }
  window.addEventListener('keydown', onKeyDown, true)
  return () => {
    unsubscribe()
    window.removeEventListener('keydown', onKeyDown, true)
  }
}
