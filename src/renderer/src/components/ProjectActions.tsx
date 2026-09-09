import { useState } from 'react'
import type { RepoSummary } from '@shared/types'
import { projectRemovalBlockers } from '../project-removal'
import { useAppStore } from '../store'
import { pathBasename } from '../workspace-navigation'
import { Icon } from './Icon'
import { ModalDialog } from './ModalDialog'
import './workspace-lifecycle.css'

/** Removing unregisters the project; it never deletes files. */
export function ProjectRemovalDialog({ repo, onClose }: { repo: RepoSummary; onClose(): void }) {
  const terminals = useAppStore((state) => state.terminals)
  const runningAgents = useAppStore((state) => state.runningAgents)
  const previews = useAppStore((state) => state.previews)
  const gitCommitDrafts = useAppStore((state) => state.gitCommitDrafts)
  const busy = useAppStore((state) => state.busy)
  const removeRepo = useAppStore((state) => state.removeRepo)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const projectName = pathBasename(repo.repo.path)
  const blockers = projectRemovalBlockers(repo, { terminals, runningAgents, previews, gitCommitDrafts, busy })

  const close = (): void => {
    if (!removing) onClose()
  }
  const confirm = async (): Promise<void> => {
    if (removing || blockers.length > 0) return
    setRemoving(true)
    setRemoveError(null)
    const result = await removeRepo(repo.repo.id)
    setRemoving(false)
    if (!result.ok) {
      setRemoveError(result.error)
      return
    }
    onClose()
  }

  return (
    <ModalDialog className="modal project-removal-modal" labelledBy="project-removal-title" onClose={close}>
      <div className="lifecycle-modal-heading">
        <h2 id="project-removal-title" className="modal-title">Remove “{projectName}” from donwells.ai?</h2>
        <p title={repo.repo.path}>{repo.repo.path}</p>
      </div>

      <div className="project-removal-scope">
        <Icon name="check-circle" size={15} />
        <div>
          <strong>Files and Git worktrees stay on disk.</strong>
          <p>This removes only the project registration and its workspace layout from this app. You can add the folder again later.</p>
        </div>
      </div>

      {blockers.length > 0 && (
        <div className="project-removal-blocked" role="status">
          <Icon name="alert" size={15} />
          <div>
            <strong>Finish active work before removing this project.</strong>
            <ul>
              {blockers.map((blocker) => <li key={blocker.key}>{blocker.message}</li>)}
            </ul>
          </div>
        </div>
      )}
      {removeError && <div className="lifecycle-error" role="alert">{removeError}</div>}

      <div className="modal-footer">
        <button className="btn btn-secondary btn-sm" disabled={removing} onClick={close}>Cancel</button>
        <button className="btn btn-danger btn-sm" disabled={removing || blockers.length > 0} onClick={() => void confirm()}>
          {removing ? 'Removing…' : 'Remove from app'}
        </button>
      </div>
    </ModalDialog>
  )
}
