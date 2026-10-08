import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DIFF_REVIEW_MAX_NOTES,
  DIFF_REVIEW_SCHEMA_VERSION,
  normalizeDiffReviewBody,
  parseDiffReviewDocument,
  parseDiffReviewNote,
  type DiffReviewDocument,
  type DiffReviewNote,
  type DiffReviewTarget
} from '@shared/diff-review'
import { atomicWriteFileSync } from './atomic-write'

const FILE_NAME = 'diff-review-notes.json'

export type DiffReviewLoadErrorKind = 'corrupt' | 'unsupported-schema' | 'read'

export class DiffReviewLoadError extends Error {
  constructor(
    readonly kind: DiffReviewLoadErrorKind,
    readonly path: string,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'DiffReviewLoadError'
  }
}

export class DiffReviewConflictError extends Error {
  constructor(readonly id: string) {
    super(`Review note ${id} changed before this edit could be saved`)
    this.name = 'DiffReviewConflictError'
  }
}

export class DiffReviewNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Review note ${id} was not found in this workspace`)
    this.name = 'DiffReviewNotFoundError'
  }
}

function sameTarget(left: DiffReviewTarget, right: DiffReviewTarget): boolean {
  return left.workspacePath === right.workspacePath
    && left.filePath === right.filePath
    && left.comparison === right.comparison
}

function readDocument(path: string): DiffReviewDocument {
  if (!existsSync(path)) return { schemaVersion: DIFF_REVIEW_SCHEMA_VERSION, notes: [] }
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new DiffReviewLoadError('corrupt', path, 'Diff review notes contain invalid JSON', error)
    }
    throw new DiffReviewLoadError('read', path, 'Diff review notes could not be read', error)
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)
    && 'schemaVersion' in value && value.schemaVersion !== DIFF_REVIEW_SCHEMA_VERSION) {
    throw new DiffReviewLoadError(
      'unsupported-schema',
      path,
      `Unsupported diff review schema version: ${String(value.schemaVersion)}`
    )
  }
  try {
    return parseDiffReviewDocument(value)
  } catch (error) {
    throw new DiffReviewLoadError('corrupt', path, 'Diff review notes failed validation', error)
  }
}

/** Fsync the complete next document before atomically publishing it. */
function writeDocument(path: string, document: DiffReviewDocument): void {
  atomicWriteFileSync(path, `${JSON.stringify(document, null, 2)}\n`, { createDirectoryMode: 0o700 })
}

/** Main-process persistence authority for immutable, snapshot-bound review notes. */
export class DiffReviewStore {
  readonly path: string
  private document: DiffReviewDocument

  constructor(userDataDir: string) {
    this.path = join(userDataDir, FILE_NAME)
    this.document = readDocument(this.path)
  }

  list(target: DiffReviewTarget): DiffReviewNote[] {
    return this.document.notes
      .filter((note) => sameTarget(note.target, target))
      .map((note, index) => parseDiffReviewNote(note, `stored note ${index}`))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }

  create(note: DiffReviewNote): DiffReviewNote {
    const parsed = parseDiffReviewNote(note)
    if (this.document.notes.length >= DIFF_REVIEW_MAX_NOTES) {
      throw new Error(`Diff review note limit reached (${DIFF_REVIEW_MAX_NOTES})`)
    }
    if (this.document.notes.some((candidate) => candidate.id === parsed.id)) {
      throw new DiffReviewConflictError(parsed.id)
    }
    this.commit({
      schemaVersion: DIFF_REVIEW_SCHEMA_VERSION,
      notes: [...this.document.notes, parsed]
    })
    return parseDiffReviewNote(parsed)
  }

  update(
    workspacePath: string,
    id: string,
    expectedRevision: number,
    body: string,
    updatedAt: string
  ): DiffReviewNote {
    const index = this.document.notes.findIndex((note) => note.id === id && note.target.workspacePath === workspacePath)
    if (index < 0) throw new DiffReviewNotFoundError(id)
    const current = this.document.notes[index]!
    if (current.revision !== expectedRevision) throw new DiffReviewConflictError(id)
    const next = parseDiffReviewNote({
      ...current,
      body: normalizeDiffReviewBody(body),
      updatedAt,
      revision: current.revision + 1
    })
    const notes = [...this.document.notes]
    notes[index] = next
    this.commit({ schemaVersion: DIFF_REVIEW_SCHEMA_VERSION, notes })
    return parseDiffReviewNote(next)
  }

  remove(workspacePath: string, id: string, expectedRevision: number): void {
    const index = this.document.notes.findIndex((note) => note.id === id && note.target.workspacePath === workspacePath)
    if (index < 0) throw new DiffReviewNotFoundError(id)
    if (this.document.notes[index]!.revision !== expectedRevision) throw new DiffReviewConflictError(id)
    const notes = this.document.notes.slice()
    notes.splice(index, 1)
    this.commit({ schemaVersion: DIFF_REVIEW_SCHEMA_VERSION, notes })
  }

  private commit(document: DiffReviewDocument): void {
    const validated = parseDiffReviewDocument(document)
    writeDocument(this.path, validated)
    this.document = validated
  }
}
