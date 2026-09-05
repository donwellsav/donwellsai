import { useMemo, useState } from 'react'
import { useAppStore } from '../store'
import { descendantsOf } from '@shared/worktree-lineage'
import { Icon } from './Icon'
import { ModalDialog } from './ModalDialog'

/**
 * Destructive-action confirmation (upstream DeleteWorktreeDialog parity):
 * warns about uncommitted changes and lists descendant worktrees cut from
 * this branch before allowing the delete.
 */
export function DeleteWorktreeModal() {
  const target = useAppStore((s) => s.deleteTarget)
  const setDeleteTarget = useAppStore((s) => s.setDeleteTarget)
  const repos = useAppStore((s) => s.repos)
  const statuses = useAppStore((s) => s.statuses)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ target: string; message: string } | null>(null)

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

  const close = (): void => { if (!busy) setDeleteTarget(null) }
  const confirm = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setFailure(null)
    try {
      const result = await useAppStore.getState().removeWorktree(target, false)
      if (result.ok) setDeleteTarget(null)
      else setFailure({ target, message: result.error })
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalDialog className="modal delete-modal" labelledBy="delete-worktree-title" onClose={close}>
        <h3 id="delete-worktree-title" className="modal-title">Remove worktree “{info.name}”?</h3>
        <p className="lifecycle-field-note">The worktree folder will be moved to Trash. The branch is kept. Close its terminals and save or resolve all editor changes first.</p>

        {info.dirty > 0 && (
          <div className="delete-warning">
            <Icon name="alert" size={14} />
            <div>
              <strong>
                {info.dirty} uncommitted or untracked change{info.dirty === 1 ? '' : 's'}
              </strong>
              <p>Commit or stash these changes before removing this worktree.</p>
            </div>
          </div>
        )}

        {info.childNames.length > 0 && (
          <div className="delete-lineage">
            <strong>
              {info.childNames.length} child worktree{info.childNames.length === 1 ? '' : 's'} remain on disk:
            </strong>
            <ul>
              {info.childNames.slice(0, 4).map((n) => (
                <li key={n}>{n}</li>
              ))}
              {info.childNames.length > 4 && <li>+{info.childNames.length - 4} more…</li>}
            </ul>
          </div>
        )}
        {failure?.target === target && <p className="lifecycle-error" role="alert">{failure.message}</p>}

        <div className="modal-actions">
          <button className="btn" disabled={busy} onClick={close}>Cancel</button>
          <button className="btn btn-danger" disabled={busy || info.dirty > 0} onClick={() => void confirm()}>{busy ? 'Removing…' : 'Move to Trash'}</button>
        </div>
    </ModalDialog>
  )
}
