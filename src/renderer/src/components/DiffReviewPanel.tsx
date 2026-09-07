import { runWithEditorGuard } from '../editor-models'
import type { VerificationEntry } from '@shared/operational-runs'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  DIFF_REVIEW_BODY_MAX_LENGTH,
  DIFF_REVIEW_RANGE_MAX_LINES,
  diffReviewNoteIsCurrent,
  type DiffReviewRunLink,
  type DiffReviewRunState,
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
          className="input"
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
        <span className="diff-review-editor-count">{body.length.toLocaleString()} / {DIFF_REVIEW_BODY_MAX_LENGTH.toLocaleString()}</span>
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

function VerificationPanel({workspacePath,sourceVersion,onSelect,onSourcesChecked}:{workspacePath:string;sourceVersion:string;onSelect:(entry:VerificationEntry)=>void;onSourcesChecked:()=>void}) {
  const [entries,setEntries]=useState<VerificationEntry[]>([]),[scripts,setScripts]=useState<string[]>([]),[script,setScript]=useState(''),[refresh,setRefresh]=useState(0),[checking,setChecking]=useState(false),[acting,setActing]=useState(false),[error,setError]=useState(''),[artifact,setArtifact]=useState('')
  const [command,setCommand]=useState(''),[outputs,setOutputs]=useState('')
  const runOptions=()=>({outputs:outputs.split('\n').map(path=>path.trim()).filter(Boolean)})
  const checkArtifacts=useRef(false),alive=useRef(true)
  useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
  useEffect(()=>{
    let live=true;setChecking(true)
    const verify=checkArtifacts.current;checkArtifacts.current=false
    void Promise.all([window.donwells.verificationList(workspacePath,verify),window.donwells.verificationScripts(workspacePath).catch(():string[]=>[])]).then(([entries,scripts])=>{if(live){setEntries(entries);setScripts(scripts);setScript(current=>scripts.includes(current)?current:scripts[0]??'');setError('');onSourcesChecked()}}).catch(error=>{if(live)setError(String(error))}).finally(()=>{if(live)setChecking(false)})
    return()=>{live=false}
  },[workspacePath,sourceVersion,refresh,onSourcesChecked])
  useEffect(()=>window.donwells.on('worktree:changed',()=>{setEntries(entries=>entries.map(entry=>({...entry,sourceState:'unverified'})));setRefresh(value=>value+1)}),[workspacePath])
  const running=entries.some(entry=>entry.sourceState==='running')
  useEffect(()=>{if(!running)return;const timer=setInterval(()=>setRefresh(value=>value+1),2000);return()=>clearInterval(timer)},[running])
  const act=async(action:()=>Promise<unknown>)=>{setActing(true);try{await action();if(alive.current)setRefresh(value=>value+1)}catch(error){if(alive.current)setError(String(error))}finally{if(alive.current)setActing(false)}}
  return <section className="diff-review-range" aria-label="Verification evidence">
    <div className="diff-review-section-head"><h3>Verification</h3><button className="btn btn-secondary btn-sm" disabled={checking||acting} onClick={()=>{checkArtifacts.current=true;setRefresh(value=>value+1)}}>Recheck evidence</button></div>
    <details><summary>Run verification</summary>
    <div style={{display:'flex',gap:6,flexWrap:'wrap'}}><select className="input" aria-label="Project verification script" value={script} onChange={event=>setScript(event.target.value)} disabled={acting||!scripts.length}>{scripts.map(script=><option key={script}>{script}</option>)}</select><button className="btn btn-secondary btn-sm" disabled={acting||!script} onClick={()=>void act(()=>runWithEditorGuard(workspacePath,undefined,()=>window.donwells.verificationRun(workspacePath,script,runOptions())))}>Run script</button></div>
    <label>Expected output files (one checkout-relative path per line)<textarea className="input" value={outputs} onChange={event=>setOutputs(event.target.value)} placeholder="dist/index.html"/></label>
    <label>Explicit project command<input className="input" value={command} maxLength={16000} onChange={event=>setCommand(event.target.value)} placeholder="For projects without package scripts"/></label>
    <button className="btn btn-secondary btn-sm" disabled={acting||!command.trim()} onClick={()=>void act(()=>runWithEditorGuard(workspacePath,undefined,()=>window.donwells.parallelRunStart({name:'Review command',command:command.trim(),targets:[{kind:'local',root:workspacePath,label:workspacePath.split('/').at(-1)||workspacePath}],concurrency:1},runOptions())))}>Run command in this checkout</button>
    </details>
    {checking&&<p role="status">Checking source…</p>}{error&&<p role="alert">{error}</p>}
    {!entries.length&&!checking&&<p>No recorded verification runs for this checkout.</p>}
    {entries.map(entry=><details key={entry.task.id} className="diff-review-context">
      <summary>Command {entry.task.status} · source {checking?'checking':entry.sourceState}</summary>
      <button className="btn btn-secondary btn-sm" disabled={!entry.task.verification?.before} onClick={()=>onSelect(entry)}>Use this run for the next review note</button>
      {entry.task.verification?.origin && <p title={entry.task.verification.origin.kind==='agent'?entry.task.verification.origin.sessionId:undefined}>Origin: {entry.task.verification.origin.kind==='agent'?`${entry.task.verification.origin.mode} agent`:'unattributed local request'}</p>}
      {entry.task.verification?.outputs?.map(output=><p key={output.path} title={output.path}>{output.path.startsWith(workspacePath+'/')?output.path.slice(workspacePath.length+1):output.path.split('/').at(-1)} · {output.state}{output.problem ? ' · '+output.problem : ''}</p>)}
      <p>Exit {entry.task.exitCode??'unknown'} · {entry.task.finishedAt??entry.task.startedAt??'not started'}</p>
      <details><summary>Command and source details</summary><p>{entry.task.command}</p><p>Checkout: {entry.task.target.root}</p>
      {entry.task.verification?.problem&&<p>{entry.task.verification.problem}</p>}
      <pre>{JSON.stringify({before:entry.task.verification?.before,after:entry.task.verification?.after,tools:entry.task.verification?.toolVersions,environment:entry.task.verification?.environment},null,2)}</pre></details>
      {entry.sourceState==='running'&&<button className="btn btn-secondary btn-sm" onClick={()=>void act(()=>window.donwells.parallelRunCancel(entry.runId))}>Stop verification</button>}
      <details><summary>Command output</summary><pre>{entry.task.output||entry.task.error||'No command output recorded.'}</pre></details>
      <label>Artifact path<input className="input" value={artifact} onChange={event=>setArtifact(event.target.value)} placeholder="Absolute build output or browser trace path"/></label>
      <button className="btn btn-secondary btn-sm" disabled={acting||!artifact.trim()} onClick={()=>void act(()=>window.donwells.verificationAttach(workspacePath,entry.runId,entry.task.id,artifact.trim()))}>Attach reference</button>
      {entry.artifacts.map(file=><div key={file.path}><p title={file.path}>{file.path.startsWith(workspacePath+'/')?file.path.slice(workspacePath.length+1):file.path.split('/').at(-1)} · {file.state==='unchecked'?'bytes not rechecked':file.state}</p><details><summary>Artifact identity · {file.bytes} bytes</summary><p>{file.path}</p><code style={{overflowWrap:"anywhere"}}>{file.sha256}</code></details><p> {file.relationship==='observed-during-run'?'new or changed during this run; concurrent writers are not excluded':'attached reference; producer not verified'}</p><button className="btn btn-secondary btn-sm" disabled={acting} onClick={()=>void act(()=>window.donwells.verificationOpen(workspacePath,entry.runId,entry.task.id,file.path))}>Recheck and open artifact</button></div>)}
    </details>)}
  </section>
}

