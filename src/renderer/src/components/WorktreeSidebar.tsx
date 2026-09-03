import { useState } from 'react'
import { useAppStore } from '../store'
import { Icon } from './Icon'
import { dispatchAction } from '../App'
import type { RepoSummary, Worktree } from '@shared/types'

/** Orca AgentStateDot semantics: working → yellow spinner, done → emerald check, permission → orange question.
 *  Selects the RAW agent record (stable reference); never allocates in the selector. */
type AgentVisual = { kind: 'spinner' | 'icon'; icon: 'check' | 'question' | 'activity' | null; cls: string; title: string }

function useAgentRecord(worktreePath: string): { state: string; detail?: string } | null {
  return useAppStore((s) => {
    const panes = s.panes[worktreePath]
    if (!panes) return null
    for (const p of panes) {
      if (p.kind !== 'terminal' || !p.sessionId) continue
      const a = s.runningAgents[p.sessionId]
      if (a) return a
    }
    return null
  })
}

function agentVisual(a: { state: string; detail?: string } | null): AgentVisual | null {
  if (!a) return null
  switch (a.state) {
    case 'permission':
      return { kind: 'icon', icon: 'question', cls: 'dot-agent-question', title: a.detail ?? 'Needs permission' }
    case 'done':
      return { kind: 'icon', icon: 'check', cls: 'dot-agent-done', title: a.detail ?? 'Done' }
    case 'note':
      return { kind: 'icon', icon: 'activity', cls: 'dot-agent-monitor', title: a.detail ?? 'Info' }
    default:
      return { kind: 'spinner', icon: null, cls: '', title: 'Working' }
  }
}

function StatusLane({ worktreePath }: { worktreePath: string }) {
  const record = useAgentRecord(worktreePath)
  const visual = agentVisual(record)
  const status = useAppStore((s) => s.statuses[worktreePath])
  const dirty = !!status && status.staged + status.modified > 0
  return (
    <span className="status-lane" title={visual?.title ?? (dirty ? 'Changes' : 'Clean')}>
      {visual ? (
        visual.kind === 'spinner' ? (
          <span className="agent-spin" />
        ) : (
          <Icon name={visual.icon!} size={12} className={visual.cls} />
        )
      ) : (
        <span className={`dot ${dirty ? 'dirty' : 'clean'}`} />
      )}
    </span>
  )
}

function WorktreeCardRow({ worktree, active }: { worktree: Worktree; active: boolean }) {
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const [hover, setHover] = useState(false)
  return (
    <div
      className={`wt-card${active ? ' active' : ''}`}
      data-worktree-card-active={active || undefined}
      onClick={() => setActiveWorktree(worktree.path)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
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
            style={{ visibility: hover ? 'visible' : 'hidden' }}
            onClick={(e) => {
              e.stopPropagation()
              e.preventDefault()
              useAppStore.getState().setDeleteTarget(worktree.path)
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
    <div className="repo-section">
      <div className="section-header">
        <span className="section-icon">{repo.repo.id.slice(0, 2).toUpperCase()}</span>
        <span className="section-title" title={repo.repo.path}>{repo.repo.id.split('/').pop()}</span>
        <button className="ws-icon-btn" title="New worktree in repo" onClick={() => dispatchAction('new-worktree')}>
          <Icon name="plus" size={12} />
        </button>
      </div>
      {repo.worktrees.map((w) => (
        <WorktreeCardRow key={w.id} worktree={w} active={w.path === activeWorktreePath} />
      ))}
    </div>
  )
}

/** Nav rail entry (Orca SidebarNav row: icon + label, active accent). */
function NavEntry({ icon, label, onClick, badge }: { icon: Parameters<typeof Icon>[0]['name']; label: string; onClick: () => void; badge?: number }) {
  return (
    <button className="nav-entry" onClick={onClick}>
      <Icon name={icon} size={16} className="nav-entry-icon" />
      <span className="nav-entry-label">{label}</span>
      {badge !== undefined && badge > 0 && <span className="nav-entry-badge">{badge}</span>}
    </button>
  )
}

export function WorktreeSidebar() {
  const repos = useAppStore((s) => s.repos)
  const addRepo = useAppStore((s) => s.addRepo)
  const setCreateOpen = useAppStore((s) => s.setCreateOpen)
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen)
  const activeWorktreePath = useAppStore((s) => s.activeWorktreePath)
  const runningAgents = useAppStore((s) => s.runningAgents)
  const agentCount = Object.keys(runningAgents).length

  return (
    <div className="sidebar">
      <div className="sidebar-nav">
        <button className="nav-search" onClick={() => setPaletteOpen(true)}>
          <Icon name="search" size={16} className="nav-search-icon" />
          <span className="nav-search-label">Search</span>
        </button>
        <NavEntry icon="bolt" label="Tasks" onClick={() => dispatchAction('palette')} />
        <NavEntry icon="clock" label="Automations" onClick={() => useAppStore.getState().openSettings('automations')} />
        <NavEntry icon="robot" label="Agents" badge={agentCount} onClick={() => useAppStore.getState().openSettings('general')} />
      </div>

      <div className="sidebar-scroll">
        <div className="sidebar-section-title">Projects</div>
        {repos.length === 0 ? (
          <div className="empty-note">No repositories yet.<br />Add a git repo to start.</div>
        ) : (
          repos.map((r) => <RepoSection key={r.repo.id} repo={r} />)
        )}
      </div>

      <div className="sidebar-toolbar">
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
        <span className="ws-spacer" />
        {activeWorktreePath && (
          <button className="ws-icon-btn" title="New worktree in active repo" onClick={() => dispatchAction('new-worktree')}>
            <Icon name="terminal" size={14} />
          </button>
        )}
        <button className="ws-icon-btn" title="Settings" onClick={() => useAppStore.getState().openSettings('general')}>
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
