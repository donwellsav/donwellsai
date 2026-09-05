import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  DIFF_REVIEW_BODY_MAX_LENGTH,
  DIFF_REVIEW_RANGE_MAX_LINES,
  diffReviewNoteIsCurrent,
  type DiffReviewNote,
  type DiffReviewSelection,
  type DiffReviewSnapshotIdentity,
  type DiffReviewSide
} from '@shared/diff-review'
import { lineCountForReviewSide } from '../diff-review'

function reviewRangeLabel(selection: DiffReviewSelection): string {
  return selection.startLine === selection.endLine
    ? `${selection.side} line ${selection.startLine}`
    : `${selection.side} lines ${selection.startLine}–${selection.endLine}`
}

function NoteEditor({
  label,
  initialValue,
  saving,
  onSave,
  onCancel
}: {
  label: string
  initialValue: string
  saving: boolean
  onSave(body: string): Promise<boolean>
  onCancel(): void
}) {
  const [body, setBody] = useState(initialValue)
  const [error, setError] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
    textareaRef.current?.setSelectionRange(initialValue.length, initialValue.length)
  }, [initialValue])

  const save = async (): Promise<void> => {
    if (!body.trim()) {
      setError('Write a note before saving.')
      return
    }
    setError('')
    if (await onSave(body)) onCancel()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
      return
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void save()
    }
  }

  return (
    <div className="diff-review-editor">
      <label>
        <span>{label}</span>
        <textarea
          ref={textareaRef}
          value={body}
          maxLength={DIFF_REVIEW_BODY_MAX_LENGTH}
          rows={5}
          placeholder="Explain the issue, expected behavior, or requested change…"
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={saving}
        />
      </label>
      <div className="diff-review-editor-foot">
        <span className={error ? 'diff-review-field-error' : 'diff-review-key-hint'} role={error ? 'alert' : undefined}>
          {error || '⌘↵ save · Esc cancel'}
        </span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void save()} disabled={saving || !body.trim()}>
          {saving ? 'Saving…' : 'Save note'}
        </button>
      </div>
    </div>
  )
}

function StoredContext({ note }: { note: DiffReviewNote }) {
  return (
    <details className="diff-review-context">
      <summary>Stored context</summary>
      <pre>
        {note.anchor.context.map((line) => {
          const selected = line.lineNumber >= note.anchor.startLine && line.lineNumber <= note.anchor.endLine
          const text = line.text.replace(/(?:\r\n|\r|\n)$/, '')
          return (
            <span className={selected ? 'is-selected' : undefined} key={line.lineNumber}>
              <b aria-hidden="true">{selected ? '›' : ' '}</b>
              <i>{line.lineNumber}</i>
              <code>{text || ' '}</code>
              {'\n'}
            </span>
          )
        })}
      </pre>
    </details>
  )
}