export function DiffReviewPanel({
  workspacePath,
  onSourcesChecked,
  id,
  snapshot,
  selection,
  notes,
  runStates,
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
  onRetry,
  onClose
}: {
  workspacePath: string
  onSourcesChecked(): void
  id: string
  snapshot: DiffReviewSnapshotIdentity
  selection: DiffReviewSelection | null
  notes: readonly DiffReviewNote[]
  runStates: Record<string, DiffReviewRunState | null>
  loading: boolean
  saving: boolean
  error: string
  editingNoteId: string | null
  onSelectionChange(selection: DiffReviewSelection): void
  onCreate(body: string, runLink?: Pick<DiffReviewRunLink, 'runId' | 'taskId'>): Promise<boolean>
  onUpdate(note: DiffReviewNote, body: string): Promise<boolean>
  onDelete(note: DiffReviewNote): Promise<boolean>
  onJump(note: DiffReviewNote): void
  onEditingNoteChange(noteId: string | null): void
  onAttach(): void
  onRetry(): void
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

  const [selectedRun, setSelectedRun] = useState<(Pick<DiffReviewRunLink, 'runId' | 'taskId'> & {label:string}) | undefined>()
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

      <VerificationPanel key={workspacePath} onSourcesChecked={onSourcesChecked} workspacePath={workspacePath} sourceVersion={JSON.stringify(snapshot)} onSelect={entry=>setSelectedRun({runId:entry.runId,taskId:entry.task.id,label:entry.task.command})} />
      {selectedRun && <p className="diff-review-run-link" title={`Run ${selectedRun.runId} / task ${selectedRun.taskId}`}>Next note: {selectedRun.label.length>64?selectedRun.label.slice(0,61)+'…':selectedRun.label} <button className="btn btn-secondary btn-sm" onClick={()=>setSelectedRun(undefined)}>Clear link</button></p>}
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
              <select className="input" value={manualSide} onChange={(event) => {
                const side = event.target.value
                if (side === 'before' || side === 'after') setManualSide(side)
              }}>
                <option value="after" disabled={afterLines === 0}>After ({afterLines})</option>
                <option value="before" disabled={beforeLines === 0}>Before ({beforeLines})</option>
              </select>
            </label>
            <label>
              <span>Start</span>
              <input className="input" type="number" min={1} max={manualSide === 'before' ? beforeLines : afterLines} inputMode="numeric" value={manualStart} onChange={(event) => setManualStart(event.target.value)} />
            </label>
            <label>
              <span>End</span>
              <input className="input" type="number" min={1} max={manualSide === 'before' ? beforeLines : afterLines} inputMode="numeric" value={manualEnd} onChange={(event) => setManualEnd(event.target.value)} />
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
            onSave={body=>onCreate(body,selectedRun?{runId:selectedRun.runId,taskId:selectedRun.taskId}:undefined)}
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
        {error ? (
          <div className="diff-review-error" role="alert">
            <strong>Review notes unavailable</strong>
            <span>{error}</span>
            <button type="button" className="btn btn-secondary btn-sm" disabled={loading} onClick={onRetry}>Retry</button>
          </div>
        ) : loading && notes.length === 0 ? (
          <p className="diff-review-muted" role="status">Loading review notes…</p>
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
                    {note.runLink && <p className="diff-review-muted" title={`Run ${note.runLink.runId} / task ${note.runLink.taskId} / source ${note.runLink.sourceFingerprint}`}>Linked run {note.runLink.runId.slice(0,8)}: {runStates[note.id] ? `${runStates[note.id]!.status} · exit ${runStates[note.id]!.exitCode ?? 'unknown'} · source ${runStates[note.id]!.sourceState}` : 'run unavailable or source receipt changed'}. Original source {note.runLink.sourceFingerprint.slice(0,12)}.</p>}
                    <StoredContext note={note} />
                    {!editing && (
                      <footer>
                        <button type="button" className="btn btn-ghost btn-sm" disabled={!current} title={current ? 'Jump to the anchored range' : 'The original range is not applied to changed content'} onClick={() => onJump(note)}>
                          {current ? 'Jump' : 'Original context'}
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onEditingNoteChange(note.id)}>Edit</button>
                        {confirmingDelete ? (
                          <span className="diff-review-delete-confirm" role="group" aria-label="Confirm note deletion">
                            <span>Delete permanently?</span>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDeleteNoteId(null)}>Cancel</button>
                            <button
                              type="button"
                              className="btn btn-danger btn-sm"
                              disabled={saving}
                              onClick={() => void onDelete(note).then((removed) => { if (removed) setDeleteNoteId(null) })}
                            >Delete</button>
                          </span>
                        ) : (
                          <button type="button" className="btn btn-ghost btn-sm is-destructive" onClick={() => setDeleteNoteId(note.id)}>Delete</button>
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
