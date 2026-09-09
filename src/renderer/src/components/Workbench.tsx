import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Actions, DockLocation, PopupMenu, Layout, Model, TabNode, TabSetNode, type Action } from 'flexlayout-react'
import { isMarkdownFile, useAppStore, type Pane } from '../store'
import { restoreWorkspaceLayout, workspacePaneLabel, type WorkspaceLayout, type WorkspacePreset } from '../workspace-layout'
import { TerminalPane } from './TerminalPane'
import { MediaPreviewRouter } from './MediaPreviewRouter'
import { DiffPane } from './DiffPane'
import { ExplorerPane } from './ExplorerPane'
import { GitPane } from './GitPane'
import { ProjectMemoryPanel } from './ProjectMemoryPanel'
import { RecoveryPanel } from './RecoveryPanel'
import { ComputerControlPanel } from './ComputerControlPanel'
import { ProjectSearch } from './ProjectSearch'
import { agentPresentation, agentProviderName } from '@shared/agent-presentation'
import { Icon } from './Icon'
import { NavigationControls } from './NavigationControls'
import 'flexlayout-react/style/dark.css'
import './workbench-dock.css'
const EMPTY_PANES: Pane[] = []

function WorkspacePane({ worktreePath, pane, visible, sidebar }: { worktreePath: string; pane: Pane; visible: boolean; sidebar: boolean }) {
  const paneKey = pane.key
  const terminal = useAppStore(state => { const view = pane?.sessionId ? state.terminals[pane.sessionId] : undefined; return view?.session.worktreePath === worktreePath ? view : undefined })
  const preview = useAppStore(state => pane?.file ? state.previews[worktreePath]?.[pane.file] : undefined)
  if (!pane) return null
  return <div className="pane" data-pane-key={pane.key} data-pane-kind={pane.kind} tabIndex={-1}
    onFocus={() => { if (!sidebar) useAppStore.getState().setActivePane(worktreePath, paneKey) }}
    onMouseDown={() => { if (!sidebar) useAppStore.getState().setActivePane(worktreePath, paneKey) }}>
    {pane.kind === 'browser' && pane.url ? <div className="browser-pane-slot" data-browser-worktree={worktreePath} /> :
      <div className={`pane-body-terminal${visible ? '' : ' terminal-hidden'}`}>
        {pane.kind === 'terminal' && !terminal ? <div className="empty-note" role="status">
          <strong>Previous terminal unavailable</strong>
          <p>This saved session could not be reattached. A new terminal starts a separate shell; it does not resume the previous agent.</p>
          <button className="btn btn-secondary btn-sm" onClick={() => void useAppStore.getState().openTerminal(worktreePath)}>Open new terminal</button>
          <button className="btn btn-secondary btn-sm" onClick={() => useAppStore.getState().requestClosePane(worktreePath, pane.key)}>Remove unavailable reference</button>
        </div> : pane.kind === 'preview' && pane.file && !preview ? <div className="empty-note" role="status">
          <strong>File preview unavailable</strong><p>{pane.file}</p>
          <button className="btn btn-secondary btn-sm" onClick={() => void useAppStore.getState().openPreview(worktreePath, pane.file!)}>Retry file</button>
          <button className="btn btn-secondary btn-sm" onClick={() => useAppStore.getState().openWorkspaceModule(worktreePath, 'recovery')}>Recover unsaved files</button>
        </div> : pane.kind === 'terminal' && terminal ? <TerminalPane sessionId={terminal.session.id} cols={terminal.cols} rows={terminal.rows} isActive={visible} />
          : pane.kind === 'preview' && pane.file ? <MediaPreviewRouter worktreePath={worktreePath} relPath={pane.file} />
          : pane.kind === 'diff' && pane.file ? <DiffPane worktreePath={worktreePath} relPath={pane.file} comparison={pane.comparison} />
          : pane.kind === 'explorer' ? <ExplorerPane worktreePath={worktreePath} active={visible} location={sidebar ? 'sidebar' : 'workspace'} />
          : pane.kind === 'git-status' ? <GitPane worktreePath={worktreePath} />
          : pane.kind === 'memory' ? <ProjectMemoryPanel workspacePath={worktreePath} />
          : pane.kind === 'search' ? <ProjectSearch workspacePath={worktreePath} active={visible} />
          : pane.kind === 'computer' ? <ComputerControlPanel workspacePath={worktreePath} />
          : pane.kind === 'recovery' ? <RecoveryPanel workspacePath={worktreePath} />
          : pane.kind === 'environments' ? <div className="empty-note" role="status">
            <strong>Project environments removed</strong>
            <p>Project environments were removed from Donwells. This view can be closed.</p>
            <button className="btn btn-secondary btn-sm" onClick={() => useAppStore.getState().requestClosePane(worktreePath, pane.key)}>Close this view</button>
          </div>
          : pane.kind === 'browser' ? <div className="empty-note"><button className="btn btn-secondary" onClick={() => void useAppStore.getState().openBrowser(worktreePath).catch(error => useAppStore.getState().setError(String(error)))}>Open project preview</button></div> : null}
      </div>}
  </div>
}

