import { useEffect, useState } from 'react'
import { PROJECT_MEMORY_KINDS, PROJECT_MEMORY_MAX_CONTENT_LENGTH, PROJECT_MEMORY_MAX_TITLE_LENGTH } from '@shared/project-memory'
import type { ProjectMemoryEntry, ProjectMemoryHistoryResult } from '@shared/project-memory'
import { archiveProjectMemoryEditor, eraseProjectMemoryEditor, resolveProjectMemoryEditor, memoryDraftIsDirty, saveProjectMemoryEditor, useProjectMemoryEditor } from '../project-memory-editor'
import { pathBasename } from '../workspace-navigation'
import { ModalDialog } from './ModalDialog'
import './project-memory.css'

export function ProjectMemoryEditor() {
  const editor = useProjectMemoryEditor((state) => state.editor)
  const busy = useProjectMemoryEditor((state) => state.busy)
  const error = useProjectMemoryEditor((state) => state.error)
  const change = useProjectMemoryEditor((state) => state.change)
  const [discarding, setDiscarding] = useState(false)
  const [erasing, setErasing] = useState(false)
  const [history, setHistory] = useState<ProjectMemoryHistoryResult | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyAttempt, setHistoryAttempt] = useState(0)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [reviewedLatest, setReviewedLatest] = useState<ProjectMemoryEntry | null>(null)
  const [resolving, setResolving] = useState(false)
  const entryId = editor?.entry?.id
  const workspacePath = editor?.workspacePath

  useEffect(() => {
    setDiscarding(false)
    setErasing(false)
    setHistoryOpen(false)
    setHistory(null)
    setHistoryError(null)
    setHistoryLoading(false)
    setReviewedLatest(null)
  }, [entryId, workspacePath])
  useEffect(() => {
    if (!historyOpen || !entryId || !workspacePath) return
    let cancelled = false
    setHistoryLoading(true)
    setHistory(null)
    setHistoryError(null)
    void window.donwells.projectMemoryHistory({ workspacePath, id: entryId }).then((result) => {
      if (!cancelled) setHistory(result)
    }, (cause) => {
      if (!cancelled) setHistoryError(String(cause))
    }).finally(() => {
      if (!cancelled) setHistoryLoading(false)
    })
    return () => { cancelled = true }
  }, [historyAttempt, historyOpen, entryId, workspacePath])

  if (!editor) return null
  const { draft, entry } = editor
  const dirty = memoryDraftIsDirty(editor)
  const archived = !!entry?.archivedAt
  const revisionConflict = !!(entry && error && /revision|conflict|changed before|changed since/i.test(error))
  const close = (): void => {
    if (busy) return
    if (dirty) setDiscarding(true)
    else useProjectMemoryEditor.setState({ editor: null, error: null })
  }

  const saveAsNew = (): void => {
    const blankOriginal = { kind: draft.kind, title: '', content: '', tags: '', sourceRef: '' }
    useProjectMemoryEditor.setState((state) => state.editor === editor
      ? { editor: { ...editor, entry: null, original: blankOriginal }, error: null }
      : {})
    setReviewedLatest(null)
    setHistoryOpen(false)
  }

  const compareLatest = async (): Promise<void> => {
    if (!entry || resolving) return
    const editorAtStart = editor
    setResolving(true)
    try {
      const latest = await window.donwells.projectMemoryGet({ workspacePath: editor.workspacePath, id: entry.id })
      if (useProjectMemoryEditor.getState().editor === editorAtStart) setReviewedLatest(latest)
    } catch (cause) {
      if (useProjectMemoryEditor.getState().editor === editorAtStart) useProjectMemoryEditor.setState({ error: 'Could not load the latest memory revision: ' + String(cause) })
    } finally { setResolving(false) }
  }
  const resolveWithReviewed = (retainDraft: boolean): void => {
    if (!reviewedLatest || reviewedLatest.id !== entry?.id || busy || (retainDraft && reviewedLatest.archivedAt)) return
    resolveProjectMemoryEditor(editor, reviewedLatest, retainDraft)
    setReviewedLatest(null)
    setHistory(null)
    setHistoryOpen(false)
  }
  return (
    <ModalDialog className="modal memory-editor" labelledBy="memory-editor-title" onClose={close}>
      <header className="memory-editor-heading">
        <div><span className="memory-caption">Project memory · {pathBasename(editor.workspacePath)}</span>
          <h2 id="memory-editor-title">{entry ? 'Review project knowledge' : 'Record project knowledge'}</h2></div>
        {entry && <span className="badge">Revision {entry.revision}{archived ? ' · Archived' : ''}</span>}
      </header>
      <p className="memory-guidance">Shared context for this project's coding harnesses. Record verified conventions, decisions, and lessons—not credentials or raw transcripts.</p>
      <div className="memory-editor-fields">
        <label><span className="memory-field-label"><span>Title</span><span className="memory-field-count">{draft.title.length.toLocaleString()} / {PROJECT_MEMORY_MAX_TITLE_LENGTH.toLocaleString()}</span></span><input className="input" autoFocus value={draft.title} maxLength={PROJECT_MEMORY_MAX_TITLE_LENGTH} disabled={busy || resolving || archived} onChange={(event) => change({ title: event.target.value })} placeholder="How this project builds and verifies changes" /></label>
        <div className="memory-field-pair">
          <label>Kind<select className="input" value={draft.kind} disabled={busy || resolving || archived} onChange={(event) => {
            const kind = PROJECT_MEMORY_KINDS.find((value) => value === event.target.value)
            if (kind) change({ kind })
          }}>{PROJECT_MEMORY_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></label>
          <label>Tags<input className="input" value={draft.tags} disabled={busy || resolving || archived} onChange={(event) => change({ tags: event.target.value })} placeholder="build, testing, typescript" /></label>
        </div>
        <label><span className="memory-field-label"><span>Knowledge</span><span className="memory-field-count">{draft.content.length.toLocaleString()} / {PROJECT_MEMORY_MAX_CONTENT_LENGTH.toLocaleString()}</span></span><textarea className="input memory-content-input" value={draft.content} maxLength={PROJECT_MEMORY_MAX_CONTENT_LENGTH} disabled={busy || resolving || archived} onChange={(event) => change({ content: event.target.value })} placeholder="What should another coding harness know, and why? Include concrete commands, constraints, or evidence." /></label>
        <label><span className="memory-field-label"><span>Source reference</span><span className="memory-caption">Optional</span></span><input className="input" value={draft.sourceRef} disabled={busy || resolving || archived} onChange={(event) => change({ sourceRef: event.target.value })} placeholder="package.json, a source path, commit, or issue URL" /></label>
      </div>
      {entry && <p className="memory-provenance">Last attributed to <strong>{entry.provenance.harness}</strong> · {new Date(entry.updatedAt).toLocaleString()}{entry.provenance.sourceSession ? ` · Session ${entry.provenance.sourceSession}` : ''}. Harness attribution is self-reported.</p>}
      {error && <div className="memory-error" role="alert">
        <strong>Memory action failed</strong>
        <p>{error}</p>
        <p>{revisionConflict ? 'Your draft is retained. Compare revision history before resolving the conflicting change.' : 'Your draft is retained. You can retry the action without re-entering it.'}</p>
        {revisionConflict && !reviewedLatest && <div className="memory-error-actions"><button type="button" className="btn btn-secondary btn-sm" disabled={resolving} onClick={() => void compareLatest()}>{resolving ? 'Loading…' : 'Compare latest…'}</button><button type="button" className="btn btn-primary btn-sm" disabled={resolving} onClick={saveAsNew}>Keep as new draft</button></div>}

      </div>}
      {reviewedLatest && <section className="memory-history" aria-label="Review latest revision before resolving">
        <strong>Latest saved revision {reviewedLatest.revision}{reviewedLatest.archivedAt ? ' · Archived' : ''}</strong>
        <p>{reviewedLatest.title} · {reviewedLatest.kind}</p>
        <pre>{reviewedLatest.content}</pre>
        <p>Tags: {reviewedLatest.tags.join(', ') || 'None'} · Source: {reviewedLatest.provenance.sourceRef || 'None'}</p>
        <p>Your authored draft remains in the fields above. Reapply keeps those fields and updates the revision used by Save memory. Saving remains a separate action.</p>
        {reviewedLatest.archivedAt && <p>This entry was archived. Keep your draft as a new fact, or replace it with the archived revision to restore that entry.</p>}
        <div className="memory-error-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setReviewedLatest(null)}>Keep editing</button>
          <button type="button" className="btn btn-danger btn-sm" onClick={() => resolveWithReviewed(false)}>Replace draft with reviewed revision</button>
          <button type="button" className="btn btn-primary btn-sm" disabled={!!reviewedLatest.archivedAt} onClick={() => resolveWithReviewed(true)}>Reapply draft to latest revision</button>
          {reviewedLatest.archivedAt && <button type="button" className="btn btn-secondary btn-sm" onClick={saveAsNew}>Keep as new draft</button>}
        </div>
      </section>}
      {entry && <section className="memory-history">
        <button type="button" className="btn btn-secondary btn-sm" aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>Revision history</button>
        {historyOpen && <div className="memory-history-list">
          {historyError && <div className="memory-error" role="alert"><span>{historyError}</span><button type="button" className="btn btn-secondary btn-sm" onClick={() => setHistoryAttempt((attempt) => attempt + 1)}>Retry history</button></div>}
          {historyLoading && <p role="status">Loading revisions…</p>}
          {history?.truncated && <p className="memory-caption">Older revisions are outside the retained history window.</p>}
          {history?.revisions.map((revision) => <details key={revision.revision}>
            <summary>Revision {revision.revision} · {revision.provenance.harness} · {new Date(revision.updatedAt).toLocaleString()}{revision.archivedAt ? ' · archived' : ''}</summary>
            <strong>{revision.title}</strong><pre>{revision.content}</pre>
            {revision.provenance.sourceRef && <p className="memory-caption">Source: {revision.provenance.sourceRef}</p>}
          </details>)}
        </div>}
      </section>}
      <footer className="modal-footer memory-editor-footer">
        {erasing ? <>
          <span>Erase this entry and its retained revision contents? Archive remains reversible; erasure does not. Older backups and exports keep their copies. This removes local authoritative memory only; external engine cleanup is not yet integrated.</span>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setErasing(false)}>Keep entry</button>
          <button type="button" className="btn btn-danger btn-sm" disabled={busy || dirty} onClick={() => void eraseProjectMemoryEditor()}>Erase entry and history</button>
        </> : discarding ? <>
          <span>Discard unsaved memory changes?</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDiscarding(false)}>Keep editing</button>
          <button type="button" className="btn btn-danger btn-sm" onClick={() => useProjectMemoryEditor.setState({ editor: null, error: null })}>Discard changes</button>
        </> : <>
          {entry && <button type="button" className="btn btn-secondary btn-sm" disabled={busy || resolving || dirty} onClick={() => void archiveProjectMemoryEditor()}>{archived ? 'Restore entry' : 'Archive entry'}</button>}
          {entry && <button type="button" className="btn btn-danger btn-sm" disabled={busy || resolving || dirty} onClick={() => setErasing(true)}>Erase…</button>}
          <span className="memory-editor-status">{busy ? 'Saving…' : resolving ? 'Loading latest…' : dirty ? 'Unsaved draft' : entry ? 'Saved revision' : 'New entry'}</span>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy || resolving} onClick={close}>Close</button>
          {!archived && <button type="button" className="btn btn-primary btn-sm" disabled={busy || resolving || !draft.title.trim() || !draft.content.trim() || (!!entry && !dirty)} onClick={() => void saveProjectMemoryEditor()}>Save memory</button>}
        </>}
      </footer>
    </ModalDialog>
  )
}
