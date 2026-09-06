import { useState, type ReactNode } from 'react'
import { useAppStore } from '../store'
import { agentPresentation } from '@shared/agent-presentation'
import { orderedWorkspacePaths, pathBasename } from '../workspace-navigation'
import { appCommandPlatform, formatAppShortcut } from '@shared/app-commands'
import { dispatchAppCommand } from '../commands'
import { openProjectSetup } from '../project-setup'
import { WorkspaceControls } from './Workbench'
import { ProjectActions } from './ProjectActions'
import { Icon } from './Icon'
import './workspace-shell.css'

/** Workspace chrome owns navigation only. Native processes and documents stay in their existing stores. */
export function WorkspaceShell({ children }: { children: ReactNode }) {
  const repos = useAppStore(state => state.repos)
  const activePath = useAppStore(state => state.activeWorktreePath)
  const navigation = useAppStore(state => state.workspaceNavigation)
  const statuses = useAppStore(state => state.statuses)
  const sidebarOpen = useAppStore(state => state.sidebarOpen)
  const sidebarWidth = useAppStore(state => state.sidebarWidth)
  const commandChord = useAppStore(state => state.settings.keyboardShortcutOverrides['command-palette']) ?? 'Mod+K'
  const runsOpen = useAppStore(state => state.runsOpen)
  const rightOpen = useAppStore(state => state.rightSidebarOpen)
  const rightTab = useAppStore(state => state.rightSidebarTab)
  const runningAgents = useAppStore(state => state.runningAgents)
  const scans = useAppStore(state => state.scans)
  const [openingFolder, setOpeningFolder] = useState(false)
  const selectedRepo = repos.find(repo => repo.worktrees.some(worktree => worktree.path === activePath))
  const selectedWorktree = selectedRepo?.worktrees.find(worktree => worktree.path === activePath)
  const agents = Object.values(runningAgents).filter(agent => selectedRepo?.worktrees.some(worktree => worktree.path === agent.workspacePath))
  const waiting = agents.filter(agent => agentPresentation(agent).needsAttention)
  const order = orderedWorkspacePaths(repos, navigation)
  const status = activePath ? statuses[activePath] : undefined
  const changed = status ? status.staged + status.modified + status.untracked : null
  const scan = activePath ? scans[activePath] : undefined
  const state = useAppStore.getState

  const openFolder = async (): Promise<void> => {
    if (openingFolder) return
    setOpeningFolder(true)
    try {
      const directory = await window.donwells.pickDirectory()
      if (directory) await state().addRepo(directory)
    } catch (error) { state().setError(String(error)) }
    finally { setOpeningFolder(false) }
  }
  const showTool = (tab: 'explorer' | 'git' | 'memory' | 'recovery'): void => {
    state().setRunsOpen(false)
    if (rightOpen && rightTab === tab) state().setRightSidebarOpen(false)
    else state().setRightSidebarTab(tab)
  }

  return <>
    <header className="workspace-masthead">
      {/Mac/.test(navigator.userAgent) && <div className="workspace-window-controls" />}
      <button className="workspace-wordmark" onClick={() => state().setActiveRepo(null)} aria-label="Go to Projects">donwells<span aria-hidden="true"> /</span></button>
      <div className="workspace-breadcrumb" aria-label="Current project">
        <span>{selectedRepo ? pathBasename(selectedRepo.repo.path) : 'Projects'}</span>
        {selectedWorktree && <><span className="workspace-slash" aria-hidden="true">/</span><span title={activePath ?? ''}>{navigation.renames[activePath!] ?? (selectedRepo?.repo.kind === 'folder' ? 'Local folder' : status?.branch || selectedWorktree.branch || 'Detached checkout')}</span></>}
      </div>
      <button aria-label="Find a command" className="workspace-command-search titlebar-search" onClick={() => state().setPaletteOpen(true)}><Icon name="search" size={14} /><span>Find a command</span><kbd>{formatAppShortcut(commandChord, appCommandPlatform(navigator.platform))}</kbd></button>
      {activePath && <div className="workspace-context-actions">
        {waiting.length > 0 && <button className="workspace-attention" onClick={() => void state().focusAgentSession(waiting[0]!.sessionId)}>{waiting.length} waiting</button>}
        <button className="workspace-action" onClick={() => void state().openTerminal(activePath)}><Icon name="terminal" size={14} /><span>Terminal</span></button>
        <button className="workspace-action" onClick={() => dispatchAppCommand('show-agents')}><Icon name="plus" size={14} /><span>Add agent</span></button>
        <WorkspaceControls />
      </div>}
      <button className="workspace-icon-control" aria-label="Settings" onClick={() => dispatchAppCommand('settings')}><Icon name="gear" size={17} /></button>
    </header>
    <div className="workspace-frame">
      <nav className="workspace-rail" aria-label="Workspace tools">
        <button aria-label="Projects" title="Projects" aria-pressed={sidebarOpen} onClick={() => state().setSidebarOpen(!sidebarOpen)}><Icon name="panelLeft" size={19} /><span>Projects</span></button>
        <button aria-label="Files" title="Files" disabled={!activePath} aria-pressed={rightOpen && rightTab === 'explorer' && !runsOpen} onClick={() => showTool('explorer')}><Icon name="dir" size={19} /><span>Files</span></button>
        <button aria-label="Changes" title="Changes" disabled={!activePath || selectedRepo?.repo.kind === 'folder'} aria-pressed={rightOpen && rightTab === 'git' && !runsOpen} onClick={() => showTool('git')}><Icon name="git" size={19} /><span>Changes</span></button>
        <button aria-label="Project memory" title="Project memory" disabled={!activePath} aria-pressed={rightOpen && rightTab === 'memory' && !runsOpen} onClick={() => showTool('memory')}><Icon name="file" size={19} /><span>Memory</span></button>
        <button aria-label="Agent sessions" title="Agent sessions" aria-pressed={runsOpen} onClick={() => runsOpen ? state().setRunsOpen(false) : dispatchAppCommand('show-agents')}><Icon name="terminal" size={19} /><span>Agents</span></button>
        <div className="workspace-rail-spacer" />
        <button aria-label="Recover unsaved files" title="Recover unsaved files" aria-pressed={rightOpen && rightTab === 'recovery' && !runsOpen} onClick={() => showTool('recovery')}><Icon name="clock" size={18} /><span>Recover</span></button>
      </nav>
      {sidebarOpen && <aside className="workspace-projects" aria-label="Projects and checkouts" style={{ width: sidebarWidth, flexBasis: sidebarWidth }}>
        <header><h2>Projects</h2><button className="workspace-icon-control" aria-label="New project" onClick={() => openProjectSetup()}><Icon name="plus" size={17} /></button></header>
        <button className="workspace-open-folder" onClick={() => void openFolder()} disabled={openingFolder}><Icon name="dir" size={15} />{openingFolder ? 'Opening…' : 'Open folder'}<span aria-hidden="true">↗</span></button>
        <div className="workspace-project-scroll">
          {repos.length === 0 && <p className="workspace-help">Open a folder to bring its terminals, agents and tools together.</p>}
          {repos.map(repo => {
            const collapsed = navigation.collapsedRepoIds.includes(repo.repo.id)
            const worktrees = repo.worktrees.filter(worktree => !navigation.hiddenPaths.includes(worktree.path)).sort((a,b) => Number(navigation.pinnedPaths.includes(b.path)) - Number(navigation.pinnedPaths.includes(a.path)) || order.indexOf(a.path) - order.indexOf(b.path))
            return <section className="workspace-project" key={repo.repo.id}>
              <div className="workspace-project-heading">
                <button aria-expanded={!collapsed} onClick={() => state().toggleRepoCollapsed(repo.repo.id)}><Icon name={collapsed ? 'chevrons' : 'down'} size={12} /><strong>{pathBasename(repo.repo.path)}</strong></button>
                <ProjectActions repo={repo} />
              </div>
              {!collapsed && <div className="workspace-checkouts">
                {worktrees.map(worktree => {
                  const current = worktree.path === activePath
                  const git = statuses[worktree.path]
                  return <div className={`workspace-checkout${current ? ' is-current' : ''}`} key={worktree.path}>
                    <button className="workspace-checkout-open" aria-current={current ? 'page' : undefined} title={worktree.path} onClick={() => { state().setActiveRepo(repo.repo.id); state().setActiveWorktree(worktree.path) }}>
                      <span className="workspace-checkout-line"><Icon name={repo.repo.kind === 'folder' ? 'dir' : 'git'} size={13} /><span>{navigation.renames[worktree.path] ?? (worktree.isMain ? 'Main checkout' : pathBasename(worktree.path))}</span>{navigation.pinnedPaths.includes(worktree.path) && <span aria-label="Pinned">•</span>}</span>
                      <small>{repo.repo.kind === 'folder' ? 'Local folder' : git?.branch || worktree.branch || 'Detached'}{git?.conflicts ? ` · ${git.conflicts} conflicts` : ''}</small>
                    </button>
                    <details className="workspace-checkout-actions"><summary aria-label={`Actions for ${pathBasename(worktree.path)}`}>···</summary><div>
                      <button onClick={() => state().toggleWorkspacePinned(worktree.path)}>{navigation.pinnedPaths.includes(worktree.path) ? 'Unpin' : 'Pin'}</button>
                      <button onClick={() => state().moveWorkspace(worktree.path, -1)}>Move up</button>
                      <button onClick={() => state().moveWorkspace(worktree.path, 1)}>Move down</button>
                      <form onSubmit={event => { event.preventDefault(); state().renameWorkspace(worktree.path, String(new FormData(event.currentTarget).get('label') ?? '')); event.currentTarget.closest('details')?.removeAttribute('open') }}>
                        <label>Checkout label<input name="label" aria-label={`Label for ${pathBasename(worktree.path)}`} defaultValue={navigation.renames[worktree.path] ?? ''} maxLength={80} /></label><button type="submit">Save label</button>
                      </form>
                      <button onClick={() => state().hideWorkspace(worktree.path)}>Hide checkout</button>
                      {!worktree.isMain && repo.repo.kind !== 'folder' && <button onClick={() => state().setDeleteTarget(worktree.path)}>Move to Trash…</button>}
                    </div></details>
                  </div>
                })}
                {repo.repo.kind !== 'folder' && <button className="workspace-add-checkout" onClick={() => { state().setActiveRepo(repo.repo.id); state().setCreateOpen(true) }}><Icon name="plus" size={12} />New worktree</button>}
              </div>}
            </section>
          })}
          {navigation.hiddenPaths.length > 0 && <button className="workspace-add-checkout" onClick={() => state().restoreWorkspace()}>Show hidden checkouts ({navigation.hiddenPaths.length})</button>}
        </div>
        <div className="workspace-project-footer"><span>On your computer</span><button className="workspace-icon-control" aria-label="Refresh projects" onClick={() => dispatchAppCommand('refresh-workspace')}><Icon name="refresh" size={14} /></button></div>
        <div className="workspace-project-resize" role="separator" aria-label="Resize project navigation" aria-orientation="vertical" aria-valuemin={220} aria-valuemax={340} aria-valuenow={Math.round(Math.min(340, Math.max(220, sidebarWidth)))} tabIndex={0}
          onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId) }}
          onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) state().setSidebarWidth(Math.min(340, Math.max(220, event.clientX - event.currentTarget.parentElement!.getBoundingClientRect().left))) }}
          onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)}
          onKeyDown={event => { if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) { event.preventDefault(); state().setSidebarWidth(event.key === 'Home' ? 220 : event.key === 'End' ? 340 : Math.min(340, Math.max(220, sidebarWidth + (event.key === 'ArrowLeft' ? -16 : 16)))) } }} />
      </aside>}
      <div className="workspace-desk">
        <div className="workspace-surfaces">{children}</div>
        <footer className="workspace-footing">
          <span>{activePath ? selectedRepo?.repo.kind === 'folder' ? 'Local folder' : status?.conflicts ? `${status.conflicts} conflicts` : changed === null ? 'Reading changes…' : changed === 0 ? 'Working tree clean' : `${changed} changed ${changed === 1 ? 'file' : 'files'}` : 'Local workspace'}</span>
          <div className="workspace-footing-spacer" />
          {scan?.ports.map(port => <button key={port.port} title={`${port.command} — open preview`} onClick={() => activePath && void state().openBrowser(activePath, `http://localhost:${port.port}`)}><Icon name="globe" size={12} />:{port.port}</button>)}
          {scan && <span title="Processes in this checkout">{scan.memMB} MB · {scan.cpuPercent}% CPU</span>}
        </footer>
      </div>
    </div>
  </>
}
