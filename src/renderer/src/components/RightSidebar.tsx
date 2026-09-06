import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { useAppStore } from '../store'
import { Icon } from './Icon'
import { ExplorerPane } from './ExplorerPane'
import { GitPane } from './GitPane'
import { ProjectMemoryPanel } from './ProjectMemoryPanel'
import { RecoveryPanel } from './RecoveryPanel'
import { ProjectSearch } from './ProjectSearch'

export type RightSidebarTab = 'explorer' | 'git' | 'memory' | 'recovery' | 'search'

const MIN_PANEL_WIDTH = 260
const MAX_PANEL_WIDTH = 480
const TABS: ReadonlyArray<{ id: RightSidebarTab; label: string }> = [
  { id: 'search', label: 'Search' },
  { id: 'explorer', label: 'Files' },
  { id: 'git', label: 'Changes' },
  { id: 'memory', label: 'Memory' },
  { id: 'recovery', label: 'Recovery' }
]

export function RightSidebar() {
  const tab = useAppStore((s) => s.rightSidebarTab)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)
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

  const selectTab = (index: number): void => {
    const next = TABS[index]
    if (!next) return
    setRightSidebarTab(next.id)
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-right-sidebar-tab="${next.id}"]`)?.focus())
  }

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    let nextIndex: number | undefined
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % TABS.length
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + TABS.length) % TABS.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = TABS.length - 1
    if (nextIndex === undefined) return
    event.preventDefault()
    selectTab(nextIndex)
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
        <div className="rs-tabs" role="tablist" aria-label="Workspace panel">
          {TABS.map((candidate, index) => (
            <button
              key={candidate.id}
              className={`rs-tab${tab === candidate.id ? ' active' : ''}`}
              role="tab"
              data-right-sidebar-tab={candidate.id}
              aria-selected={tab === candidate.id}
              aria-controls="workspace-tool-panel"
              tabIndex={tab === candidate.id ? 0 : -1}
              onClick={() => setRightSidebarTab(candidate.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              {candidate.label}
            </button>
          ))}
        </div>
        {activeWorktreePath && <button className="icon-btn" aria-label="Move panel into workspace" title="Move into workspace" onClick={() => useAppStore.getState().openWorkspaceModule(activeWorktreePath, tab === 'git' ? 'git-status' : tab)}><Icon name="columns" size={13} /></button>}
        <button className="icon-btn" aria-label="Close workspace panel" title="Close panel" onClick={closePanel}>
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="rs-body" id="workspace-tool-panel" role="tabpanel" aria-label={activeLabel}>
        {tab === 'recovery' ? <RecoveryPanel /> : activeWorktreePath ? (
          tab === 'search' ? <ProjectSearch workspacePath={activeWorktreePath} /> :
          tab === 'memory' ? <ProjectMemoryPanel key={activeWorktreePath} workspacePath={activeWorktreePath} /> :
          tab === 'explorer' ? <ExplorerPane worktreePath={activeWorktreePath} /> : <GitPane worktreePath={activeWorktreePath} />
        ) : <div className="empty-note">Select a project workspace</div>}
      </div>
    </aside>
  )
}
