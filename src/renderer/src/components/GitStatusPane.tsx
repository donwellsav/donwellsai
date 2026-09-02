import { useEffect } from 'react'
import { useAppStore } from '../store'
import { Icon } from './Icon'

export function GitStatusPane({ worktreePath }: { worktreePath: string }) {
  const status = useAppStore((s) => s.statuses[worktreePath])
  const refreshStatuses = useAppStore((s) => s.refreshStatuses)
  const openPreview = useAppStore((s) => s.openPreview)

  useEffect(() => {
    void refreshStatuses()
  }, [worktreePath, refreshStatuses])

  if (!status) return <div className="git-pane"><div className="git-loading">Loading status…</div></div>

  const rows: { label: string; count: number; cls: string }[] = [
    { label: 'Unstaged', count: status.modified, cls: 'modified' },
    { label: 'Staged', count: status.staged, cls: 'staged' },
    { label: 'Untracked', count: status.untracked, cls: 'untracked' },
    { label: 'Conflicts', count: status.conflicts, cls: 'conflicts' }
  ]

  return (
    <div className="git-pane">
      <div className="pane-toolbar">
        <span className="pane-title">Git Status</span>
        <button className="icon-btn" title="Refresh" onClick={() => void refreshStatuses()}>
          <Icon name="refresh" size={12} />
        </button>
      </div>
      <div className="git-branch-row">
        <Icon name="git" size={12} />
        <span className="git-branch">{status.branch || '(detached)'}</span>
        {status.ahead > 0 && <span className="git-ahead">↑{status.ahead}</span>}
        {status.behind > 0 && <span className="git-behind">↓{status.behind}</span>}
      </div>
      <div className="git-summary">
        {rows
          .filter((r) => r.count > 0)
          .map((r) => (
            <span key={r.label} className={`git-count ${r.cls}`}>
              {r.label} {r.count}
            </span>
          ))}
        {rows.every((r) => r.count === 0) && <span className="git-clean">Clean working tree</span>}
      </div>
      <div className="git-files">
        {status.changedFiles.map((f) => (
          <button key={f} className="git-file" title={f} onClick={() => void openPreview(worktreePath, f)}>
            <span className="git-file-path">{f}</span>
          </button>
        ))}
      </div>
    </div>
  )
}