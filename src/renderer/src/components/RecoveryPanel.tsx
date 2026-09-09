import { useEffect, useState, useSyncExternalStore } from 'react'
import type { EditorRecoveryEntry } from '@shared/editor-recovery'
import { getEditorRecoveryController } from '../editor-recovery'
import { useAppStore } from '../store'
import { ModalDialog } from './ModalDialog'
import './editor-recovery.css'

type RecoveryPanelProps = {
  workspacePath?: string
  onRestore?(entry: EditorRecoveryEntry): void | Promise<void>
}

export function RecoveryPanel({ workspacePath, onRestore }: RecoveryPanelProps) {
  const controller = getEditorRecoveryController()
  const snapshot = useSyncExternalStore(controller.subscribe, () => controller.getSnapshot())
  const [discardTarget, setDiscardTarget] = useState<EditorRecoveryEntry | null>(null)
  const [busyCheckpointId, setBusyCheckpointId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const entries = workspacePath
    ? snapshot.entries.filter((entry) => entry.workspacePath === workspacePath)
    : snapshot.entries

  useEffect(() => {
    void controller.load().catch(() => undefined)
  }, [controller])

  const restore = async (entry: EditorRecoveryEntry): Promise<void> => {
    setBusyCheckpointId(entry.checkpointId)
    setActionError(null)
    try {
      if (onRestore) {
        await onRestore(entry)
      } else {
        const state = useAppStore.getState()
        const repo = state.repos.find((candidate) => candidate.worktrees.some((worktree) => worktree.path === entry.workspacePath))
        if (!repo) throw new Error('Workspace is unavailable. The recovery draft was retained.')
        state.setActiveWorktree(entry.workspacePath)
        await state.openPreview(entry.workspacePath, entry.relPath, { mode: 'edit' })
        const restored = useAppStore.getState().previews[entry.workspacePath]?.[entry.relPath]
        if (!restored) throw new Error(useAppStore.getState().error ?? 'File is unavailable. The recovery draft was retained.')
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyCheckpointId(null)
    }
  }

  const discard = async (): Promise<void> => {
    const entry = discardTarget
    if (!entry) return
    setBusyCheckpointId(entry.checkpointId)
    setActionError(null)
    try {
      const removed = await controller.discard(entry)
      if (!removed) {
        setActionError('This draft changed before it could be discarded. Review the newest recovery first.')
        return
      }
      setDiscardTarget(null)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyCheckpointId(null)
    }
  }

  return (
    <section className="recovery-panel" aria-label="Recovery drafts">
      <div className="recovery-panel-header">
        <span className="recovery-panel-title" title={workspacePath}>
          {workspacePath ? workspacePath.split(/[\\/]/).filter(Boolean).at(-1) : 'All checkouts'}
        </span>
        <span className="recovery-panel-count">{entries.length} {entries.length === 1 ? 'draft' : 'drafts'}</span>
      </div>
      {snapshot.loading && <div className="recovery-panel-state" role="status">Checking protected drafts…</div>}
      {snapshot.error && (
        <div className="recovery-panel-alert" role="alert">
          <span>{snapshot.error}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void controller.refresh().catch(() => undefined)}>Retry</button>
        </div>
      )}
      {actionError && <div className="recovery-panel-alert" role="alert" aria-live="assertive">{actionError}</div>}
      {!snapshot.loading && !snapshot.error && entries.length === 0 && (
        <div className="recovery-panel-state">No unsaved drafts</div>
      )}

      {entries.length > 0 && (
        <ul className="recovery-list">
          {entries.map((entry) => {
            const workspaceName = entry.workspacePath.split(/[\\/]/).filter(Boolean).at(-1) ?? entry.workspacePath
            const busy = busyCheckpointId === entry.checkpointId
            return (
              <li className="recovery-row" key={entry.checkpointId}>
                <div className="recovery-row-copy">
                  <span className="recovery-row-path" title={entry.relPath}>{entry.relPath}</span>
                  <span className="recovery-row-meta" title={entry.workspacePath}>
                    {workspaceName} · {new Date(entry.updatedAt).toLocaleString()}
                  </span>
                </div>
                <div className="recovery-row-actions">
                  <button type="button" className="btn btn-secondary btn-sm" title="Open this file in the editor with its protected recovery draft" disabled={busyCheckpointId !== null} onClick={() => void restore(entry)}>
                    {busy ? 'Restoring…' : 'Restore'}
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm danger" title="Review a confirmation before permanently removing this unsaved draft; the file on disk stays unchanged" disabled={busyCheckpointId !== null} onClick={() => setDiscardTarget(entry)}>
                    Discard
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {discardTarget && (
        <ModalDialog
          className="modal delete-modal"
          labelledBy="recovery-discard-title"
          onClose={() => { if (!busyCheckpointId) setDiscardTarget(null) }}
        >
          <h3 className="modal-title" id="recovery-discard-title">Discard recovery draft?</h3>
          <p>
            This permanently removes the protected unsaved text for <strong>{discardTarget.relPath}</strong>.
            The file on disk is not changed.
          </p>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" disabled={busyCheckpointId !== null} onClick={() => setDiscardTarget(null)}>Cancel</button>
            <button type="button" className="btn btn-danger" disabled={busyCheckpointId !== null} onClick={() => void discard()}>{busyCheckpointId ? 'Discarding…' : 'Discard draft'}</button>
          </div>
        </ModalDialog>
      )}
    </section>
  )
}
