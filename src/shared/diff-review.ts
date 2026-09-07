import type { ParallelTaskStatus, VerificationEntry } from './operational-runs'
import type { AgentAttachmentDraft } from './agent-delivery'
import type { DiffComparison } from './types'

export const DIFF_REVIEW_SCHEMA_VERSION = 1 as const
export const DIFF_REVIEW_BODY_MAX_LENGTH = 16_000
export const DIFF_REVIEW_RANGE_MAX_LINES = 200
export const DIFF_REVIEW_CONTEXT_RADIUS = 3
export const DIFF_REVIEW_MAX_NOTES = 5_000

const MAX_PATH_LENGTH = 4_096
const MAX_IDENTIFIER_LENGTH = 128
const MAX_CONTEXT_LINE_LENGTH = 32_768
const MAX_CONTEXT_LENGTH = 256_000
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MAX_CONTEXT_RADIUS = 20

export type DiffReviewSide = 'before' | 'after'

export type DiffReviewSnapshotSide =
  | { kind: 'absent'; path: string }
  | { kind: 'content'; path: string; sha256: string; byteLength: number; lineCount: number }

export type DiffReviewSnapshotIdentity = {
  before: DiffReviewSnapshotSide
  after: DiffReviewSnapshotSide
}

export type DiffReviewSelection = {
  side: DiffReviewSide
  startLine: number
  endLine: number
}

export type DiffReviewContextLine = {
  lineNumber: number
  text: string
}

export type DiffReviewAnchor = DiffReviewSelection & {
  context: DiffReviewContextLine[]
}

export type DiffReviewTarget = {
  workspacePath: string
  filePath: string
  comparison: DiffComparison
}

export type DiffReviewRunLink = { runId: string; taskId: string; sourceFingerprint: string }
export type DiffReviewRunState = { status: ParallelTaskStatus; sourceState: VerificationEntry['sourceState']; exitCode?: number; sourceFingerprint: string | null }

export type DiffReviewNote = {
  runLink?: DiffReviewRunLink
  id: string
  target: DiffReviewTarget
  snapshot: DiffReviewSnapshotIdentity
  anchor: DiffReviewAnchor
  body: string
  createdAt: string
  updatedAt: string
  revision: number
}

export type DiffReviewDocument = {
  schemaVersion: typeof DIFF_REVIEW_SCHEMA_VERSION
  notes: DiffReviewNote[]
}

export type DiffReviewListRequest = DiffReviewTarget
export type DiffReviewListResult = { target: DiffReviewTarget; notes: DiffReviewNote[]; runStates?: Record<string, DiffReviewRunState | null> }
export type DiffReviewCreateRequest = DiffReviewTarget & {
  runLink?: Pick<DiffReviewRunLink, 'runId' | 'taskId'>
  snapshot: DiffReviewSnapshotIdentity
  anchor: DiffReviewAnchor
  body: string
}
export type DiffReviewUpdateRequest = {
  workspacePath: string
  id: string
  expectedRevision: number
  body: string
}
export type DiffReviewDeleteRequest = {
  workspacePath: string
  id: string
  expectedRevision: number
}

export interface DiffReviewApi {
  diffReviewList(request: DiffReviewListRequest): Promise<DiffReviewListResult>
  diffReviewCreate(request: DiffReviewCreateRequest): Promise<DiffReviewNote>
  diffReviewUpdate(request: DiffReviewUpdateRequest): Promise<DiffReviewNote>
  diffReviewDelete(request: DiffReviewDeleteRequest): Promise<void>
}

type UnknownRecord = Record<string, unknown>

function record(value: unknown, label: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as UnknownRecord
}

function exactKeys(value: UnknownRecord, expected: readonly string[], label: string): void {
  const extra = Object.keys(value).find((key) => !expected.includes(key))
  if (extra) throw new Error(`${label} contains unknown field: ${extra}`)
  const missing = expected.find((key) => !Object.hasOwn(value, key))
  if (missing) throw new Error(`${label} is missing field: ${missing}`)
}

