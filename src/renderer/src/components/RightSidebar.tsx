import { useAppStore } from '../store'
import { Icon } from './Icon'
import { ExplorerPane } from './ExplorerPane'
import { GitStatusPane } from './GitStatusPane'

export type RightSidebarTab = 'explorer' | 'git'

/** Right sidebar: Explorer / Git tabs for the active worktree (Orca's right-sidebar). */
export function RightSidebar() {
  const tab = useAppStore((s) => s.rightSidebarTab)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)
  const setRightSidebarOpen = useAppStore((s) => s.setRightSidebarOpen)
  const activeWorktreePath = useAppStore((s) => s.activeWorktreePath)

  return (
    <div className="right-sidebar">
      <div className="right-sidebar-header">
        <div className="rs-tabs">
          <button
            className={`rs-tab${tab === 'explorer' ? ' active' : ''}`}
            onClick={() => setRightSidebarTab('explorer')}
          >
            Explorer
          </button>
          <button
            className={`rs-tab${tab === 'git' ? ' active' : ''}`}
            onClick={() => setRightSidebarTab('git')}
          >
            Git
          </button>
        </div>
        <button className="icon-btn" title="Close sidebar" onClick={() => setRightSidebarOpen(false)}>
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="rs-body">
        {activeWorktreePath ? (
          tab === 'explorer' ? (
            <ExplorerPane worktreePath={activeWorktreePath} />
          ) : (
            <GitStatusPane worktreePath={activeWorktreePath} />
          )
        ) : (
          <div className="empty-note">No active worktree</div>
        )}
      </div>
    </div>
  )
}
