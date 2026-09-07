import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { useAppStore } from '../store'
import { Icon } from './Icon'
import { ExplorerPane } from './ExplorerPane'
import { GitPane } from './GitPane'
import { ProjectMemoryPanel } from './ProjectMemoryPanel'
import { RecoveryPanel } from './RecoveryPanel'
import { ComputerControlPanel } from './ComputerControlPanel'
import { ProjectSearch } from './ProjectSearch'

export type RightSidebarTab = 'explorer' | 'git' | 'memory' | 'recovery' | 'search' | 'computer'

const MIN_PANEL_WIDTH = 260
const MAX_PANEL_WIDTH = 480
const TABS: ReadonlyArray<{ id: RightSidebarTab; label: string }> = [
  { id: 'search', label: 'Search' },
  { id: 'explorer', label: 'Files' },
  { id: 'git', label: 'Changes' },
  { id: 'memory', label: 'Memory' },
  { id: 'recovery', label: 'Recovery' },
  { id: 'computer', label: 'Control' }
]

export function RightSidebar() {
  const tab = useAppStore((s) => s.rightSidebarTab)
  const setRightSidebarOpen = useAppStore((s) => s.setRightSidebarOpen)
  const activeWorktreePath = useAppStore((s) => s.activeWorktreePath)
  const width = useAppStore((s) => s.rightSidebarWidth)
  const setRightSidebarWidth = useAppStore((s) => s.setRightSidebarWidth)
  const maxWidth = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, Math.floor(window.innerWidth * 0.34)))
  const visibleWidth = Math.min(maxWidth, Math.max(MIN_PANEL_WIDTH, width))
  const activeLabel = TABS.find((candidate) => candidate.id === tab)?.label ?? 'Workspace'

  const resizeTo = (nextWidth: number): void => {
    setRightSidebarWidth(Math.min(maxWidth, Math.max(MIN_PANEL_WIDTH, nextWidth)))
  }

  const startResize = (event: ReactMouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const right = event.currentTarget.parentElement!.getBoundingClientRect().right
    const move = (moveEvent: MouseEvent): void => resizeTo(right - moveEvent.clientX)
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const resizeFromKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 48 : 16
    let nextWidth: number | undefined
    if (event.key === 'Home') nextWidth = MIN_PANEL_WIDTH
    else if (event.key === 'End') nextWidth = maxWidth
    else if (event.key === 'ArrowLeft') nextWidth = visibleWidth + step
    else if (event.key === 'ArrowRight') nextWidth = visibleWidth - step
    if (nextWidth === undefined) return
    event.preventDefault()
    resizeTo(nextWidth)
  }

  const closePanel = (): void => {
    setRightSidebarOpen(false)
  }

  return (
    <aside className="right-sidebar" style={{ width: visibleWidth }} aria-label={`${activeLabel} panel`}>
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
        onMouseDown={startResize}
      />
      <div className="right-sidebar-header">
        <h2 className="workspace-tool-title" tabIndex={-1} data-workspace-tool-heading={tab}>{activeLabel}</h2>
        {activeWorktreePath && <button className="icon-btn" aria-label="Move panel into workspace" title="Move into workspace" onClick={() => useAppStore.getState().openWorkspaceModule(activeWorktreePath, tab === 'git' ? 'git-status' : tab)}><Icon name="columns" size={13} /></button>}
        <button className="icon-btn" aria-label="Close workspace panel" title="Close panel" onClick={closePanel}>
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="rs-body" id="workspace-tool-panel" role="region" aria-label={activeLabel}>
        {tab === 'recovery' ? <RecoveryPanel /> : activeWorktreePath ? (
          tab === 'computer' ? <ComputerControlPanel key={activeWorktreePath} workspacePath={activeWorktreePath} /> :
          tab === 'search' ? <ProjectSearch workspacePath={activeWorktreePath} /> :
          tab === 'memory' ? <ProjectMemoryPanel key={activeWorktreePath} workspacePath={activeWorktreePath} /> :
          tab === 'explorer' ? <ExplorerPane worktreePath={activeWorktreePath} /> : <GitPane worktreePath={activeWorktreePath} />
        ) : <div className="empty-note">Select a project workspace</div>}
      </div>
    </aside>
  )
}
