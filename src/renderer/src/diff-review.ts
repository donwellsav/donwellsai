import type { SelectedLineRange } from '@pierre/diffs'
import {
  DIFF_REVIEW_RANGE_MAX_LINES,
  type DiffReviewSelection,
  type DiffReviewSnapshotIdentity,
  type DiffReviewSnapshotSide,
  type DiffReviewSide
} from '@shared/diff-review'
import type { AppSettings } from '@shared/types'

export type DiffSource = { path: string; contents: string | null }
export type DiffSources = { before: DiffSource; after: DiffSource }

export { diffSourcePaths } from '@shared/diff-review'

export function reviewSideFromPierre(side: SelectedLineRange['side']): DiffReviewSide {
  if (side === 'deletions') return 'before'
  if (side === 'additions') return 'after'
  throw new Error('The diff did not identify which snapshot side was selected')
}

export function pierreSideFromReview(side: DiffReviewSide): 'deletions' | 'additions' {
  return side === 'before' ? 'deletions' : 'additions'
}

function availableSource(snapshot: DiffReviewSnapshotIdentity, side: DiffReviewSide): DiffReviewSnapshotSide & { kind: 'content' } {
  const source = snapshot[side]
  if (source.kind !== 'content' || source.lineCount === 0) {
    throw new Error(`The ${side} snapshot has no reviewable lines`)
  }
  return source
}

export function reviewSelectionFromPierre(
  range: SelectedLineRange,
  snapshot: DiffReviewSnapshotIdentity
): DiffReviewSelection {
  const side = reviewSideFromPierre(range.side)
  const endSide = reviewSideFromPierre(range.endSide ?? range.side)
  if (endSide !== side) throw new Error('Select a range entirely within one snapshot side')
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)) {
    throw new Error('The selected line range is invalid')
  }
  const startLine = Math.min(range.start, range.end)
  const endLine = Math.max(range.start, range.end)
  if (endLine - startLine + 1 > DIFF_REVIEW_RANGE_MAX_LINES) {
    throw new Error(`A review range cannot span more than ${DIFF_REVIEW_RANGE_MAX_LINES} lines`)
  }
  const source = availableSource(snapshot, side)
  if (startLine < 1 || endLine > source.lineCount) {
    throw new Error('The selected line range is outside the loaded snapshot')
  }
  return { side, startLine, endLine }
}

export function pierreSelectionFromReview(selection: DiffReviewSelection): SelectedLineRange {
  const side = pierreSideFromReview(selection.side)
  return { start: selection.startLine, end: selection.endLine, side, endSide: side }
}

export function lineCountForReviewSide(snapshot: DiffReviewSnapshotIdentity, side: DiffReviewSide): number {
  const source = snapshot[side]
  return source.kind === 'content' ? source.lineCount : 0
}

export function resolvedDiffTheme(
  preference: AppSettings['theme'],
  systemPrefersDark: boolean
): 'light' | 'dark' {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light'
  return preference
}
