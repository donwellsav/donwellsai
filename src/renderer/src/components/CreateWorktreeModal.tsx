import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../store'
import { pathBasename } from '../workspace-navigation'
import { ModalDialog } from './ModalDialog'
import './workspace-lifecycle.css'

/** Create a Git worktree without letting a failed request discard the user's draft. */
export function CreateWorktreeModal() {
  const open = useAppStore((state) => state.createOpen)
  const setOpen = useAppStore((state) => state.setCreateOpen)
  const repos = useAppStore((state) => state.repos)
  const activeRepoId = useAppStore((state) => state.activeRepoId)
  const createWorktree = useAppStore((state) => state.createWorktree)
  const gitRepos = useMemo(() => repos.filter((repo) => repo.repo.kind !== 'folder'), [repos])
  const [repoId, setRepoId] = useState('')
  const [name, setName] = useState('')
  const [base, setBase] = useState('')
  const [busy, setBusy] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setRepoId((current) => {
      if (gitRepos.some((repo) => repo.repo.id === current)) return current
      return gitRepos.find((repo) => repo.repo.id === activeRepoId)?.repo.id ?? gitRepos[0]?.repo.id ?? ''
    })
  }, [open, activeRepoId, gitRepos])

  if (!open) return null
  const repo = gitRepos.find((candidate) => candidate.repo.id === repoId)
  const defaultBranch = repo?.defaultBranch || repo?.currentBranch || 'main'
  const isMac = navigator.userAgent.includes('Mac')
  const close = (): void => {
    if (!busy) setOpen(false)
  }
  const submit = async (): Promise<void> => {
    if (!repo || !name.trim() || busy) return
    setBusy(true)
    setSubmitError(null)
    const result = await createWorktree(repo.repo.id, name.trim(), base.trim() || undefined)
    setBusy(false)
    if (!result.ok) {
      setSubmitError(result.error)
      return
    }
    setName('')
    setBase('')
    setSubmitError(null)
    setOpen(false)
  }

  return (
    <ModalDialog labelledBy="create-worktree-title" onClose={close}>
      <div className="lifecycle-modal-heading">
        <span className="lifecycle-eyebrow">New workspace</span>
        <h2 id="create-worktree-title" className="modal-title">Create worktree</h2>
        <p>Start an isolated branch workspace inside one of your registered Git projects.</p>
      </div>
      <div className="modal-field">
        <label htmlFor="worktree-project">Git project</label>
        <select
          id="worktree-project"
          className="input lifecycle-select"
          value={repoId}
          disabled={busy || gitRepos.length === 0}
          onChange={(event) => {
            setRepoId(event.target.value)
            setSubmitError(null)
          }}
        >
          {gitRepos.length === 0 && <option value="">No Git projects registered</option>}
          {gitRepos.map((candidate) => (
            <option key={candidate.repo.id} value={candidate.repo.id}>
              {pathBasename(candidate.repo.path)} — {candidate.repo.path}
            </option>
          ))}
        </select>
        {gitRepos.length === 0 && (
          <p className="lifecycle-field-note">Add a Git repository first. Plain folders can be opened directly, but they cannot create worktrees.</p>
        )}
      </div>
      <div className="modal-field">
        <label htmlFor="worktree-name">Worktree name</label>
        <input
          id="worktree-name"
          className="input"
          placeholder="feature/my-work"
          autoFocus
          value={name}
          disabled={busy}
          aria-describedby={submitError ? 'create-worktree-error' : undefined}
          onChange={(event) => {
            setName(event.target.value)
            setSubmitError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (isMac ? event.metaKey : event.ctrlKey)) void submit()
          }}
        />
      </div>
      <div className="modal-field">
        <label htmlFor="worktree-base">Base branch <span className="lifecycle-optional">optional</span></label>
        <input
          id="worktree-base"
          className="input"
          placeholder={defaultBranch}
          value={base}
          disabled={busy}
          onChange={(event) => {
            setBase(event.target.value)
            setSubmitError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (isMac ? event.metaKey : event.ctrlKey)) void submit()
          }}
        />
      </div>
      {submitError && <div id="create-worktree-error" className="lifecycle-error" role="alert">{submitError}</div>}
      <div className="modal-footer">
        <span className="kbd">{isMac ? '⌘⏎' : 'Ctrl+Enter'}</span>
        <button className="btn btn-secondary btn-sm" disabled={busy} onClick={close}>Cancel</button>
        <button className="btn btn-primary btn-sm" disabled={!repo || !name.trim() || busy} onClick={() => void submit()}>
          {busy ? 'Creating…' : 'Create worktree'}
        </button>
      </div>
    </ModalDialog>
  )
}
