import {
  parseDiffFromFile,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type FileDiffOptions,
  type SelectedLineRange
} from '@pierre/diffs'
import { FileDiff } from '@pierre/diffs/react'
import {
  createDiffReviewAnchor,
  createDiffReviewSnapshot,
  diffReviewNoteIsCurrent,
  formatDiffReviewAttachment,
  type DiffReviewNote,
  type DiffReviewSelection,
  type DiffReviewSnapshotIdentity,
  type DiffReviewTarget
} from '@shared/diff-review'
import { effectiveDiffFontFamily, effectiveDiffFontSize } from '@shared/settings'
import type { AgentAttachmentDraft } from '@shared/agent-delivery'
import type { DiffComparison, GitStatusEntry } from '@shared/types'
import {
  diffSourcePaths,
  pierreSelectionFromReview,
  reviewSelectionFromPierre,
  resolvedDiffTheme,
  reviewSideFromPierre,
  type DiffSources
} from '../diff-review'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useAppStore } from '../store'
import { AgentDeliveryDialog } from './AgentDeliveryDialog'
import { DiffReviewAnnotation } from './DiffReviewAnnotation'
import { DiffReviewPanel } from './DiffReviewPanel'
import { Icon } from './Icon'
import './diff-review.css'

type DiffStatus = 'loading' | 'ready' | 'error'
type ReviewAnnotationMetadata = { noteId: string }
type DiffStyle = CSSProperties & {
  '--diffs-font-family': string
  '--diffs-font-size': string
}
type LoadedDiff = {
  metadata: FileDiffMetadata | null
  sources: DiffSources
  snapshot: DiffReviewSnapshotIdentity
}

function comparisonLabel(comparison: DiffComparison): string {
  if (comparison === 'staged') return 'HEAD ↔ index'
  if (comparison === 'unstaged') return 'index ↔ working tree'
  return 'HEAD ↔ working tree'
}

function changeLabel(metadata: FileDiffMetadata | null): string {
  if (!metadata) return 'no object at either side'
  if (metadata.type === 'new') return 'new file'
  if (metadata.type === 'deleted') return 'deleted file'
  if (metadata.type === 'rename-pure') return 'renamed without content changes'
  if (metadata.type === 'rename-changed') return 'renamed and modified'
  return 'modified'
}

function blankDiffMessage(loaded: LoadedDiff): { title: string; detail: string } | null {
  const { metadata, sources } = loaded
  if (!metadata) {
    return {
      title: 'No object at either side',
      detail: 'Neither snapshot contains this path. No synthetic lines were created.'
    }
  }
  if (metadata.hunks.length > 0) return null
  if (metadata.type === 'new') {
    return { title: 'New empty file', detail: 'The after snapshot exists but contains no reviewable lines.' }
  }
  if (metadata.type === 'deleted') {
    return { title: 'Deleted empty file', detail: 'The before snapshot exists but contains no reviewable lines.' }
  }
  if (metadata.type === 'rename-pure') {
    return { title: 'Rename only', detail: `${sources.before.path} → ${sources.after.path} has identical content.` }
  }
  return { title: 'No content changes', detail: 'The selected snapshots have identical content.' }
}

function sortNotes(notes: DiffReviewNote[]): DiffReviewNote[] {
  notes.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  return notes
}

