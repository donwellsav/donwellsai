import { assertProjectMemoryDraftSaved } from './project-memory-editor'
import type { UiCommand } from '@shared/types'
import { flushWorkspaceSession, useAppStore } from './store'
import { flushAllPreviewModels, getEditorDocument } from './editor-models'

/**
 * Executes agent UI-control commands (runtime RPC `ui.*`) against the store:
 * the same actions the keyboard, palette, and pane chrome use.
 */
export async function executeUiCommand(cmd: UiCommand): Promise<unknown> {
  const s = useAppStore.getState()
  switch (cmd.op) {
    case 'state': {
      return {
        activeRepoId: s.activeRepoId,
        activeWorktreePath: s.activeWorktreePath,
        repos: s.repos.map((r) => ({ id: r.repo.id, path: r.repo.path, worktrees: r.worktrees.map((w) => w.path) })),
        panes: s.panes,
        activePane: s.activePane,
        layouts: s.layouts,
        terminalOrder: s.terminalOrder,
        runningAgents: s.runningAgents,
        sidebar: { open: s.sidebarOpen, width: s.sidebarWidth },
        rightSidebar: { open: s.rightSidebarOpen, tab: s.rightSidebarTab, width: s.rightSidebarWidth },
        paletteOpen: s.paletteOpen,
        settings: s.settings,
        settingsOpen: s.settingsOpen,
        settingsSection: s.settingsSection,
        runsOpen: s.runsOpen,
        runsSection: s.runsSection
      }
    }
    case 'activate': {
      if (cmd.worktreePath) {
        const repo = s.repos.find((r) => r.worktrees.some((w) => w.path === cmd.worktreePath) || r.repo.path === cmd.worktreePath)
        if (!repo) throw new Error(`no repo owns worktree ${cmd.worktreePath}`)
        s.setActiveRepo(repo.repo.id)
        s.setActiveWorktree(cmd.worktreePath === repo.repo.path ? null : cmd.worktreePath)
        return { activeRepoId: repo.repo.id, activeWorktreePath: cmd.worktreePath }
      }
      if (cmd.repoId) {
        if (!s.repos.some((r) => r.repo.id === cmd.repoId)) throw new Error(`unknown repo ${cmd.repoId}`)
        s.setActiveRepo(cmd.repoId)
        return { activeRepoId: cmd.repoId }
      }
      throw new Error('activate needs worktreePath or repoId')
    }
    case 'terminal.open': {
      const session = await s.openTerminal(cmd.worktreePath)
      if (!session) throw new Error(`could not open terminal in ${cmd.worktreePath}`)
      s.selectTerminal(cmd.worktreePath, session.id)
      return { key: `term:${session.id}`, sessionId: session.id }
    }
    case 'split':
      await s.splitTerminal(cmd.worktreePath)
      return {}
    case 'pane.focus': {
      const pane = (s.panes[cmd.worktreePath] ?? []).find((p) => p.key === cmd.key)
      if (!pane) throw new Error(`no pane ${cmd.key} in ${cmd.worktreePath}`)
      s.setActivePane(cmd.worktreePath, cmd.key)
      if (pane.kind === 'terminal' && pane.sessionId) s.selectTerminal(cmd.worktreePath, pane.sessionId)
      return {}
    }
    case 'pane.close':
      if (!(await s.closePane(cmd.worktreePath, cmd.key))) throw new Error(useAppStore.getState().error ?? 'Pane could not be closed')
      return {}
    case 'pane.resize':
      s.resizeSplit(cmd.worktreePath, cmd.splitId, cmd.pct)
      return {}
    case 'preview.open':
      await s.openPreview(cmd.worktreePath, cmd.relPath)
      return {}
    case 'preview.close':
      if (!(await s.closePreview(cmd.worktreePath, cmd.relPath))) throw new Error('Editor has unsaved changes')
      return {}
    case 'editor.open':
      await s.openPreview(cmd.worktreePath, cmd.relPath)
      return {}
    case 'diff.open':
      s.openDiff(cmd.worktreePath, cmd.relPath)
      return { key: `diff:${cmd.relPath}` }
    case 'editor.write': {
      await s.writePreview(cmd.worktreePath, cmd.relPath, cmd.content)
      return { bytes: new TextEncoder().encode(cmd.content).length }
    }
    case 'editor.read': {
      const files = s.previews[cmd.worktreePath]
      const buffer = cmd.relPath ? files?.[cmd.relPath] : files ? Object.values(files)[0] : undefined
      if (buffer) {
        const document = getEditorDocument(cmd.worktreePath, buffer.path)
        return document ? { ...buffer, content: document.model.getValue() } : buffer
      }
      if (!cmd.relPath) throw new Error('no editor open in this worktree')
      return window.donwells.readFile(cmd.worktreePath, cmd.relPath)
    }
    case 'sidebar': {
      if (cmd.side === 'left') {
        s.setSidebarOpen(cmd.open === 'toggle' ? !s.sidebarOpen : (cmd.open ?? true))
        if (cmd.width !== undefined) s.setSidebarWidth(cmd.width)
        return { open: cmd.open === 'toggle' ? !s.sidebarOpen : (cmd.open ?? true) }
      }
      const open = cmd.open === 'toggle' ? !s.rightSidebarOpen : (cmd.open ?? true)
      s.setRightSidebarOpen(open)
      if (cmd.tab) s.setRightSidebarTab(cmd.tab)
      if (cmd.width !== undefined) s.setRightSidebarWidth(cmd.width)
      return { open }
    }
    case 'palette': {
      const open = cmd.open === 'toggle' || cmd.open === undefined ? !s.paletteOpen : cmd.open
      s.setPaletteOpen(open, cmd.mode)
      return { open }
    }
    case 'settings.open':
      s.openSettings(cmd.section ?? s.settingsSection)
      return {}
    case 'runs.open':
      s.openRuns(cmd.section)
      return {}
    case 'workspace.flush':
      assertProjectMemoryDraftSaved()
      await flushAllPreviewModels()
      await flushWorkspaceSession()
      return {}
  }
}
