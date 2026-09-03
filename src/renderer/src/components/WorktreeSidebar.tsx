import { useAppStore } from '../store'
import { Icon } from './Icon'
import type { RepoSummary, Worktree } from '@shared/types'

/** Status dot/spinner for a worktree card's left lane (Orca StatusIndicator semantics). */
function StatusLane({ worktreePath }: { worktreePath: string }) {
  const running = useAppStore((s) => {
    const panes = s.panes[worktreePath] ?? []
    return panes.some((p) => p.kind === 'terminal' && p.sessionId && s.runningAgents[p.sessionId!])
  })
  const status = useAppStore((s) => s.statuses[worktreePath])
  if (running) return <span className="status-lane"><span className="spinner" /></span>
  const cls = !status ? 'clean' : status.staged + status.modified > 0 ? 'dirty' : 'done'
  return <span className="status-lane"><span className={`dot ${cls}`} /></span>
}

function WorktreeCardRow({ worktree, active }: { worktree: Worktree; active: boolean }) {
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const removeWorktree = useAppStore((s) => s.removeWorktree)
  return (
    <div
      className={`wt-card${active ? ' active' : ''}`}
      data-worktree-card-active={active || undefined}
      onClick={() => setActiveWorktree(worktree.path)}
      role="button"
      tabIndex={0}
    >
      <div className="wt-card-row">
        <span className="status-lane"><StatusLane worktreePath={worktree.path} /></span>
        <span className="wt-name">{worktree.branch.split('/').pop()}</span>
        {worktree.isMain && <span className="badge">main</span>}
        {!worktree.isMain && (
          <button
            className="ws-icon-btn"
            title="Delete worktree (to Trash)"
            onClick={(e) => {
              e.stopPropagation()
              if (confirm(`Delete worktree "${worktree.branch.split('/').pop()}"? (moves to Trash)`)) {
                void removeWorktree(worktree.path, false)
              }
            }}
          >
            <Icon name="x" size={12} />
          </button>
        )}
      </div>
      <div className="wt-meta">
        <span className="wt-branch">{worktree.branch}</span>
      </div>
    </div>
  )
}

function RepoSection({ repo }: { repo: RepoSummary }) {
  const activeWorktreePath = useAppStore((s) => s.activeWorktreePath)
  return (
    <div>
      <div className="section-header">
        <span className="section-icon">{repo.repo.id.slice(0, 2).toUpperCase()}</span>
        <span className="section-title" title={repo.repo.path}>{repo.repo.id.split('/').pop()}</span>
      </div>
      {repo.worktrees.map((w) => (
        <WorktreeCardRow key={w.id} worktree={w} active={w.path === activeWorktreePath} />
      ))}
    </div>
  )
}

/** Left worktree sidebar: repo-grouped worktree cards (Orca's WorktreeList). */
export function WorktreeSidebar() {
  const repos = useAppStore((s) => s.repos)
  const addRepo = useAppStore((s) => s.addRepo)
  const setCreateOpen = useAppStore((s) => s.setCreateOpen)
  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Workspaces</span>
        <button className="ws-icon-btn" title="New worktree" onClick={() => setCreateOpen(true)}>
          <Icon name="plus" size={14} />
        </button>
        <button
          className="ws-icon-btn"
          title="Add repository"
          onClick={() => void (async () => {
            const dir = await window.orca.pickDirectory()
            if (dir) void addRepo(dir)
          })()}
        >
          <Icon name="dir" size={14} />
        </button>
      </div>
      <div className="sidebar-scroll">
        {repos.length === 0 ? (
          <div className="empty-note">No repositories yet.<br />Add a git repo to start.</div>
        ) : (
          repos.map((r) => <RepoSection key={r.repo.id} repo={r} />)
        )}
      </div>
      <div className="sidebar-toolbar">
        <button
          className="ws-icon-btn"
          title="Settings"
          onClick={() => useAppStore.getState().setSettingsOpen(true)}
        >
          <Icon name="gear" size={14} />
        </button>
      </div>
      <div
        className="sidebar-resize"
        onMouseDown={(e) => {
          e.preventDefault()
          const sidebar = e.currentTarget.parentElement as HTMLElement
          const startX = e.clientX
          const startW = sidebar.offsetWidth
          const move = (ev: MouseEvent): void => {
            const w = Math.min(500, Math.max(220, startW + ev.clientX - startX))
            sidebar.style.width = `${w}px`
          }
          const up = (): void => {
            window.removeEventListener('mousemove', move)
            window.removeEventListener('mouseup', up)
          }
          window.addEventListener('mousemove', move)
          window.addEventListener('mouseup', up)
        }}
      />
    </div>
  )
}