/** Durable, snapshot-bound review surface for working, staged, and unstaged comparisons. */
export function DiffPane({
  worktreePath,
  relPath,
  comparison = 'working'
}: {
  worktreePath: string
  relPath: string
  comparison?: DiffComparison
}) {
  const settings = useAppStore((state) => state.settings)
  const openPreview = useAppStore((state) => state.openPreview)
  const hidePaneView = useAppStore((state) => state.hidePaneView)
  const reviewPanelId = useId()
  const [loaded, setLoaded] = useState<LoadedDiff | null>(null)
  const [status, setStatus] = useState<DiffStatus>('loading')
  const [errorMessage, setErrorMessage] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [sideBySide, setSideBySide] = useState(settings.diffViewStyle === 'split')
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const [selection, setSelection] = useState<DiffReviewSelection | null>(null)
  const [notes, setNotes] = useState<DiffReviewNote[]>([])
  const [reviewTarget, setReviewTarget] = useState<DiffReviewTarget | null>(null)
  const [reviewLoading, setReviewLoading] = useState(true)
  const [reviewSaving, setReviewSaving] = useState(false)
  const [reviewError, setReviewError] = useState('')
  const [reviewOpen, setReviewOpen] = useState(false)
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [attachment, setAttachment] = useState<AgentAttachmentDraft | null>(null)
  const diffHostRef = useRef<HTMLDivElement>(null)

  useEffect(() => setSideBySide(settings.diffViewStyle === 'split'), [settings.diffViewStyle])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = (): void => setSystemPrefersDark(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    let current = true
    setLoaded(null)
    setStatus('loading')
    setErrorMessage('')
    setSelection(null)
    setNotes([])
    setReviewTarget(null)
    setReviewError('')
    setReviewLoading(true)
    setEditingNoteId(null)

    void window.donwells.diffReviewList({ workspacePath: worktreePath, filePath: relPath, comparison })
      .then((result) => {
        if (!current) return
        setReviewTarget(result.target)
        setNotes(sortNotes(result.notes.slice()))
      })
      .catch((error: unknown) => {
        if (current) setReviewError(`Review notes are unavailable: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        if (current) setReviewLoading(false)
      })

    void (async () => {
      try {
        const worktreeStatus = await window.donwells.gitStatus(worktreePath)
        const entry: GitStatusEntry | undefined = worktreeStatus.entries?.find((candidate) => candidate.path === relPath)
        const { beforePath, afterPath } = diffSourcePaths(relPath, comparison, entry)
        const readDisk = async (): Promise<string | null> => {
          try {
            return (await window.donwells.readFile(worktreePath, afterPath)).content
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (message.includes(`No such file: ${afterPath}`)) return null
            throw error
          }
        }

        let beforeContents: string | null
        let afterContents: string | null
        if (comparison === 'staged') {
          const [head, index] = await Promise.all([
            window.donwells.readFileAtRef(worktreePath, beforePath, 'HEAD'),
            window.donwells.readFileAtRef(worktreePath, afterPath, '')
          ])
          beforeContents = head.content
          afterContents = index.content
        } else if (comparison === 'unstaged') {
          const [index, disk] = await Promise.all([
            window.donwells.readFileAtRef(worktreePath, beforePath, ''),
            readDisk()
          ])
          beforeContents = index.content
          afterContents = disk
        } else {
          const [head, disk] = await Promise.all([
            window.donwells.readFileAtRef(worktreePath, beforePath, 'HEAD'),
            readDisk()
          ])
          beforeContents = head.content
          afterContents = disk
        }

        const sources: DiffSources = {
          before: { path: beforePath, contents: beforeContents },
          after: { path: afterPath, contents: afterContents }
        }
        const snapshot = await createDiffReviewSnapshot(sources.before, sources.after)
        const oldFile = beforeContents === null ? null : { name: beforePath, contents: beforeContents }
        const newFile = afterContents === null ? null : { name: afterPath, contents: afterContents }
        const metadata = oldFile === null && newFile === null
          ? null
          : parseDiffFromFile(oldFile, newFile, undefined, true)
        if (!current) return
        setLoaded({ metadata, sources, snapshot })
        setStatus('ready')
      } catch (error) {
        if (!current) return
        setErrorMessage(error instanceof Error ? error.message : String(error))
        setStatus('error')
      }
    })()

    return () => {
      current = false
    }
  }, [worktreePath, relPath, comparison, refresh])

  const statistics = useMemo(() => {
    if (!loaded?.metadata) return null
    let additions = 0
    let deletions = 0
    for (const hunk of loaded.metadata.hunks) {
      for (const content of hunk.hunkContent) {
        if (content.type !== 'change') continue
        additions += content.additions
        deletions += content.deletions
      }
    }
    return { additions, deletions, hunks: loaded.metadata.hunks.length }
  }, [loaded])

  const selectRange = useCallback((next: DiffReviewSelection): void => {
    setSelection(next)
    setReviewError('')
    setReviewOpen(true)
  }, [])

  const handlePierreSelection = useCallback((range: SelectedLineRange | null): void => {
    if (!range) {
      setSelection(null)
      return
    }
    if (!loaded) return
    try {
      selectRange(reviewSelectionFromPierre(range, loaded.snapshot))
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : String(error))
    }
  }, [loaded, selectRange])

  const createNote = useCallback(async (body: string): Promise<boolean> => {
    if (!loaded || !selection) return false
    if (!reviewTarget) {
      setReviewError('The registered review workspace is unavailable. Refresh this comparison and try again.')
      return false
    }
    const contents = loaded.sources[selection.side].contents
    if (contents === null) {
      setReviewError(`The ${selection.side} snapshot is absent and cannot receive a note.`)
      return false
    }
    setReviewSaving(true)
    setReviewError('')
    try {
      const note = await window.donwells.diffReviewCreate({
        ...reviewTarget,
        snapshot: loaded.snapshot,
        anchor: createDiffReviewAnchor(selection.side, selection.startLine, selection.endLine, contents),
        body
      })
      setNotes((current) => sortNotes([...current, note]))
      setSelection(null)
      return true
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setReviewSaving(false)
    }
  }, [loaded, reviewTarget, selection])

  const updateNote = useCallback(async (note: DiffReviewNote, body: string): Promise<boolean> => {
    setReviewSaving(true)
    setReviewError('')
    try {
      const updated = await window.donwells.diffReviewUpdate({
        workspacePath: note.target.workspacePath,
        id: note.id,
        expectedRevision: note.revision,
        body
      })
      setNotes((current) => sortNotes(current.map((candidate) => candidate.id === updated.id ? updated : candidate)))
      return true
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setReviewSaving(false)
    }
  }, [])

  const deleteNote = useCallback(async (note: DiffReviewNote): Promise<boolean> => {
    setReviewSaving(true)
    setReviewError('')
    try {
      await window.donwells.diffReviewDelete({
        workspacePath: note.target.workspacePath,
        id: note.id,
        expectedRevision: note.revision
      })
      setNotes((current) => current.filter((candidate) => candidate.id !== note.id))
      if (editingNoteId === note.id) setEditingNoteId(null)
      return true
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setReviewSaving(false)
    }
  }, [editingNoteId])

  const jumpToNote = useCallback((note: DiffReviewNote): void => {
    if (!loaded || !diffReviewNoteIsCurrent(note, loaded.snapshot)) return
    selectRange(note.anchor)
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const elements = diffHostRef.current?.querySelectorAll<HTMLElement>('[data-review-note-id]')
      const annotation = elements ? Array.from(elements).find((element) => element.dataset.reviewNoteId === note.id) : undefined
      annotation?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      annotation?.focus({ preventScroll: true })
    }))
  }, [loaded, selectRange])

  const editNote = useCallback((note: DiffReviewNote): void => {
    setEditingNoteId(note.id)
    setReviewOpen(true)
  }, [])

  const diffTheme = resolvedDiffTheme(settings.theme, systemPrefersDark)
  const diffStyle = useMemo<DiffStyle>(() => ({
    '--diffs-font-family': effectiveDiffFontFamily(settings),
    '--diffs-font-size': `${effectiveDiffFontSize(settings)}px`
  }), [settings])

  const options = useMemo<FileDiffOptions<ReviewAnnotationMetadata>>(() => ({
    theme: diffTheme === 'dark' ? 'github-dark' : 'github-light',
    themeType: diffTheme,
    diffStyle: sideBySide ? 'split' : 'unified',
    disableFileHeader: true,
    diffIndicators: 'classic',
    overflow: settings.diffWordWrap ? 'wrap' : 'scroll',
    lineDiffType: 'word',
    hunkSeparators: 'line-info',
    lineHoverHighlight: 'both',
    enableLineSelection: true,
    controlledSelection: true,
    enableGutterUtility: true,
    onLineSelected: handlePierreSelection,
    onLineNumberClick: ({ annotationSide, lineNumber }) => {
      if (!loaded) return
      try {
        selectRange(reviewSelectionFromPierre({
          start: lineNumber,
          end: lineNumber,
          side: annotationSide,
          endSide: annotationSide
        }, loaded.snapshot))
      } catch (error) {
        setReviewError(error instanceof Error ? error.message : String(error))
      }
    }
  }), [diffTheme, handlePierreSelection, loaded, selectRange, settings.diffWordWrap, sideBySide])

  const currentNotes = useMemo(() => {
    if (!loaded) return []
    return notes.filter((note) => diffReviewNoteIsCurrent(note, loaded.snapshot))
  }, [loaded, notes])
  const noteById = useMemo(() => new Map(currentNotes.map((note) => [note.id, note])), [currentNotes])
  const lineAnnotations = useMemo<DiffLineAnnotation<ReviewAnnotationMetadata>[]>(() => currentNotes.map((note) => ({
    side: note.anchor.side === 'before' ? 'deletions' : 'additions',
    lineNumber: note.anchor.endLine,
    metadata: { noteId: note.id }
  })), [currentNotes])
  const selectedLines = selection ? pierreSelectionFromReview(selection) : null

  const renderGutterUtility = useCallback((getHoveredLine: () => { lineNumber: number; side: 'deletions' | 'additions' } | undefined) => (
    <button
      type="button"
      className="diff-review-gutter-action"
      aria-label="Select hovered line for a review note"
      title="Select line for review"
      onClick={() => {
        const line = getHoveredLine()
        if (!line) return
        selectRange({ side: reviewSideFromPierre(line.side), startLine: line.lineNumber, endLine: line.lineNumber })
      }}
    >+</button>
  ), [selectRange])

  const renderAnnotation = useCallback((annotation: DiffLineAnnotation<ReviewAnnotationMetadata>) => {
    const note = noteById.get(annotation.metadata.noteId)
    return note ? <DiffReviewAnnotation note={note} onEdit={editNote} onJump={jumpToNote} /> : null
  }, [editNote, jumpToNote, noteById])

  const openAttachment = useCallback((): void => {
    if (!reviewTarget || !loaded || notes.length === 0) return
    try {
      setAttachment(formatDiffReviewAttachment(reviewTarget, loaded.snapshot, notes))
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : String(error))
    }
  }, [loaded, notes, reviewTarget])

  const name = relPath.split(/[\\/]/).at(-1) ?? relPath
  const subline = loaded ? `${comparisonLabel(comparison)} · ${changeLabel(loaded.metadata)}` : `${comparisonLabel(comparison)} · loading snapshots`
  const paneKey = comparison === 'working' ? `diff:${relPath}` : `diff:${comparison}:${relPath}`
  const blank = loaded ? blankDiffMessage(loaded) : null

  return (
    <div className="diff-review-pane">
      <header className="pane-header diff-review-head">
        <span className="diff-review-file-mark"><Icon name="git" size={12} /></span>
        <div className="diff-review-heading">
          <strong title={relPath}>{name}</strong>
          <span>{subline}</span>
        </div>
        {statistics && (
          <span className="diff-review-stat" aria-label={`${statistics.additions} additions, ${statistics.deletions} deletions, ${statistics.hunks} hunks`}>
            <span className="is-added">+{statistics.additions}</span>{' '}
            <span className="is-deleted">−{statistics.deletions}</span>{' '}
            · {statistics.hunks} {statistics.hunks === 1 ? 'hunk' : 'hunks'}
          </span>
        )}
        <div className="diff-review-head-actions">
          <button
            type="button"
            className="diff-review-panel-toggle"
            aria-expanded={reviewOpen}
            aria-controls={reviewPanelId}
            onClick={() => setReviewOpen((value) => !value)}
          >
            <span>Review notes</span><b>{notes.length}</b>
          </button>
          <button type="button" className="icon-btn" aria-label="Refresh comparison" title="Refresh comparison" onClick={() => setRefresh((value) => value + 1)}>
            <Icon name="refresh" size={12} />
          </button>
          <button
            type="button"
            className={`btn btn-secondary btn-sm diff-review-view-toggle${sideBySide ? ' active' : ''}`}
            aria-label={sideBySide ? 'Use unified diff view' : 'Use side-by-side diff view'}
            title={sideBySide ? 'Unified view' : 'Side-by-side view'}
            onClick={() => setSideBySide((value) => !value)}
          >
            <Icon name="columns" size={12} />
            <span>{sideBySide ? 'Unified' : 'Side by side'}</span>
          </button>
          {loaded?.sources.after.contents !== null && (
            <button type="button" className="btn btn-secondary btn-sm diff-review-editor-action" onClick={() => void openPreview(worktreePath, relPath)}>
              <Icon name="edit" size={12} />
              <span>Open file</span>
            </button>
          )}
          <button type="button" className="icon-btn" aria-label="Close diff" title="Close diff" onClick={() => void hidePaneView(worktreePath, paneKey)}>
            <Icon name="x" size={12} />
          </button>
        </div>
      </header>

      <div className="diff-review-layout">
        <div className="diff-review-diff-host" ref={diffHostRef} aria-busy={status === 'loading'}>
          {status === 'error' ? (
            <div className="diff-review-status" role="alert">
              <strong>Could not load this comparison</strong>
              <span>{errorMessage}</span>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRefresh((value) => value + 1)}>Retry</button>
            </div>
          ) : status === 'loading' || !loaded ? (
            <div className="diff-review-status" role="status"><span>Loading exact snapshots…</span></div>
          ) : blank ? (
            <div className="diff-review-status">
              <strong>{blank.title}</strong>
              <span>{blank.detail}</span>
            </div>
          ) : loaded.metadata ? (
            <FileDiff<ReviewAnnotationMetadata>
              fileDiff={loaded.metadata}
              disableWorkerPool
              options={options}
              style={diffStyle}
              selectedLines={selectedLines}
              lineAnnotations={lineAnnotations}
              renderAnnotation={renderAnnotation}
              renderGutterUtility={renderGutterUtility}
            />
          ) : null}
        </div>

        {reviewOpen && loaded && (
          <DiffReviewPanel
            id={reviewPanelId}
            snapshot={loaded.snapshot}
            selection={selection}
            notes={notes}
            loading={reviewLoading}
            saving={reviewSaving}
            error={reviewError}
            editingNoteId={editingNoteId}
            onSelectionChange={selectRange}
            onCreate={createNote}
            onUpdate={updateNote}
            onDelete={deleteNote}
            onJump={jumpToNote}
            onEditingNoteChange={setEditingNoteId}
            onAttach={openAttachment}
            onRetry={() => setRefresh((value) => value + 1)}
            onClose={() => setReviewOpen(false)}
          />
        )}
      </div>

      {attachment && <AgentDeliveryDialog attachment={attachment} onClose={() => setAttachment(null)} />}
    </div>
  )
}