export function DiffReviewPanel({
  id,
  snapshot,
  selection,
  notes,
  loading,
  saving,
  error,
  editingNoteId,
  onSelectionChange,
  onCreate,
  onUpdate,
  onDelete,
  onJump,
  onEditingNoteChange,
  onAttach,
  onClose
}: {
  id: string
  snapshot: DiffReviewSnapshotIdentity
  selection: DiffReviewSelection | null
  notes: readonly DiffReviewNote[]
  loading: boolean
  saving: boolean
  error: string
  editingNoteId: string | null
  onSelectionChange(selection: DiffReviewSelection): void
  onCreate(body: string): Promise<boolean>
  onUpdate(note: DiffReviewNote, body: string): Promise<boolean>
  onDelete(note: DiffReviewNote): Promise<boolean>
  onJump(note: DiffReviewNote): void
  onEditingNoteChange(noteId: string | null): void
  onAttach(): void
  onClose(): void
}) {
  const rangeTitleId = `${id}-range-title`
  const beforeLines = lineCountForReviewSide(snapshot, 'before')
  const afterLines = lineCountForReviewSide(snapshot, 'after')
  const [manualSide, setManualSide] = useState<DiffReviewSide>(afterLines > 0 ? 'after' : 'before')
  const [manualStart, setManualStart] = useState('1')
  const [manualEnd, setManualEnd] = useState('1')
  const [rangeError, setRangeError] = useState('')
  const [creating, setCreating] = useState(false)
  const [deleteNoteId, setDeleteNoteId] = useState<string | null>(null)

  useEffect(() => {
    if (!selection) return
    setManualSide(selection.side)
    setManualStart(String(selection.startLine))
    setManualEnd(String(selection.endLine))
  }, [selection])

  useEffect(() => {
    if (manualSide === 'after' && afterLines === 0 && beforeLines > 0) setManualSide('before')
    if (manualSide === 'before' && beforeLines === 0 && afterLines > 0) setManualSide('after')
  }, [afterLines, beforeLines, manualSide])

  const applyManualRange = (): void => {
    const startLine = Number(manualStart)
    const endLine = Number(manualEnd)
    const available = manualSide === 'before' ? beforeLines : afterLines
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
      setRangeError('Enter a valid ascending line range.')
      return
    }
    if (endLine - startLine + 1 > DIFF_REVIEW_RANGE_MAX_LINES) {
      setRangeError(`A review range can span at most ${DIFF_REVIEW_RANGE_MAX_LINES} lines.`)
      return
    }
    if (endLine > available) {
      setRangeError(`The ${manualSide} snapshot has ${available} reviewable line${available === 1 ? '' : 's'}.`)
      return
    }
    setRangeError('')
    onSelectionChange({ side: manualSide, startLine, endLine })
  }

  const currentCount = notes.filter((note) => diffReviewNoteIsCurrent(note, snapshot)).length
  const staleCount = notes.length - currentCount

  return (
    <aside id={id} className="diff-review-panel" aria-label="Diff review notes">
      <header className="diff-review-panel-head">
        <div>
          <span className="diff-review-eyebrow">Review workspace</span>
          <h2>Notes <span aria-label={`${notes.length} notes`}>{notes.length}</span></h2>
        </div>
        <button type="button" className="icon-btn" aria-label="Close review notes" title="Close review notes" onClick={onClose}>×</button>
      </header>

      <section className="diff-review-range" aria-labelledby={rangeTitleId}>
        <div className="diff-review-section-head">
          <h3 id={rangeTitleId}>Line range</h3>
          {selection && <span className="diff-review-selection-chip">{reviewRangeLabel(selection)}</span>}
        </div>
        {beforeLines === 0 && afterLines === 0 ? (
          <p className="diff-review-muted">This comparison has no reviewable lines. Empty and absent snapshots do not create synthetic anchors.</p>
        ) : (
          <fieldset>
            <legend className="sr-only">Choose a snapshot side and exact line range</legend>
            <label>
              <span>Side</span>
              <select value={manualSide} onChange={(event) => {
                const side = event.target.value
                if (side === 'before' || side === 'after') setManualSide(side)
              }}>
                <option value="after" disabled={afterLines === 0}>After ({afterLines})</option>
                <option value="before" disabled={beforeLines === 0}>Before ({beforeLines})</option>
              </select>
            </label>
            <label>
              <span>Start</span>
              <input type="number" min={1} max={manualSide === 'before' ? beforeLines : afterLines} inputMode="numeric" value={manualStart} onChange={(event) => setManualStart(event.target.value)} />
            </label>
            <label>
              <span>End</span>
              <input type="number" min={1} max={manualSide === 'before' ? beforeLines : afterLines} inputMode="numeric" value={manualEnd} onChange={(event) => setManualEnd(event.target.value)} />
            </label>
            <button type="button" className="btn btn-secondary btn-sm" onClick={applyManualRange}>Select</button>
          </fieldset>
        )}
        {rangeError && <p className="diff-review-field-error" role="alert">{rangeError}</p>}
        <p className="diff-review-muted">Drag line numbers in the diff, or enter a range for keyboard-only review.</p>
        {creating ? (
          <NoteEditor
            label={selection ? `New note on ${reviewRangeLabel(selection)}` : 'New note'}
            initialValue=""
            saving={saving}
            onSave={onCreate}
            onCancel={() => setCreating(false)}
          />
        ) : (
          <button
            type="button"
            className="btn btn-primary diff-review-new-note"
            disabled={!selection || saving}
            onClick={() => setCreating(true)}
          >
            Add note to selection
          </button>
        )}
      </section>

      <div className="diff-review-list-head">
        <span>{currentCount} current</span>
        {staleCount > 0 && <span>{staleCount} stale</span>}
        <span className="diff-spacer" />
        <button type="button" className="btn btn-secondary btn-sm" disabled={notes.length === 0 || saving} onClick={onAttach}>
          Attach to agent…
        </button>
      </div>

      <div className="diff-review-list" aria-busy={loading} aria-live="polite">
        {error && <div className="diff-review-error" role="alert">{error}</div>}
        {loading ? (
          <p className="diff-review-muted">Loading review notes…</p>
        ) : notes.length === 0 ? (
          <div className="diff-review-empty">
            <strong>No notes yet</strong>
            <span>Select an exact line or range to begin a durable review.</span>
          </div>
        ) : (
          <ol>
            {notes.map((note, index) => {
              const current = diffReviewNoteIsCurrent(note, snapshot)
              const editing = editingNoteId === note.id
              const confirmingDelete = deleteNoteId === note.id
              return (
                <li key={note.id}>
                  <article className={`diff-review-note${current ? '' : ' is-stale'}`}>
                    <header>
                      <span className="diff-review-note-index">{String(index + 1).padStart(2, '0')}</span>
                      <span className="diff-review-line-label">{reviewRangeLabel(note.anchor)}</span>
                      <span className={`diff-review-state${current ? '' : ' is-stale'}`}>{current ? 'Current' : 'Stale'}</span>
                    </header>
                    {current ? null : (
                      <p className="diff-review-stale-copy">Snapshot changed. This note stays on its original context and is never silently reanchored.</p>
                    )}
                    {editing ? (
                      <NoteEditor
                        label={`Edit note ${index + 1}`}
                        initialValue={note.body}
                        saving={saving}
                        onSave={(body) => onUpdate(note, body)}
                        onCancel={() => onEditingNoteChange(null)}
                      />
                    ) : (
                      <p className="diff-review-note-body">{note.body}</p>
                    )}
                    <StoredContext note={note} />
                    {!editing && (
                      <footer>
                        <button type="button" disabled={!current} title={current ? 'Jump to the anchored range' : 'The original range is not applied to changed content'} onClick={() => onJump(note)}>
                          {current ? 'Jump' : 'Original context'}
                        </button>
                        <button type="button" onClick={() => onEditingNoteChange(note.id)}>Edit</button>
                        {confirmingDelete ? (
                          <span className="diff-review-delete-confirm" role="group" aria-label="Confirm note deletion">
                            <span>Delete permanently?</span>
                            <button type="button" onClick={() => setDeleteNoteId(null)}>Cancel</button>
                            <button
                              type="button"
                              className="is-destructive"
                              disabled={saving}
                              onClick={() => void onDelete(note).then((removed) => { if (removed) setDeleteNoteId(null) })}
                            >Delete</button>
                          </span>
                        ) : (
                          <button type="button" className="is-destructive" onClick={() => setDeleteNoteId(note.id)}>Delete</button>
                        )}
                      </footer>
                    )}
                  </article>
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </aside>
  )
}