function DockingSurface({ worktreePath, active }: { worktreePath: string; active: boolean }) {
  const panes = useAppStore(state => state.panes[worktreePath] ?? EMPTY_PANES)
  const [contextMenu, setContextMenu] = useState<{ pane: Pane; x: number; y: number } | null>(null)
  const reportError = (error: unknown): void => useAppStore.setState({ error: String(error) })
  const saved = useAppStore(state => state.docking[worktreePath])
  const agents = useAppStore(state => state.runningAgents)
  const previews = useAppStore(state => state.previews[worktreePath])
  const legacy = useAppStore(state => state.layouts[worktreePath])
  const activePane = useAppStore(state => state.activePane[worktreePath])
  const sidebarOpen = useAppStore(state => state.rightSidebarOpen && !state.runsOpen)
  // Reattach retained tool hosts when Projects moves the left tool slot into or out of its column.
  useAppStore(state => state.sidebarOpen)
  const sidebarTab = useAppStore(state => state.rightSidebarTab)
  const sidebarKind = sidebarTab === 'git' ? 'git-status' : sidebarTab
  const sidebarKey = active && sidebarOpen ? `${sidebarKind}:${worktreePath}` : undefined
  const sidebarResources = useRef(new Map<string, Pane>())
  const previousDockKeys = useRef(new Set<string>())
  const dockKeys = new Set(panes.map(pane => pane.key))
  // Sidebar navigation hides a resource; closing its dock tab ends its lifetime.
  for (const key of previousDockKeys.current) if (!dockKeys.has(key)) sidebarResources.current.delete(key)
  previousDockKeys.current = dockKeys
  if (sidebarKey && !dockKeys.has(sidebarKey)) sidebarResources.current.set(sidebarKey, { key: sidebarKey, kind: sidebarKind })
  const resources = [...panes, ...[...sidebarResources.current.values()].filter(pane => !dockKeys.has(pane.key))]
  const parking = useRef<HTMLDivElement>(null)
  const hosts = useRef(new Map<string, HTMLDivElement>())
  const cache = useRef<{ saved: WorkspaceLayout | undefined; model: Model } | null>(null)
  const [, refresh] = useState(0)
  if (!cache.current || cache.current.saved !== saved) {
    cache.current = { saved, model: Model.fromJson(restoreWorkspaceLayout(saved, panes, legacy).layout.model) }
  }
  const model = cache.current.model
  for (const pane of resources) if (!hosts.current.has(pane.key)) {
    const host = document.createElement('div'); host.className = 'workspace-pane-resource'
    hosts.current.set(pane.key, host)
  }
  const publish = (next: Model): void => {
    const hidden = useAppStore.getState().docking[worktreePath]?.hidden ?? []
    const layout: WorkspaceLayout = { version: 1, model: next.toJson(), hidden: hidden.filter(key => panes.some(pane => pane.key === key)) }
    cache.current!.saved = layout
    useAppStore.getState().saveDocking(worktreePath, layout)
    const selected = next.getActiveTabset()?.getSelectedNode()?.getId()
    if (selected) useAppStore.getState().setActivePane(worktreePath, selected)
    refresh(value => value + 1)
  }
  useLayoutEffect(() => {
    const known = new Set(panes.map(pane => pane.key))
    const removed: string[] = []
    model.visitNodes(node => { if (node instanceof TabNode && !known.has(node.getId())) removed.push(node.getId()) })
    for (const id of removed) model.doAction(Actions.deleteTab(id))
    for (const pane of panes) {
      if (saved?.hidden.includes(pane.key)) continue
      const node = model.getNodeById(pane.key)
      if (!node) model.doAction(Actions.addNode({ type: 'tab', id: pane.key, name: workspacePaneLabel(pane), component: 'pane' }, model.getActiveTabset()?.getId() ?? model.getRootRow()!.getChildren()[0]?.getId() ?? model.getRootRow()!.getId(), DockLocation.CENTER, -1, pane.key === activePane))
      else if (node instanceof TabNode && node.getName() !== workspacePaneLabel(pane)) model.doAction(Actions.renameTab(pane.key, workspacePaneLabel(pane)))
    }
    const maximized = model.getMaximizedTabset()
    const target = activePane ? model.getNodeById(activePane) : undefined
    if (maximized && target && target.getParent() !== maximized) model.doAction(Actions.maximizeToggle(maximized.getId()))
    if (activePane && model.getNodeById(activePane) && model.getActiveTabset()?.getSelectedNode()?.getId() !== activePane) model.doAction(Actions.selectTab(activePane))
    if (!saved) publish(model)
  }, [model, panes, activePane, saved])
  useLayoutEffect(() => {
    const sidebarSlot = document.querySelector<HTMLElement>('[data-sidebar-tool-slot]')
    for (const pane of resources) {
      if (dockKeys.has(pane.key)) continue
      const host = hosts.current.get(pane.key)!
      const destination = pane.key === sidebarKey && sidebarSlot?.dataset.sidebarToolSlot === worktreePath ? sidebarSlot : parking.current
      if (destination && host.parentElement !== destination) destination.append(host)
    }
    const known = new Set(resources.map(pane => pane.key))
    for (const key of hosts.current.keys()) if (!known.has(key)) hosts.current.delete(key)
  })
  const action = (value: Action): Action | undefined => {
    if (value.type === Actions.DELETE_TAB) { useAppStore.getState().requestClosePane(worktreePath, String(value.data.node)); return undefined }
    if (value.type === Actions.RENAME_TAB) useAppStore.getState().renamePane(worktreePath, String(value.data.node), String(value.data.text))
    return value
  }
  return <section className={`workspace-docking-surface${active ? '' : ' workspace-docking-hidden'}`} aria-label="Workspace panels" onKeyDown={event => {
    if (!(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) return
    const tab = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]')
    if (!tab) return
    event.preventDefault(); event.stopPropagation()
    const rect = tab.getBoundingClientRect()
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom }))
  }}>
    {contextMenu && <PopupMenu anchor={contextMenu} title="Tab actions" onClose={() => setContextMenu(null)} items={[
      { key: 'open', label: 'Open', onSelect: () => useAppStore.getState().setActivePane(worktreePath, contextMenu.pane.key) },
      ...(contextMenu.pane.file ? [
        { key: 'finder', label: 'Open in Finder', onSelect: () => void window.donwells.revealWorkspaceEntry(worktreePath, contextMenu.pane.file!).catch(reportError) },
        { key: 'browser', label: 'Open in browser', onSelect: () => void window.donwells.workspacePreviewUrl(worktreePath, contextMenu.pane.file!).then(url => useAppStore.getState().openBrowser(worktreePath, url)).catch(reportError) }
      ] : contextMenu.pane.kind === 'browser' && contextMenu.pane.url ? [
        { key: 'external', label: 'Open in default browser', onSelect: () => void window.donwells.openExternal(contextMenu.pane.url!).catch(reportError) }
      ] : []),
      { type: 'divider', key: 'close-divider' },
      { key: 'close', label: 'Close', onSelect: () => useAppStore.getState().requestClosePane(worktreePath, contextMenu.pane.key) }
    ]} />}
    <Layout icons={{ maximize: <Icon name="maximize" />, restore: <Icon name="restore" />, more: <Icon name="down" />, close: <Icon name="x" />, closeTabset: <Icon name="x" /> }} model={model} supportsPopout={false} onAction={action} onModelChange={publish}
      onContextMenu={(node, event) => {
        const pane = panes.find(pane => pane.key === node.getId())
        if (!pane) return
        event.preventDefault()
        setContextMenu({ pane, x: event.clientX, y: event.clientY })
      }}
      factory={node => <div className="workspace-pane-slot" ref={element => { const host = hosts.current.get(node.getId()); if (element && host && host.parentElement !== element) element.append(host) }} />}
      onRenderTabSet={(node, values) => {
        values.stickyButtons.push(<button key="new-terminal" className="icon-btn" title="Create a terminal in this tab group for the current checkout" aria-label="New terminal" onClick={() => {
          if (node instanceof TabSetNode) { model.doAction(Actions.setActiveTabset(node.getId())); publish(model) }
          void useAppStore.getState().openTerminal(worktreePath)
        }}><Icon name="plus" size={14} /></button>)
        if (node === model.getActiveTabset()) {
          const selected = panes.find(pane => pane.key === node.getSelectedNode()?.getId())
          if (selected?.kind === 'preview' && selected.file && isMarkdownFile(selected.file) && previews?.[selected.file]?.mode === 'preview') {
            const file = selected.file
            values.buttons.push(<button key="document-find" className="icon-btn" aria-label="Find in document" title="Find in this document" onClick={() => window.dispatchEvent(new CustomEvent('donwells:document-find', { detail: { worktreePath, file } }))}><Icon name="search" size={14} /></button>)
          }

          if (selected?.kind === 'preview' && selected.file && isMarkdownFile(selected.file)) {
            const file = selected.file, editing = previews?.[file]?.mode !== 'preview'
            const label = editing ? 'Read Markdown' : 'Edit Markdown'
            values.buttons.push(<button key="markdown-mode" className="markdown-mode-control" title={label} aria-label={label} onClick={() => void useAppStore.getState().setPreviewMode(worktreePath, file, editing ? 'preview' : 'edit')}><Icon name={editing ? 'eye' : 'edit'} size={14} /><span>{editing ? 'Read' : 'Edit'}</span></button>)
          }
          values.buttons.push(<NavigationControls key="history" />, <WorkspaceControls key="layout" />)
        }
      }}
      onRenderTab={(node, values) => {
        const pane = panes.find(pane => pane.key === node.getId()), agent = pane?.sessionId ? agents[pane.sessionId] : undefined
        if (pane) values.buttons.push(<button key="close" onKeyDown={event => event.stopPropagation()} className="icon-btn" aria-label={`Close ${workspacePaneLabel(pane)}`} title={`Close ${workspacePaneLabel(pane)}`} onMouseDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); useAppStore.getState().requestClosePane(worktreePath, pane.key) }}><Icon name="x" size={14} /></button>)
        values.leading = <Icon name={({ terminal: 'terminal', explorer: 'dir', 'git-status': 'git', diff: 'git', memory: 'memory', recovery: 'clock', search: 'search', computer: 'monitor', browser: 'globe' } as Record<string, string>)[pane?.kind ?? ''] ?? 'file'} size={12} />
        if (agent) values.content = <span title={agentPresentation(agent).description}>{agentProviderName(agent)} · {agentPresentation(agent).label}</span>
      }} />
    <div ref={parking} hidden />
    {resources.map(pane => {
      const node = model.getNodeById(pane.key), parent = node?.getParent()
      const sidebar = !dockKeys.has(pane.key)
      const visible = sidebar ? pane.key === sidebarKey : active && parent instanceof TabSetNode && parent.getSelectedNode() === node
      return createPortal(<WorkspacePane worktreePath={worktreePath} pane={pane} visible={visible} sidebar={sidebar} />, hosts.current.get(pane.key)!, pane.key)
    })}
  </section>
}

