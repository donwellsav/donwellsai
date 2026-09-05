import { useEffect, useState } from 'react'
import { PROJECT_MEMORY_KINDS, PROJECT_MEMORY_MAX_CONTENT_LENGTH, PROJECT_MEMORY_MAX_TITLE_LENGTH } from '@shared/project-memory'
import type { ProjectMemoryHistoryResult } from '@shared/project-memory'
import { archiveProjectMemoryEditor, memoryDraftIsDirty, saveProjectMemoryEditor, useProjectMemoryEditor } from '../project-memory-editor'
import { pathBasename } from '../workspace-navigation'
import { ModalDialog } from './ModalDialog'
import './project-memory.css'

export function ProjectMemoryEditor() {
  const editor = useProjectMemoryEditor((state) => state.editor)
  const busy = useProjectMemoryEditor((state) => state.busy)
  const error = useProjectMemoryEditor((state) => state.error)
  const change = useProjectMemoryEditor((state) => state.change)
  const [discarding, setDiscarding] = useState(false)
  const [history, setHistory] = useState<ProjectMemoryHistoryResult | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const entryId = editor?.entry?.id
  const workspacePath = editor?.workspacePath

  useEffect(() => { setDiscarding(false); setHistoryOpen(false); setHistory(null); setHistoryError(null) }, [entryId, workspacePath])
  useEffect(() => {
    if (!historyOpen || !entryId || !workspacePath) return
    let cancelled = false
    void window.donwells.projectMemoryHistory({ workspacePath, id: entryId }).then((result) => {
      if (!cancelled) setHistory(result)
    }, (cause) => { if (!cancelled) setHistoryError(String(cause)) })
    return () => { cancelled = true }
  }, [historyOpen, entryId, workspacePath])

  if (!editor) return null
  const { draft, entry } = editor
  const dirty = memoryDraftIsDirty(editor)
  const archived = !!entry?.archivedAt
  const close = (): void => {
    if (busy) return
    if (dirty) setDiscarding(true)
    else useProjectMemoryEditor.setState({ editor: null, error: null })
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
        <label>Title<input className="input" autoFocus value={draft.title} maxLength={PROJECT_MEMORY_MAX_TITLE_LENGTH} disabled={busy || archived} onChange={(event) => change({ title: event.target.value })} placeholder="How this project builds and verifies changes" /></label>
        <div className="memory-field-pair">
          <label>Kind<select className="input" value={draft.kind} disabled={busy || archived} onChange={(event) => {
            const kind = PROJECT_MEMORY_KINDS.find((value) => value === event.target.value)
            if (kind) change({ kind })
          }}>{PROJECT_MEMORY_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></label>
          <label>Tags<input className="input" value={draft.tags} disabled={busy || archived} onChange={(event) => change({ tags: event.target.value })} placeholder="build, testing, typescript" /></label>
        </div>
        <label>Knowledge<textarea className="input memory-content-input" value={draft.content} maxLength={PROJECT_MEMORY_MAX_CONTENT_LENGTH} disabled={busy || archived} onChange={(event) => change({ content: event.target.value })} placeholder="What should another coding harness know, and why? Include concrete commands, constraints, or evidence." /></label>
        <label>Source reference <span className="memory-caption">optional</span><input className="input" value={draft.sourceRef} disabled={busy || archived} onChange={(event) => change({ sourceRef: event.target.value })} placeholder="package.json, a source path, commit, or issue URL" /></label>
      </div>
      {entry && <p className="memory-provenance">Last attributed to <strong>{entry.provenance.harness}</strong> · {new Date(entry.updatedAt).toLocaleString()}{entry.provenance.sourceSession ? ` · Session ${entry.provenance.sourceSession}` : ''}. Harness attribution is self-reported.</p>}
      {error && <div className="memory-error" role="alert">{error}<p>Your draft is retained. Compare revision history before resolving a conflicting change.</p></div>}
      {entry && <section className="memory-history">
        <button className="btn btn-secondary btn-sm" aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>Revision history</button>
        {historyOpen && <div className="memory-history-list">
          {historyError && <p role="alert">{historyError}</p>}
          {!history && !historyError && <p role="status">Loading revisions…</p>}
          {history?.truncated && <p className="memory-caption">Older revisions are outside the retained history window.</p>}
          {history?.revisions.map((revision) => <details key={revision.revision}>
            <summary>Revision {revision.revision} · {revision.provenance.harness} · {new Date(revision.updatedAt).toLocaleString()}{revision.archivedAt ? ' · archived' : ''}</summary>
            <strong>{revision.title}</strong><pre>{revision.content}</pre>
            {revision.provenance.sourceRef && <p className="memory-caption">Source: {revision.provenance.sourceRef}</p>}
          </details>)}
        </div>}
      </section>}
      <footer className="modal-footer memory-editor-footer">
        {discarding ? <>
          <span>Discard unsaved memory changes?</span>
          <button className="btn btn-secondary btn-sm" onClick={() => setDiscarding(false)}>Keep editing</button>
          <button className="btn btn-danger btn-sm" onClick={() => useProjectMemoryEditor.setState({ editor: null, error: null })}>Discard changes</button>
        </> : <>
          {entry && <button className="btn btn-secondary btn-sm" disabled={busy || dirty} onClick={() => void archiveProjectMemoryEditor()}>{archived ? 'Restore entry' : 'Archive entry'}</button>}
          <span className="memory-editor-status">{busy ? 'Saving…' : dirty ? 'Unsaved draft' : entry ? 'Saved revision' : 'New entry'}</span>
          <button className="btn btn-secondary btn-sm" disabled={busy} onClick={close}>Close</button>
          {!archived && <button className="btn btn-primary btn-sm" disabled={busy || !draft.title.trim() || !draft.content.trim() || (!!entry && !dirty)} onClick={() => void saveProjectMemoryEditor()}>Save memory</button>}
        </>}
      </footer>
    </ModalDialog>
  )
}
