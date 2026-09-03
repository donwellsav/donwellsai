import { useMemo } from 'react'
import { useAppStore } from '../store'
import { descendantsOf } from '@shared/worktree-lineage'
import { Icon } from './Icon'

/**
 * Destructive-action confirmation (Orca DeleteWorktreeDialog parity):
 * warns about uncommitted changes and lists descendant worktrees cut from
 * this branch before allowing the delete.
 */
export function DeleteWorktreeModal() {
  const target = useAppStore((s) => s.deleteTarget)
  const setDeleteTarget = useAppStore((s) => s.setDeleteTarget)
  const repos = useAppStore((s) => s.repos)
  const statuses = useAppStore((s) => s.statuses)

  const info = useMemo(() => {
    if (!target) return null
    const repo = repos.find((r) => r.worktrees.some((w) => w.path === target))
    const wt = repo?.worktrees.find((w) => w.path === target)
    if (!repo || !wt) return null
    const lineage = repo.lineage ?? {}
    const childBranches = descendantsOf(lineage, wt.branch)
    const childNames = childBranches
      .map((b) => repo.worktrees.find((w) => w.branch === b)?.path.split('/').filter(Boolean).pop() ?? b)
      .filter((n, i, a) => a.indexOf(n) === i)
    const st = statuses[target]
    const dirty = st ? st.staged + st.modified + st.untracked + st.conflicts : 0
    return { repo, wt, name: target.split('/').filter(Boolean).pop() ?? wt.branch, dirty, childNames }
  }, [target, repos, statuses])

  if (!target || !info) return null

  const close = (): void => setDeleteTarget(null)
  const confirm = (): void => {
    void useAppStore.getState().removeWorktree(target, false)
    close()
  }

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal delete-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Delete worktree “{info.name}”?</h3>

        {info.dirty > 0 && (
          <div className="delete-warning">
            <Icon name="alert" size={14} />
            <div>
              <strong>
                {info.dirty} uncommitted or untracked change{info.dirty === 1 ? '' : 's'}
              </strong>
              <p>Deleting this worktree permanently removes these changes from disk.</p>
            </div>
          </div>
        )}

        {info.childNames.length > 0 && (
          <div className="delete-lineage">
            <strong>
              Deleting this worktree also affects {info.childNames.length} child worktree
              {info.childNames.length === 1 ? '' : 's'}:
            </strong>
            <ul>
              {info.childNames.slice(0, 4).map((n) => (
                <li key={n}>{n}</li>
              ))}
              {info.childNames.length > 4 && <li>+{info.childNames.length - 4} more…</li>}
            </ul>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn btn-danger" onClick={confirm}>Delete</button>
        </div>
      </div>
    </div>
  )
}
