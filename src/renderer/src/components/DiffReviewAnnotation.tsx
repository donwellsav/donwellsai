import type { DiffReviewNote } from '@shared/diff-review'

function rangeLabel(note: DiffReviewNote): string {
  const { side, startLine, endLine } = note.anchor
  return startLine === endLine ? `${side} line ${startLine}` : `${side} lines ${startLine}–${endLine}`
}

export function DiffReviewAnnotation({
  note,
  onEdit,
  onJump
}: {
  note: DiffReviewNote
  onEdit(note: DiffReviewNote): void
  onJump(note: DiffReviewNote): void
}) {
  return (
    <article
      className="diff-review-annotation"
      data-review-note-id={note.id}
      aria-label={`Review note on ${rangeLabel(note)}`}
      tabIndex={0}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header>
        <span className="diff-review-annotation-kicker">Review note</span>
        <span className="diff-review-line-label">{rangeLabel(note)}</span>
      </header>
      <p>{note.body}</p>
      <footer>
        <button type="button" onClick={() => onJump(note)}>Focus range</button>
        <button type="button" onClick={() => onEdit(note)}>Edit note</button>
      </footer>
    </article>
  )
}
