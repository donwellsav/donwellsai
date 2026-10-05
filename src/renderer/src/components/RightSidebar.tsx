import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useAppStore } from '../store'
import { focusPaneTarget } from '../navigation-controller'
import { Icon } from './Icon'
import { RecoveryPanel } from './RecoveryPanel'
import { HerdrSessionsPanel } from './HerdrSessionsPanel'

export type RightSidebarTab = 'explorer' | 'git' | 'memory' | 'recovery' | 'search' | 'computer' | 'sessions'

const MIN_PANEL_WIDTH = 260
const MAX_PANEL_WIDTH = 620
const TABS: ReadonlyArray<{ id: RightSidebarTab; label: string }> = [
  { id: 'search', label: 'Search' },
  { id: 'explorer', label: 'Files' },
  { id: 'git', label: 'Git' },
  { id: 'memory', label: 'Memory' },
  { id: 'recovery', label: 'Recovery' },
  { id: 'computer', label: 'Computer control' },
  { id: 'sessions', label: 'Sessions' }
]

export function RightSidebar() {
  const side = useAppStore(s => s.settings.toolPanelSide)
  const tab = useAppStore((s) => s.rightSidebarTab)
  const setRightSidebarOpen = useAppStore((s) => s.setRightSidebarOpen)
  const activeWorktreePath = useAppStore((s) => s.activeWorktreePath)
  const width = useAppStore((s) => s.rightSidebarWidth)
  const setRightSidebarWidth = useAppStore((s) => s.setRightSidebarWidth)
  const panel = useRef<HTMLElement>(null)
  const [availableWidth, setAvailableWidth] = useState(window.innerWidth)
  useLayoutEffect(() => {
    const parent = panel.current?.parentElement
    if (!parent) return
    const measure = () => setAvailableWidth(parent.clientWidth)
    const observer = new ResizeObserver(measure)
    observer.observe(parent); measure()
    return () => observer.disconnect()
  }, [side])
  const maxWidth = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, availableWidth - 320))
  const visibleWidth = Math.min(maxWidth, Math.max(MIN_PANEL_WIDTH, width))
  const activeLabel = TABS.find((candidate) => candidate.id === tab)?.label ?? 'Workspace'

  const resizeTo = (nextWidth: number): void => {
    setRightSidebarWidth(Math.min(maxWidth, Math.max(MIN_PANEL_WIDTH, nextWidth)))
  }

  const resizeFromKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 48 : 16
    let nextWidth: number | undefined
    if (event.key === 'Home') nextWidth = MIN_PANEL_WIDTH
    else if (event.key === 'End') nextWidth = maxWidth
    else if (event.key === 'ArrowLeft') nextWidth = visibleWidth + (side === 'left' ? -step : step)
    else if (event.key === 'ArrowRight') nextWidth = visibleWidth + (side === 'left' ? step : -step)
    if (nextWidth === undefined) return
    event.preventDefault()
    resizeTo(nextWidth)
  }

  const closePanel = (): void => {
    setRightSidebarOpen(false)
    void focusPaneTarget()
  }

  return (
    <aside ref={panel} className="right-sidebar" data-side={side} style={{ width: visibleWidth }} aria-label={`${activeLabel} panel`}>
      <div
        className="right-sidebar-resize"
        role="separator"
        tabIndex={0}
        aria-label="Resize workspace panel"
        aria-orientation="vertical"
        aria-controls="workspace-tool-panel"
        aria-valuemin={MIN_PANEL_WIDTH}
        aria-valuemax={maxWidth}
        aria-valuenow={Math.round(visibleWidth)}
        title="Drag or use arrow keys to resize. Double-click to reset."
        onDoubleClick={() => resizeTo(320)}
        onKeyDown={resizeFromKeyboard}
        onPointerDown={event => { event.preventDefault(); event.currentTarget.dataset.nativeResize = ''; event.currentTarget.setPointerCapture(event.pointerId) }}
        onPointerMove={event => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
          const bounds = event.currentTarget.parentElement!.getBoundingClientRect()
          resizeTo(side === 'left' ? event.clientX - bounds.left : bounds.right - event.clientX)
        }}
        onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)}
        onLostPointerCapture={event => { delete event.currentTarget.dataset.nativeResize }}
      />
      <div className="right-sidebar-header">
        <select className="input" data-workspace-tool-heading={tab} aria-label="Workspace tool" title="Choose the tool shown in this panel" value={tab} onChange={event => useAppStore.getState().setRightSidebarTab(event.target.value as RightSidebarTab)}>{TABS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
        {activeWorktreePath && tab !== 'sessions' && <button className="icon-btn" aria-label="Move panel into workspace" title="Move this tool into a workspace tab beside your terminals and files" onClick={() => useAppStore.getState().openWorkspaceModule(activeWorktreePath, tab === 'git' ? 'git-status' : tab)}><Icon name="dock" size={14} /></button>}
        <button className="icon-btn" aria-label="Hide workspace panel" title="Hide this panel while keeping its work available" onClick={closePanel}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="rs-body" id="workspace-tool-panel" role="region" aria-label={activeLabel}>
        {tab === 'sessions' ? <HerdrSessionsPanel /> : activeWorktreePath ? <div className="workspace-pane-slot" data-sidebar-tool-slot={activeWorktreePath} /> : tab === 'recovery' ? <RecoveryPanel /> : <div className="empty-note">Select a project workspace</div>}
      </div>
    </aside>
  )
}