export function WorkspaceControls() {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const activePath = useAppStore(state => state.activeWorktreePath)
  const panes = useAppStore(state => activePath ? state.panes[activePath] ?? EMPTY_PANES : EMPTY_PANES)
  const hidden = useAppStore(state => activePath ? state.docking[activePath]?.hidden : undefined)
  const activeKey = useAppStore(state => activePath ? state.activePane[activePath] : undefined)
  const selected = panes.find(pane => pane.key === activeKey)
  const reportError = (error: unknown) => useAppStore.getState().setError(String(error))
  return <><button className="icon-btn" aria-label="Layout" title={activePath ? 'Arrange panels, split terminals, or restore hidden views' : 'Select a checkout to arrange its workspace'} aria-haspopup="menu" aria-expanded={!!anchor} onClick={event => setAnchor(event.currentTarget)} disabled={!activePath}><Icon name="layout" size={14} /></button>
    {anchor && activePath && <PopupMenu anchor={anchor} title="Layout" onClose={() => setAnchor(null)} items={[
      ...(['focus', 'pair', 'stack', 'grid', 'build', 'review'] as const).map(preset => ({
        key: preset,
        label: ({ focus: 'All tabs', pair: 'Side by side', stack: 'Stacked', grid: 'Grid', build: 'Build & preview', review: 'Review' })[preset],
        disabled: preset === 'review' ? !panes.some(pane => pane.kind === 'diff') : ['pair', 'stack', 'grid'].includes(preset) && panes.length < 2,
        onSelect: () => void useAppStore.getState().arrangeWorkspace(activePath, preset as WorkspacePreset).catch(reportError)
      })),
      ...(selected?.kind === 'terminal' ? [
        { type: 'divider' as const, key: 'split-divider' },
        { key: 'split-right', label: 'Split terminal right', onSelect: () => void useAppStore.getState().splitTerminal(activePath, 'row').catch(reportError) },
        { key: 'split-below', label: 'Split terminal below', onSelect: () => void useAppStore.getState().splitTerminal(activePath, 'col').catch(reportError) }
      ] : []),
      ...(selected ? [
        { type: 'divider' as const, key: 'hide-divider' },
        { key: 'hide', label: 'Hide current view', onSelect: () => useAppStore.getState().hidePaneView(activePath, selected.key) }
      ] : []),
      ...(hidden?.length ? [
        { type: 'divider' as const, key: 'restore-divider' },
        ...hidden.map(key => ({ key: 'restore:'+key, label: 'Restore '+workspacePaneLabel(panes.find(pane => pane.key === key) ?? {key, kind:'panel'}), onSelect: () => useAppStore.getState().setActivePane(activePath, key) }))
      ] : [])
    ]} />}
  </>
}

export function Workbench() {
  const activePath = useAppStore(state => state.activeWorktreePath)
  const panes = useAppStore(state => state.panes)
  return <div className={`workspace-dock${activePath ? '' : ' workspace-docking-hidden'}`}><div className="workspace-docking-body">{[...new Set([...Object.keys(panes), ...(activePath ? [activePath] : [])])].map(path => <DockingSurface key={path} worktreePath={path} active={path === activePath} />)}</div></div>
}
