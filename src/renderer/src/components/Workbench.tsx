import { useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Actions, DockLocation, Layout, Model, TabNode, TabSetNode, type Action } from 'flexlayout-react'
import { useAppStore, isMarkdownFile, type Pane } from '../store'
import { restoreWorkspaceLayout, workspacePaneLabel, type WorkspaceLayout, type WorkspacePreset } from '../workspace-layout'
import { TerminalPane } from './TerminalPane'
import { MediaPreviewRouter } from './MediaPreviewRouter'
import { DiffPane } from './DiffPane'
import { ExplorerPane } from './ExplorerPane'
import { GitPane } from './GitPane'
import { ProjectMemoryPanel } from './ProjectMemoryPanel'
import { RecoveryPanel } from './RecoveryPanel'
import { agentPresentation, agentProviderName } from '@shared/agent-presentation'
import { NavigationControls } from './NavigationControls'
import { Icon } from './Icon'
import 'flexlayout-react/style/dark.css'
import './workbench-dock.css'
const EMPTY_PANES: Pane[] = []

function WorkspacePane({ worktreePath, paneKey, visible }: { worktreePath: string; paneKey: string; visible: boolean }) {
  const pane = useAppStore(state => state.panes[worktreePath]?.find(item => item.key === paneKey))
  const terminal = useAppStore(state => pane?.sessionId ? state.terminals[pane.sessionId] : undefined)
  if (!pane) return null
  return <div className="pane" data-pane-key={pane.key} data-pane-kind={pane.kind} tabIndex={-1}
    onFocus={() => useAppStore.getState().setActivePane(worktreePath, paneKey)}
    onMouseDown={() => useAppStore.getState().setActivePane(worktreePath, paneKey)}>
    {pane.kind === 'browser' && pane.url ? <div className="browser-pane-slot" data-browser-worktree={worktreePath} /> :
      <div className={`pane-body-terminal${visible ? '' : ' terminal-hidden'}`}>
        {pane.kind === 'terminal' && terminal ? <TerminalPane sessionId={terminal.session.id} cols={terminal.cols} rows={terminal.rows} isActive={visible} />
          : pane.kind === 'preview' && pane.file ? <MediaPreviewRouter worktreePath={worktreePath} relPath={pane.file} />
          : pane.kind === 'diff' && pane.file ? <DiffPane worktreePath={worktreePath} relPath={pane.file} comparison={pane.comparison} />
          : pane.kind === 'explorer' ? <ExplorerPane worktreePath={worktreePath} />
          : pane.kind === 'git-status' ? <GitPane worktreePath={worktreePath} />
          : pane.kind === 'memory' ? <ProjectMemoryPanel workspacePath={worktreePath} />
          : pane.kind === 'recovery' ? <RecoveryPanel workspacePath={worktreePath} /> : null}
      </div>}
  </div>
}

