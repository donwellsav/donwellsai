import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useAppStore } from '../store'
import { PopupMenu } from 'flexlayout-react'
import { moveWorkspaceNavigation, orderedWorkspacePaths, pathBasename } from '../workspace-navigation'
import { dispatchAppCommand } from '../commands'
import { openProjectSetup } from '../project-setup'
import type { RepoSummary } from '@shared/types'
import { ProjectRemovalDialog } from './ProjectActions'
import { ModalDialog } from './ModalDialog'
import { Icon } from './Icon'
import './workspace-shell.css'

/** Workspace chrome owns navigation only. Native processes and documents stay in their existing stores. */
export function WorkspaceShell({ children, leftPanel }: { children: ReactNode; leftPanel?: ReactNode }) {
  const repos = useAppStore(state => state.repos)
  const activePath = useAppStore(state => state.activeWorktreePath)
  const navigation = useAppStore(state => state.workspaceNavigation)
  const statuses = useAppStore(state => state.statuses)
  const sidebarOpen = useAppStore(state => state.sidebarOpen)
  const sidebarWidth = useAppStore(state => state.sidebarWidth)
  const railCollapsed = useAppStore(state => state.railCollapsed)
  const projectListPercent = useAppStore(state => state.projectListPercent)
  const frame = useRef<HTMLDivElement>(null)
  const [availableWidth, setAvailableWidth] = useState(window.innerWidth - 44)
  useLayoutEffect(() => {
    const node = frame.current
    if (!node) return
    const rail = node.querySelector<HTMLElement>('.workspace-rail')!
    const measure = () => setAvailableWidth(node.clientWidth - rail.offsetWidth)
    const observer = new ResizeObserver(measure)
    observer.observe(node); observer.observe(rail); measure()
    return () => observer.disconnect()
  }, [])
  const minimumWidth = leftPanel ? 260 : 220
  const maximumWidth = Math.max(minimumWidth, Math.min(620, availableWidth - 320))
  const navigationWidth = Math.max(minimumWidth, Math.min(sidebarWidth, maximumWidth))
  const runsOpen = useAppStore(state => state.runsOpen)
  const runsSection = useAppStore(state => state.runsSection)
  const rightOpen = useAppStore(state => state.rightSidebarOpen)
  const rightTab = useAppStore(state => state.rightSidebarTab)
  const runningAgents = useAppStore(state => state.runningAgents)
  const panes = useAppStore(state => activePath ? state.panes[activePath] : undefined)
  const activePane = useAppStore(state => activePath ? state.activePane[activePath] : undefined)
  const [openingFolder, setOpeningFolder] = useState(false)
  const [menu, setMenu] = useState<HTMLButtonElement | null>(null)
  const [checkoutMenu, setCheckoutMenu] = useState<{ anchor: HTMLElement; repo: RepoSummary; path: string } | null>(null)
  const [removeProject, setRemoveProject] = useState<RepoSummary | null>(null)
  const [rename, setRename] = useState<{ path: string; label: string } | null>(null)
  const menuRepo = checkoutMenu && repos.find(repo => repo.repo.id === checkoutMenu.repo.repo.id)
  const menuWorktree = menuRepo?.worktrees.find(worktree => worktree.path === checkoutMenu?.path)
  const selectedRepo = repos.find(repo => repo.worktrees.some(worktree => worktree.path === activePath))
  const agents = Object.values(runningAgents).filter(agent => selectedRepo?.worktrees.some(worktree => worktree.path === agent.workspacePath))
  const waiting = agents.filter(agent => agent.liveness === 'live' && (agent.activity === 'waiting' || agent.activity === 'permission'))
  const order = orderedWorkspacePaths(repos, navigation)
  const status = activePath ? statuses[activePath] : undefined
  const changed = status ? status.staged + status.modified + status.untracked : null
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
  const showTool = (tab: 'explorer' | 'git' | 'memory' | 'recovery' | 'search' | 'computer'): void => {
    state().setRightSidebarTab(tab, true)
  }
  const toolVisible = (tab: Parameters<typeof showTool>[0]): boolean => !runsOpen && (
    (rightOpen && rightTab === tab) || panes?.find(pane => pane.key === activePane)?.kind === (tab === 'git' ? 'git-status' : tab)
  )

  return <>
    <div className="workspace-frame" ref={frame}>
      <nav className={`workspace-rail${railCollapsed ? ' is-collapsed' : ''}`} aria-label="Workspace navigation">
        <button className="workspace-rail-toggle" aria-label={railCollapsed ? 'Expand navigation' : 'Collapse navigation'} title={railCollapsed ? 'Show workspace navigation' : 'Collapse the navigation rail; keep your panels open'} aria-expanded={!railCollapsed} onClick={() => state().setRailCollapsed(!railCollapsed)}><Icon name={railCollapsed ? 'right' : 'left'} size={16} /><span>Collapse</span></button>
        <button aria-label="Projects" title="Show or hide projects and checkouts" aria-pressed={sidebarOpen} onClick={() => state().setSidebarOpen(!sidebarOpen)}><Icon name="projects" size={19} /><span>Projects</span></button>
        <button aria-label="Search" title="Search files, code, documents and memory" disabled={!activePath} aria-pressed={toolVisible('search')} onClick={() => showTool('search')}><Icon name="search" size={19} /><span>Search</span></button>

        <button aria-label="Files" title={activePath ? 'Browse and edit files in the selected checkout' : 'Select a checkout to browse its files'} disabled={!activePath} aria-pressed={toolVisible('explorer')} onClick={() => showTool('explorer')}><Icon name="dir" size={19} /><span>Files</span></button>
        <button aria-label="Git" title={!activePath ? 'Select a project to use Git' : selectedRepo?.repo.kind === 'folder' ? 'This folder is not a Git repository' : `Git source control${changed ? ` · ${changed} changed files` : ''}`} disabled={!activePath || selectedRepo?.repo.kind === 'folder'} aria-pressed={toolVisible('git')} onClick={() => showTool('git')}><Icon name="git" size={19} /><span>Git</span></button>
        <button aria-label="Agents" title="Start AI agents and return to their sessions" aria-pressed={runsOpen && runsSection === 'agents'} onClick={() => runsOpen && runsSection === 'agents' ? state().setRunsOpen(false) : dispatchAppCommand('show-agents')}><Icon name="robot" size={19} /><span>Agents</span>{waiting.length > 0 && <small className="workspace-attention-count" aria-label={`${waiting.length} sessions need attention`}>{waiting.length}</small>}</button>
        <button aria-label="Automations" title="Run commands across projects or on a schedule" aria-pressed={runsOpen && runsSection !== 'agents'} onClick={() => runsOpen && runsSection !== 'agents' ? state().setRunsOpen(false) : dispatchAppCommand('show-scheduled-runs')}><Icon name="clock" size={19} /><span>Automations</span></button>
        <button aria-label="Browser" title="Open the project preview in the built-in browser" disabled={!activePath} aria-pressed={!runsOpen && panes?.some(pane => pane.key === activePane && pane.kind === 'browser') === true} onClick={() => { if (!activePath) return; state().setRunsOpen(false); void state().openBrowser(activePath).catch(error => state().setError(String(error))) }}><Icon name="globe" size={19} /><span>Browser</span></button>
        <div className="workspace-rail-spacer" />
        <button aria-label="Settings" title="Configure appearance, shortcuts, agents, and project tools" onClick={() => dispatchAppCommand('settings')}><Icon name="gear" size={18} /><span>Settings</span></button>
      </nav>
      {sidebarOpen && <aside className={`workspace-projects${leftPanel ? ' workspace-projects-with-tool' : ''}`} aria-label="Projects and checkouts" style={{ width: navigationWidth, flexBasis: navigationWidth }}>
        <header><h2 className="workspace-tool-title">Projects</h2><button className="workspace-icon-control" aria-label="Add project" title="Open a folder or create a project" aria-haspopup="menu" aria-expanded={!!menu} onClick={event => setMenu(event.currentTarget)}><Icon name="plus" size={14} /></button></header>
        <div className="workspace-project-scroll" id="workspace-project-picker" style={leftPanel ? { maxHeight: `${projectListPercent}%` } : undefined}>
          {repos.length === 0 && <button className="workspace-open-folder" disabled={openingFolder} onClick={() => void openFolder()}><Icon name="dir" size={15} />{openingFolder ? 'Opening…' : 'Open folder'}</button>}
          {[...repos].sort((a, b) => Math.min(...a.worktrees.map(worktree => order.indexOf(worktree.path))) - Math.min(...b.worktrees.map(worktree => order.indexOf(worktree.path)))).map(repo => {
            const collapsed = navigation.collapsedRepoIds.includes(repo.repo.id)
            const worktrees = repo.worktrees.filter(worktree => !navigation.hiddenPaths.includes(worktree.path)).sort((a,b) => Number(navigation.pinnedPaths.includes(b.path)) - Number(navigation.pinnedPaths.includes(a.path)) || order.indexOf(a.path) - order.indexOf(b.path))
            const single = repo.worktrees.length === 1 && worktrees.length === 1
            return <section className="workspace-project" key={repo.repo.id}>
              {!single && <div className="workspace-project-heading">
                <button aria-expanded={!collapsed} onClick={() => state().toggleRepoCollapsed(repo.repo.id)}><Icon name={collapsed ? 'chevrons' : 'down'} size={12} /><strong>{pathBasename(repo.repo.path)}</strong></button>
                <button className="workspace-icon-control workspace-project-menu" aria-label={`Actions for ${pathBasename(repo.repo.path)}`} title="Project actions" aria-haspopup="menu" onClick={event => setCheckoutMenu({ anchor: event.currentTarget, repo, path: repo.worktrees.find(worktree => worktree.isMain)?.path ?? repo.worktrees[0]?.path ?? repo.repo.path })}><Icon name="more" size={14} /></button>
              </div>}
              {(single || !collapsed) && <div className="workspace-checkouts">
                {worktrees.map(worktree => {
                  const current = worktree.path === activePath
                  const git = statuses[worktree.path]
                  return <div className={`workspace-checkout${single ? ' workspace-checkout-single' : ''}${current ? ' is-current' : ''}`} key={worktree.path} onContextMenu={event => { event.preventDefault(); setCheckoutMenu({ anchor: event.currentTarget.querySelector('button')!, repo, path: worktree.path }) }}>
                    <button className="workspace-checkout-open" aria-current={current ? 'page' : undefined} title={worktree.path} onClick={() => { state().setActiveWorktree(worktree.path) }}>
                      <span className="workspace-checkout-line"><Icon name={repo.repo.kind === 'folder' ? 'dir' : 'git'} size={13} /><span>{navigation.renames[worktree.path] ?? (single ? pathBasename(repo.repo.path) : worktree.isMain ? 'Main checkout' : pathBasename(worktree.path))}</span>{navigation.pinnedPaths.includes(worktree.path) && <span aria-label="Pinned">•</span>}</span>
                      {(!single || repo.repo.kind !== 'folder') && <small>{repo.repo.kind === 'folder' ? 'Local folder' : git?.branch || worktree.branch || 'Detached'}{git?.conflicts ? ` · ${git.conflicts} conflicts` : ''}</small>}
                    </button>
                    <button className="workspace-icon-control workspace-checkout-actions" aria-label={`Actions for ${pathBasename(worktree.path)}`} title="Checkout actions" aria-haspopup="menu" aria-expanded={checkoutMenu?.path === worktree.path} onClick={event => setCheckoutMenu({ anchor: event.currentTarget, repo, path: worktree.path })}><Icon name="more" size={14} /></button>
                  </div>
                })}
              </div>}
            </section>
          })}
          {navigation.hiddenPaths.length > 0 && <button className="workspace-add-checkout" onClick={() => state().restoreWorkspace()}>Show hidden checkouts ({navigation.hiddenPaths.length})</button>}
        </div>
        {leftPanel && <div className="workspace-project-height-resize" role="separator" aria-label="Resize projects and tools" aria-orientation="horizontal" aria-valuemin={15} aria-valuemax={75} aria-valuenow={Math.round(projectListPercent)} tabIndex={0} title="Set the maximum project-list height. Short lists fit their contents; double-click resets."
          onDoubleClick={() => state().setProjectListPercent(35)}
          onPointerDown={event => { event.preventDefault(); event.currentTarget.focus(); event.currentTarget.dataset.nativeResize = ''; event.currentTarget.setPointerCapture(event.pointerId) }}
          onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const parent = event.currentTarget.parentElement!; const list = parent.querySelector<HTMLElement>('.workspace-project-scroll')!; state().setProjectListPercent((event.clientY - list.getBoundingClientRect().top) / parent.clientHeight * 100) }}
          onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)}
          onLostPointerCapture={event => { delete event.currentTarget.dataset.nativeResize }}
          onKeyDown={event => { if (['ArrowUp','ArrowDown','Home','End'].includes(event.key)) { event.preventDefault(); state().setProjectListPercent(event.key === 'Home' ? 15 : event.key === 'End' ? 75 : projectListPercent + (event.key === 'ArrowUp' ? -5 : 5)) } }} />}
        {leftPanel}
        {<div className="workspace-project-resize" role="separator" aria-label="Resize project navigation" aria-orientation="vertical" aria-valuemin={minimumWidth} aria-valuemax={Math.round(maximumWidth)} aria-valuenow={Math.round(navigationWidth)} tabIndex={0} title="Drag to resize the project column. Arrow keys resize; double-click resets." onDoubleClick={() => state().setSidebarWidth(leftPanel ? 320 : 224)}
          onPointerDown={event => { event.preventDefault(); event.currentTarget.focus(); event.currentTarget.dataset.nativeResize = ''; event.currentTarget.setPointerCapture(event.pointerId) }}
          onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) state().setSidebarWidth(Math.min(maximumWidth, Math.max(minimumWidth, event.clientX - event.currentTarget.parentElement!.getBoundingClientRect().left))) }}
          onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)}
          onLostPointerCapture={event => { delete event.currentTarget.dataset.nativeResize }}
          onKeyDown={event => { if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) { event.preventDefault(); state().setSidebarWidth(event.key === 'Home' ? minimumWidth : event.key === 'End' ? maximumWidth : Math.min(maximumWidth, Math.max(minimumWidth, navigationWidth + (event.key === 'ArrowLeft' ? -16 : 16)))) } }} />}
      </aside>}
      {menu && <PopupMenu anchor={menu} title="Add project" onClose={() => setMenu(null)} items={[
        { key: 'open', label: openingFolder ? 'Opening…' : 'Open folder…', disabled: openingFolder, onSelect: () => void openFolder() },
        { key: 'create', label: 'Create project…', onSelect: () => requestAnimationFrame(() => openProjectSetup()) }
      ]} />}
      {checkoutMenu && menuRepo && menuWorktree && <PopupMenu anchor={checkoutMenu.anchor} title={`Actions for ${pathBasename(menuWorktree.path)}`} onClose={() => setCheckoutMenu(null)} items={[
        { key: 'open', label: 'Open', onSelect: () => state().setActiveWorktree(menuWorktree.path) },
        { key: 'finder', label: 'Open in Finder', onSelect: () => { void window.donwells.revealWorkspaceEntry(menuWorktree.path, '').catch(error => state().setError(String(error))) } },
        { key: 'browser', label: 'Open in browser', onSelect: () => { state().setActiveWorktree(menuWorktree.path); state().setRunsOpen(false); void state().openBrowser(menuWorktree.path).catch(error => state().setError(String(error))) } },
        ...(menuRepo.repo.kind !== 'folder' ? [{ key: 'worktree', label: 'New worktree…', onSelect: () => { state().setActiveRepo(menuRepo.repo.id); state().setCreateOpen(true) } }] : []),
        { type: 'divider', key: 'organize' },
        { key: 'pin', label: navigation.pinnedPaths.includes(menuWorktree.path) ? 'Unpin' : 'Pin', onSelect: () => state().toggleWorkspacePinned(menuWorktree.path) },
        { key: 'up', label: 'Move up', disabled: moveWorkspaceNavigation(navigation, repos, menuWorktree.path, -1) === navigation, onSelect: () => state().moveWorkspace(menuWorktree.path, -1) },
        { key: 'down', label: 'Move down', disabled: moveWorkspaceNavigation(navigation, repos, menuWorktree.path, 1) === navigation, onSelect: () => state().moveWorkspace(menuWorktree.path, 1) },
        { key: 'rename', label: 'Rename label…', onSelect: () => setRename({ path: menuWorktree.path, label: navigation.renames[menuWorktree.path] ?? '' }) },
        { key: 'hide', label: 'Hide checkout', onSelect: () => state().hideWorkspace(menuWorktree.path) },
        { type: 'divider', key: 'remove' },
        ...(!menuWorktree.isMain && menuRepo.repo.kind !== 'folder' ? [{ key: 'trash', label: 'Move worktree to Trash…', onSelect: () => state().setDeleteTarget(menuWorktree.path) }] : []),
        { key: 'remove-project', label: 'Remove project from app…', onSelect: () => setRemoveProject(menuRepo) }
      ]} />}
      {removeProject && <ProjectRemovalDialog repo={removeProject} onClose={() => setRemoveProject(null)} />}
      {rename && <ModalDialog labelledBy="checkout-label-title" onClose={() => setRename(null)}><form style={{ display: 'contents' }} onSubmit={event => { event.preventDefault(); state().renameWorkspace(rename.path, rename.label); setRename(null) }}>
        <h2 className="modal-title" id="checkout-label-title">Rename checkout label</h2>
        <label className="modal-field">Label<input className="input" autoFocus title="Change the displayed label without renaming the folder. Leave blank to use the folder name" aria-label="Checkout label" value={rename.label} placeholder={pathBasename(rename.path)} maxLength={80} onChange={event => setRename({ ...rename, label: event.target.value })} /></label>
        <div className="modal-footer"><button type="button" className="btn btn-secondary btn-sm" onClick={() => setRename(null)}>Cancel</button><button type="submit" className="btn btn-primary btn-sm">Save label</button></div>
      </form></ModalDialog>}
      <div className="workspace-desk">
        <div className="workspace-surfaces">{!sidebarOpen && leftPanel}{children}</div>
      </div>
    </div>
  </>
}
