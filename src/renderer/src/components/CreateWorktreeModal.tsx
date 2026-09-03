import { useState } from 'react'
import { useAppStore } from '../store'

/**
 * Worktree creation modal (Orca's NewWorkspaceComposer, lite fields):
 * name + base branch, Cmd+Enter submits.
 */
export function CreateWorktreeModal() {
  const open = useAppStore((s) => s.createOpen)
  const setOpen = useAppStore((s) => s.setCreateOpen)
  const repos = useAppStore((s) => s.repos)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const createWorktree = useAppStore((s) => s.createWorktree)
  const [name, setName] = useState('')
  const [base, setBase] = useState('')
  const [busy, setBusy] = useState(false)

  if (!open) return null
  const repo = repos.find((r) => r.repo.id === activeRepoId) ?? repos[0]
  const defaultBranch = repo?.defaultBranch ?? 'main'
  const submit = async (): Promise<void> => {
    if (!repo || !name.trim() || busy) return
    setBusy(true)
    await createWorktree(name.trim(), base.trim() || undefined)
    setBusy(false)
    setName('')
    setBase('')
    setOpen(false)
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="modal">
        <h2 className="modal-title">Create worktree</h2>
        <div className="modal-field">
          <label>Project</label>
          <div className="badge" style={{ height: 22 }}>{repo?.repo.id ?? 'no repository'}</div>
        </div>
        <div className="modal-field">
          <label>Name</label>
          <input
            className="input"
            placeholder="feature/my-work"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
              if (e.key === 'Escape') setOpen(false)
            }}
          />
        </div>
        <div className="modal-field">
          <label>Base branch (optional)</label>
          <input
            className="input"
            placeholder={defaultBranch}
            value={base}
            onChange={(e) => setBase(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
            }}
          />
        </div>
        <div className="modal-footer">
          <span className="kbd">⌘⏎</span>
          <button className="btn btn-secondary btn-sm" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button className="btn btn-primary btn-sm" disabled={!name.trim() || busy} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
