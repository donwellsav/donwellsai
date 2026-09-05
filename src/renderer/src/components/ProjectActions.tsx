import { useState } from 'react'
import type { RepoSummary } from '@shared/types'
import { projectRemovalBlockers } from '../project-removal'
import { useAppStore } from '../store'
import { pathBasename } from '../workspace-navigation'
import { Icon } from './Icon'
import { ModalDialog } from './ModalDialog'
import './workspace-lifecycle.css'

type ProjectActionsProps = {
  repo: RepoSummary
  className?: string
}

/** Sidebar-safe project management control. Removing unregisters the project; it never deletes files. */
export function ProjectActions({ repo, className = '' }: ProjectActionsProps) {
  const terminals = useAppStore((state) => state.terminals)
  const runningAgents = useAppStore((state) => state.runningAgents)
  const previews = useAppStore((state) => state.previews)
  const gitCommitDrafts = useAppStore((state) => state.gitCommitDrafts)
  const busy = useAppStore((state) => state.busy)
  const removeRepo = useAppStore((state) => state.removeRepo)
  const [confirmationOpen, setConfirmationOpen] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const projectName = pathBasename(repo.repo.path)
  const blockers = projectRemovalBlockers(repo, { terminals, runningAgents, previews, gitCommitDrafts, busy })

  const close = (): void => {
    if (!removing) setConfirmationOpen(false)
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
    setConfirmationOpen(false)
  }

  return (
    <>
      <button
        className={`ws-icon-btn project-remove-trigger ${className}`.trim()}
        title={`Remove ${projectName} from donwells.ai`}
        aria-label={`Remove ${projectName} from donwells.ai`}
        onClick={() => {
          setRemoveError(null)
          setConfirmationOpen(true)
        }}
      >
        <Icon name="x" size={11} />
      </button>
      {confirmationOpen && (
        <ModalDialog className="modal project-removal-modal" labelledBy="project-removal-title" onClose={close}>
          <div className="lifecycle-modal-heading">
            <span className="lifecycle-eyebrow">Project registration</span>
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
      )}
    </>
  )
}