function boundedString(value: unknown, label: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? 'a' : 'a non-empty'} string no longer than ${maxLength} characters`)
  }
  if (value.includes(String.fromCharCode(0))) throw new Error(`${label} must not contain a null byte`)
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer`)
  return value as number
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`)
  return value as number
}

function parseIdentifier(value: unknown, label: string): string {
  const id = boundedString(value, label, MAX_IDENTIFIER_LENGTH)
  if (/\s/.test(id)) throw new Error(`${label} must not contain whitespace`)
  return id
}

function parseTimestamp(value: unknown, label: string): string {
  const timestamp = boundedString(value, label, 64)
  const instant = Date.parse(timestamp)
  if (!Number.isFinite(instant) || new Date(instant).toISOString() !== timestamp) {
    throw new Error(`${label} must be a canonical ISO timestamp`)
  }
  return timestamp
}

export function parseDiffReviewFilePath(value: unknown, label = 'filePath'): string {
  const path = boundedString(value, label, MAX_PATH_LENGTH)
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error(`${label} must be relative to the workspace`)
  }
  if (path.split(/[\\/]/).some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`${label} must not escape the workspace`)
  }
  return path
}

export function parseDiffReviewWorkspacePath(value: unknown): string {
  return boundedString(value, 'workspacePath', MAX_PATH_LENGTH)
}

function parseComparison(value: unknown): DiffComparison {
  if (value !== 'working' && value !== 'staged' && value !== 'unstaged') {
    throw new Error('comparison must be working, staged, or unstaged')
  }
  return value
}

function parseSide(value: unknown, label = 'side'): DiffReviewSide {
  if (value !== 'before' && value !== 'after') throw new Error(`${label} must be before or after`)
  return value
}

export function normalizeDiffReviewBody(value: unknown): string {
  const body = boundedString(value, 'body', DIFF_REVIEW_BODY_MAX_LENGTH).replace(/\r\n?/g, '\n').trim()
  if (!body) throw new Error('body must contain a review note')
  return body
}

export function parseDiffReviewTarget(value: unknown, label = 'target'): DiffReviewTarget {
  const input = record(value, label)
  exactKeys(input, ['workspacePath', 'filePath', 'comparison'], label)
  return {
    workspacePath: parseDiffReviewWorkspacePath(input.workspacePath),
    filePath: parseDiffReviewFilePath(input.filePath, `${label}.filePath`),
    comparison: parseComparison(input.comparison)
  }
}

function parseSnapshotSide(value: unknown, label: string): DiffReviewSnapshotSide {
  const input = record(value, label)
  if (input.kind === 'absent') {
    exactKeys(input, ['kind', 'path'], label)
    return { kind: 'absent', path: parseDiffReviewFilePath(input.path, `${label}.path`) }
  }
  if (input.kind !== 'content') throw new Error(`${label}.kind must be absent or content`)
  exactKeys(input, ['kind', 'path', 'sha256', 'byteLength', 'lineCount'], label)
  const sha256 = boundedString(input.sha256, `${label}.sha256`, 64)
  if (!SHA256_PATTERN.test(sha256)) throw new Error(`${label}.sha256 must be a lowercase SHA-256 digest`)
  return {
    kind: 'content',
    path: parseDiffReviewFilePath(input.path, `${label}.path`),
    sha256,
    byteLength: nonNegativeInteger(input.byteLength, `${label}.byteLength`),
    lineCount: nonNegativeInteger(input.lineCount, `${label}.lineCount`)
  }
}

export function parseDiffReviewSnapshot(value: unknown, label = 'snapshot'): DiffReviewSnapshotIdentity {
  const input = record(value, label)
  exactKeys(input, ['before', 'after'], label)
  return {
    before: parseSnapshotSide(input.before, `${label}.before`),
    after: parseSnapshotSide(input.after, `${label}.after`)
  }
}

function lineText(value: unknown, label: string): string {
  const text = boundedString(value, label, MAX_CONTEXT_LINE_LENGTH, true)
  const withoutEnding = text.replace(/(?:\r\n|\r|\n)$/, '')
  if (/[\r\n]/.test(withoutEnding)) throw new Error(`${label} must contain exactly one source line`)
  return text
}

function parseContext(value: unknown, label: string): DiffReviewContextLine[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > DIFF_REVIEW_RANGE_MAX_LINES + (MAX_CONTEXT_RADIUS * 2)) {
    throw new Error(`${label} must be a bounded, non-empty line array`)
  }
  let totalLength = 0
  const lines = value.map((entry, index) => {
    const input = record(entry, `${label}[${index}]`)
    exactKeys(input, ['lineNumber', 'text'], `${label}[${index}]`)
    const text = lineText(input.text, `${label}[${index}].text`)
    totalLength += text.length
    return { lineNumber: positiveInteger(input.lineNumber, `${label}[${index}].lineNumber`), text }
  })
  if (totalLength > MAX_CONTEXT_LENGTH) throw new Error(`${label} exceeds the stored context limit`)
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]!.lineNumber !== lines[index - 1]!.lineNumber + 1) {
      throw new Error(`${label} line numbers must be contiguous and ascending`)
    }
  }
  return lines
}

export function parseDiffReviewAnchor(value: unknown, label = 'anchor'): DiffReviewAnchor {
  const input = record(value, label)
  exactKeys(input, ['side', 'startLine', 'endLine', 'context'], label)
  const startLine = positiveInteger(input.startLine, `${label}.startLine`)
  const endLine = positiveInteger(input.endLine, `${label}.endLine`)
  if (endLine < startLine) throw new Error(`${label}.endLine must not precede startLine`)
  if (endLine - startLine + 1 > DIFF_REVIEW_RANGE_MAX_LINES) {
    throw new Error(`${label} cannot span more than ${DIFF_REVIEW_RANGE_MAX_LINES} lines`)
  }
  const context = parseContext(input.context, `${label}.context`)
  if (context[0]!.lineNumber > startLine || context.at(-1)!.lineNumber < endLine) {
    throw new Error(`${label}.context must include every selected line`)
  }
  return { side: parseSide(input.side, `${label}.side`), startLine, endLine, context }
}

function validateAnchorAgainstSnapshot(anchor: DiffReviewAnchor, snapshot: DiffReviewSnapshotIdentity, label: string): void {
  const source = snapshot[anchor.side]
  if (source.kind !== 'content') throw new Error(`${label} cannot target an absent snapshot side`)
  if (anchor.endLine > source.lineCount) throw new Error(`${label} exceeds the snapshot line count`)
  if (anchor.context.at(-1)!.lineNumber > source.lineCount) throw new Error(`${label}.context exceeds the snapshot line count`)
}

function validateSnapshotAgainstTarget(
  target: DiffReviewTarget,
  snapshot: DiffReviewSnapshotIdentity,
  label: string
): void {
  if (snapshot.after.path !== target.filePath) {
    throw new Error(`${label}.after.path must match the diff target file`)
  }
}

export function parseDiffReviewListRequest(value: unknown): DiffReviewListRequest {
  return parseDiffReviewTarget(value, 'diff review list request')
}

function parseReviewRunLink(value: unknown, persisted: boolean): DiffReviewRunLink | Pick<DiffReviewRunLink, 'runId' | 'taskId'> {
  const input = record(value, 'review run link')
  exactKeys(input, ['runId', 'taskId', ...(persisted ? ['sourceFingerprint'] : [])], 'review run link')
  if (persisted && (typeof input.sourceFingerprint !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(input.sourceFingerprint))) throw new Error('Invalid review run source fingerprint')
  return { runId: parseIdentifier(input.runId, 'runId'), taskId: parseIdentifier(input.taskId, 'taskId'), ...(persisted ? { sourceFingerprint: input.sourceFingerprint as string } : {}) }
}

export function parseDiffReviewCreateRequest(value: unknown): DiffReviewCreateRequest {
  const input = record(value, 'diff review create request')
  exactKeys(input, ['workspacePath', 'filePath', 'comparison', 'snapshot', 'anchor', 'body', ...(Object.hasOwn(input, 'runLink') ? ['runLink'] : [])], 'diff review create request')
  const target = parseDiffReviewTarget({
    workspacePath: input.workspacePath,
    filePath: input.filePath,
    comparison: input.comparison
  }, 'diff review create request target')
  const snapshot = parseDiffReviewSnapshot(input.snapshot)
  const anchor = parseDiffReviewAnchor(input.anchor)
  validateSnapshotAgainstTarget(target, snapshot, 'snapshot')
  validateAnchorAgainstSnapshot(anchor, snapshot, 'anchor')
  return { ...target, snapshot, anchor, body: normalizeDiffReviewBody(input.body), ...(input.runLink === undefined ? {} : { runLink: parseReviewRunLink(input.runLink, false) }) }
}

export function parseDiffReviewUpdateRequest(value: unknown): DiffReviewUpdateRequest {
  const input = record(value, 'diff review update request')
  exactKeys(input, ['workspacePath', 'id', 'expectedRevision', 'body'], 'diff review update request')
  return {
    workspacePath: parseDiffReviewWorkspacePath(input.workspacePath),
    id: parseIdentifier(input.id, 'id'),
    expectedRevision: positiveInteger(input.expectedRevision, 'expectedRevision'),
    body: normalizeDiffReviewBody(input.body)
  }
}

export function parseDiffReviewDeleteRequest(value: unknown): DiffReviewDeleteRequest {
  const input = record(value, 'diff review delete request')
  exactKeys(input, ['workspacePath', 'id', 'expectedRevision'], 'diff review delete request')
  return {
    workspacePath: parseDiffReviewWorkspacePath(input.workspacePath),
    id: parseIdentifier(input.id, 'id'),
    expectedRevision: positiveInteger(input.expectedRevision, 'expectedRevision')
  }
}

export function parseDiffReviewNote(value: unknown, label = 'note'): DiffReviewNote {
  const input = record(value, label)
  exactKeys(input, ['id', 'target', 'snapshot', 'anchor', 'body', 'createdAt', 'updatedAt', 'revision', ...(Object.hasOwn(input, 'runLink') ? ['runLink'] : [])], label)
  const target = parseDiffReviewTarget(input.target, `${label}.target`)
  const snapshot = parseDiffReviewSnapshot(input.snapshot, `${label}.snapshot`)
  const anchor = parseDiffReviewAnchor(input.anchor, `${label}.anchor`)
  validateSnapshotAgainstTarget(target, snapshot, `${label}.snapshot`)
  validateAnchorAgainstSnapshot(anchor, snapshot, `${label}.anchor`)
  const createdAt = parseTimestamp(input.createdAt, `${label}.createdAt`)
  const updatedAt = parseTimestamp(input.updatedAt, `${label}.updatedAt`)
  if (updatedAt < createdAt) throw new Error(`${label}.updatedAt must not precede createdAt`)
  return {
    ...(input.runLink === undefined ? {} : { runLink: parseReviewRunLink(input.runLink, true) as DiffReviewRunLink }),
    id: parseIdentifier(input.id, `${label}.id`),
    target,
    snapshot,
    anchor,
    body: normalizeDiffReviewBody(input.body),
    createdAt,
    updatedAt,
    revision: positiveInteger(input.revision, `${label}.revision`)
  }
}

export function parseDiffReviewDocument(value: unknown): DiffReviewDocument {
  const input = record(value, 'diff review document')
  exactKeys(input, ['schemaVersion', 'notes'], 'diff review document')
  if (input.schemaVersion !== DIFF_REVIEW_SCHEMA_VERSION) {
    throw new Error(`Unsupported diff review schema version: ${String(input.schemaVersion)}`)
  }
  if (!Array.isArray(input.notes) || input.notes.length > DIFF_REVIEW_MAX_NOTES) {
    throw new Error(`diff review document cannot contain more than ${DIFF_REVIEW_MAX_NOTES} notes`)
  }
  const ids = new Set<string>()
  const notes = input.notes.map((note, index) => {
    const parsed = parseDiffReviewNote(note, `notes[${index}]`)
    if (ids.has(parsed.id)) throw new Error(`Duplicate diff review note id: ${parsed.id}`)
    ids.add(parsed.id)
    return parsed
  })
  return { schemaVersion: DIFF_REVIEW_SCHEMA_VERSION, notes }
}

export function splitDiffReviewLines(contents: string): string[] {
  if (contents === '') return []
  const lines: string[] = []
  let start = 0
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents.charCodeAt(index)
    if (character === 13) {
      if (contents.charCodeAt(index + 1) === 10) index += 1
      lines.push(contents.slice(start, index + 1))
      start = index + 1
    } else if (character === 10) {
      lines.push(contents.slice(start, index + 1))
      start = index + 1
    }
  }
  if (start < contents.length) lines.push(contents.slice(start))
  return lines
}

async function snapshotSide(path: string, contents: string | null): Promise<DiffReviewSnapshotSide> {
  const filePath = parseDiffReviewFilePath(path, 'snapshot path')
  if (contents === null) return { kind: 'absent', path: filePath }
  const encoded = new TextEncoder().encode(contents)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoded)
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return {
    kind: 'content',
    path: filePath,
    sha256,
    byteLength: encoded.byteLength,
    lineCount: splitDiffReviewLines(contents).length
  }
}

export async function createDiffReviewSnapshot(
  before: { path: string; contents: string | null },
  after: { path: string; contents: string | null }
): Promise<DiffReviewSnapshotIdentity> {
  const [beforeIdentity, afterIdentity] = await Promise.all([
    snapshotSide(before.path, before.contents),
    snapshotSide(after.path, after.contents)
  ])
  return { before: beforeIdentity, after: afterIdentity }
}

export function createDiffReviewAnchor(
  side: DiffReviewSide,
  startLine: number,
  endLine: number,
  contents: string,
  radius = DIFF_REVIEW_CONTEXT_RADIUS
): DiffReviewAnchor {
  const selection = {
    side: parseSide(side),
    startLine: positiveInteger(Math.min(startLine, endLine), 'startLine'),
    endLine: positiveInteger(Math.max(startLine, endLine), 'endLine')
  }
  if (selection.endLine - selection.startLine + 1 > DIFF_REVIEW_RANGE_MAX_LINES) {
    throw new Error(`selection cannot span more than ${DIFF_REVIEW_RANGE_MAX_LINES} lines`)
  }
  if (!Number.isSafeInteger(radius) || radius < 0 || radius > MAX_CONTEXT_RADIUS) throw new Error('context radius must be an integer between 0 and ' + MAX_CONTEXT_RADIUS)
  const lines = splitDiffReviewLines(contents)
  if (selection.endLine > lines.length) throw new Error('selection exceeds the available source lines')
  const contextStart = Math.max(1, selection.startLine - radius)
  const contextEnd = Math.min(lines.length, selection.endLine + radius)
  const context: DiffReviewContextLine[] = []
  for (let lineNumber = contextStart; lineNumber <= contextEnd; lineNumber += 1) {
    context.push({ lineNumber, text: lines[lineNumber - 1]! })
  }
  return parseDiffReviewAnchor({ ...selection, context })
}

export function diffReviewSnapshotsEqual(left: DiffReviewSnapshotIdentity, right: DiffReviewSnapshotIdentity): boolean {
  const sameSide = (a: DiffReviewSnapshotSide, b: DiffReviewSnapshotSide): boolean => {
    if (a.kind !== b.kind || a.path !== b.path) return false
    if (a.kind === 'absent' || b.kind === 'absent') return true
    return a.sha256 === b.sha256 && a.byteLength === b.byteLength && a.lineCount === b.lineCount
  }
  return sameSide(left.before, right.before) && sameSide(left.after, right.after)
}

export function diffReviewNoteIsCurrent(note: DiffReviewNote, snapshot: DiffReviewSnapshotIdentity): boolean {
  return diffReviewSnapshotsEqual(note.snapshot, snapshot)
}

function comparisonLabel(comparison: DiffComparison): string {
  if (comparison === 'staged') return 'HEAD to index'
  if (comparison === 'unstaged') return 'index to working tree'
  return 'HEAD to working tree'
}

function snapshotLabel(snapshot: DiffReviewSnapshotSide): string {
  const path = JSON.stringify(snapshot.path)
  if (snapshot.kind === 'absent') return `${path} (absent)`
  return `${path} · sha256:${snapshot.sha256} · ${snapshot.byteLength} bytes · ${snapshot.lineCount} lines`
}

function contextText(anchor: DiffReviewAnchor): string {
  return anchor.context.map((line) => {
    const marker = line.lineNumber >= anchor.startLine && line.lineNumber <= anchor.endLine ? '>' : ' '
    const text = line.text.replace(/(?:\r\n|\r|\n)$/, '')
    return `    ${marker} ${String(line.lineNumber).padStart(5, ' ')} | ${text}`
  }).join('\n')
}

function quotedBody(body: string): string {
  return body.split('\n').map((line) => `> ${line}`).join('\n')
}

export function formatDiffReviewAttachment(
  target: DiffReviewTarget,
  snapshot: DiffReviewSnapshotIdentity,
  notes: readonly DiffReviewNote[]
): AgentAttachmentDraft {
  const canonicalTarget = parseDiffReviewTarget(target)
  const currentSnapshot = parseDiffReviewSnapshot(snapshot)
  const ordered = notes.map((note, index) => parseDiffReviewNote(note, `attachment notes[${index}]`))
  ordered.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  for (const note of ordered) {
    if (note.target.workspacePath !== canonicalTarget.workspacePath
      || note.target.filePath !== canonicalTarget.filePath
      || note.target.comparison !== canonicalTarget.comparison) {
      throw new Error('attachment notes must belong to the requested diff target')
    }
  }
  const currentCount = ordered.filter((note) => diffReviewNoteIsCurrent(note, currentSnapshot)).length
  const lines = [
    '# Diff review',
    '',
    `Workspace: ${JSON.stringify(canonicalTarget.workspacePath)}`,
    `File: ${JSON.stringify(canonicalTarget.filePath)}`,
    `Comparison: ${comparisonLabel(canonicalTarget.comparison)}`,
    `Before snapshot: ${snapshotLabel(currentSnapshot.before)}`,
    `After snapshot: ${snapshotLabel(currentSnapshot.after)}`,
    `Notes: ${ordered.length} total · ${currentCount} current · ${ordered.length - currentCount} stale`,
    ''
  ]
  if (ordered.length === 0) lines.push('No review notes.', '')
  ordered.forEach((note, index) => {
    const current = diffReviewNoteIsCurrent(note, currentSnapshot)
    const range = note.anchor.startLine === note.anchor.endLine
      ? String(note.anchor.startLine)
      : `${note.anchor.startLine}-${note.anchor.endLine}`
    lines.push(
      `## Note ${index + 1}`,
      '',
      `Status: ${current ? 'current snapshot' : 'stale snapshot (preserved, not reanchored)'}`,
      `Side: ${note.anchor.side}`,
      `Line: ${note.anchor.startLine}`,
      `Range: ${range}`,
      ...(note.runLink ? [`Linked run: ${JSON.stringify(note.runLink.runId)} / task ${JSON.stringify(note.runLink.taskId)}`, `Original run source: ${note.runLink.sourceFingerprint}`, 'Run outcome and freshness must be read from the operational run owner; snapshot freshness does not establish command success.'] : []),
      `Note snapshot before: ${snapshotLabel(note.snapshot.before)}`,
      `Note snapshot after: ${snapshotLabel(note.snapshot.after)}`,
      'Context:',
      contextText(note.anchor),
      '',
      'Note:',
      quotedBody(note.body),
      ''
    )
  })
  const basename = canonicalTarget.filePath.split(/[\\/]/).at(-1) ?? canonicalTarget.filePath
  return {
    kind: 'diff-review',
    workspacePath: canonicalTarget.workspacePath,
    title: `Diff review · ${basename}`,
    text: lines.join('\n').trimEnd()
  }
}