function DockingSurface({ worktreePath, active }: { worktreePath: string; active: boolean }) {
  const panes = useAppStore(state => state.panes[worktreePath] ?? EMPTY_PANES)
  const saved = useAppStore(state => state.docking[worktreePath])
  const agents = useAppStore(state => state.runningAgents)
  const previews = useAppStore(state => state.previews[worktreePath])
  const legacy = useAppStore(state => state.layouts[worktreePath])
  const activePane = useAppStore(state => state.activePane[worktreePath])
  const hosts = useRef(new Map<string, HTMLDivElement>())
  const cache = useRef<{ saved: WorkspaceLayout | undefined; model: Model } | null>(null)
  const [, refresh] = useState(0)
  if (!cache.current || cache.current.saved !== saved) {
    cache.current = { saved, model: Model.fromJson(restoreWorkspaceLayout(saved, panes, legacy).layout.model) }
  }
  const model = cache.current.model
  for (const pane of panes) if (!hosts.current.has(pane.key)) {
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
    if (activePane && model.getNodeById(activePane) && model.getActiveTabset()?.getSelectedNode()?.getId() !== activePane) model.doAction(Actions.selectTab(activePane))
    for (const key of hosts.current.keys()) if (!known.has(key)) hosts.current.delete(key)
    if (!saved) publish(model)
  }, [model, panes, activePane, saved])
  const action = (value: Action): Action | undefined => {
    if (value.type === Actions.DELETE_TAB) { useAppStore.getState().hidePaneView(worktreePath, String(value.data.node)); return undefined }
    if (value.type === Actions.RENAME_TAB) useAppStore.getState().renamePane(worktreePath, String(value.data.node), String(value.data.text))
    return value
  }
  return <section className={`workspace-docking-surface${active ? '' : ' workspace-docking-hidden'}`} aria-label="Workspace panels">
    <Layout model={model} supportsPopout={false} onAction={action} onModelChange={publish}
      factory={node => <div className="workspace-pane-slot" ref={element => { const host = hosts.current.get(node.getId()); if (element && host) element.append(host) }} />}
      onRenderTab={(node, values) => {
        const pane = panes.find(pane => pane.key === node.getId()), agent = pane?.sessionId ? agents[pane.sessionId] : undefined
        values.leading = <Icon name={pane?.kind === 'terminal' ? 'terminal' : 'file'} size={12} />
        if (agent) values.content = <span title={agentPresentation(agent).description}>{agentProviderName(agent)} · {agentPresentation(agent).label}</span>
      }}
      onRenderTabSet={(node, values) => {
        const key = node.getSelectedNode()?.getId(), pane = panes.find(pane => pane.key === key)
        if (pane?.kind === 'terminal') {
          values.stickyButtons.push(<button key="split" className="icon-btn" aria-label="Split terminal right" title="Split terminal right" onClick={() => { const state = useAppStore.getState(); state.setActivePane(worktreePath, pane.key); void state.splitTerminal(worktreePath, 'row') }}><Icon name="columns" size={12} /></button>)
          values.stickyButtons.push(<button key="stop" className="icon-btn danger" aria-label={`Stop ${workspacePaneLabel(pane)} process`} title="Stop process" onClick={() => useAppStore.getState().requestClosePane(worktreePath, pane.key)}><Icon name="stop" size={12} /></button>)
        }
        if (pane?.kind === 'preview' && pane.file && isMarkdownFile(pane.file)) values.stickyButtons.push(<button key="markdown" className="icon-btn" aria-label="Toggle Markdown preview" onClick={() => useAppStore.getState().setPreviewMode(worktreePath, pane.file!, previews?.[pane.file!]?.mode === 'preview' ? 'edit' : 'preview')}><Icon name="eye" size={12} /></button>)
      }} />
    {panes.map(pane => {
      const node = model.getNodeById(pane.key), parent = node?.getParent()
      const visible = active && parent instanceof TabSetNode && parent.getSelectedNode() === node
      return createPortal(<WorkspacePane worktreePath={worktreePath} paneKey={pane.key} visible={visible} />, hosts.current.get(pane.key)!, pane.key)
    })}
  </section>
}

export function WorkspaceControls() {
  const popoverId = useId()
  const activePath = useAppStore(state => state.activeWorktreePath)
  const panes = useAppStore(state => state.panes)
  const docking = useAppStore(state => state.docking)
  const [urlOpen, setUrlOpen] = useState(false)
  const [url, setUrl] = useState('')
  const hidden = activePath ? docking[activePath]?.hidden ?? [] : []
  return <><button aria-label="Layout" title="Workspace layout" popoverTarget={popoverId} disabled={!activePath}><Icon name="columns" size={19} /><span>Layout</span></button><div id={popoverId} popover="auto" className="workspace-layout-popover">
    <div className="workspace-arrangements" aria-label="Workspace arrangement">
      <NavigationControls />
      <div className="workspace-preset-buttons">{([['focus', 'Focus'], ['pair', 'Pair'], ['build', 'Build & preview'], ['review', 'Review']] as const).map(([preset, label]) => <button key={preset} onClick={event => { if (activePath) useAppStore.getState().arrangeWorkspace(activePath, preset as WorkspacePreset); event.currentTarget.closest<HTMLElement>('.workspace-layout-popover')?.hidePopover() }}>{label}</button>)}</div>
      <button onClick={() => setUrlOpen(!urlOpen)} aria-expanded={urlOpen}><Icon name="globe" size={13} />Preview URL</button>
      {hidden.length > 0 && <details className="workspace-hidden-views"><summary>Hidden ({hidden.length})</summary><div>{hidden.map(key => <button key={key} onClick={event => { if (activePath) useAppStore.getState().setActivePane(activePath, key); event.currentTarget.closest<HTMLElement>('.workspace-layout-popover')?.hidePopover() }}>{workspacePaneLabel(panes[activePath!]?.find(pane => pane.key === key) ?? { key, kind: 'panel' })}</button>)}</div></details>}
    </div>
    {urlOpen && <form className="workspace-preview-address" onSubmit={event => { event.preventDefault(); if (activePath && url.trim()) { void useAppStore.getState().openBrowser(activePath, url.trim()); setUrlOpen(false) } }}><input aria-label="Preview URL" type="url" value={url} onChange={event => setUrl(event.target.value)} autoFocus required placeholder="http://localhost:3000" /><button type="submit">Open preview</button><button type="button" onClick={() => setUrlOpen(false)}>Cancel</button></form>}
  </div></>
}

export function Workbench() {
  const activePath = useAppStore(state => state.activeWorktreePath)
  const panes = useAppStore(state => state.panes)
  return <div className={`workspace-dock${activePath ? '' : ' workspace-docking-hidden'}`}><div className="workspace-docking-body">{Object.keys(panes).map(path => <DockingSurface key={path} worktreePath={path} active={path === activePath} />)}</div></div>
}
