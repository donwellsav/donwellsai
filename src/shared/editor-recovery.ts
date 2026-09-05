export const EDITOR_RECOVERY_SCHEMA_VERSION = 1 as const
export const EDITOR_RECOVERY_MAX_ENTRIES = 192
export const EDITOR_RECOVERY_MAX_CONTENT_BYTES = 2 * 1024 * 1024
export const EDITOR_RECOVERY_MAX_DOCUMENT_BYTES = 32 * 1024 * 1024

const MAX_PATH_LENGTH = 4_096
const MAX_REVISION_LENGTH = 512
const MAX_CHECKPOINT_ID_LENGTH = 128
const MAX_POSITION = 1_000_000_000
const MAX_SCROLL_OFFSET = 1_000_000_000_000
const UTF8_ENCODER = new TextEncoder()

type UnknownRecord = Record<string, unknown>

export type EditorRecoveryViewState = {
  selectionStartLineNumber: number
  selectionStartColumn: number
  positionLineNumber: number
  positionColumn: number
  scrollTop: number
  scrollLeft: number
}

export type EditorRecoveryEntry = {
  checkpointId: string
  workspacePath: string
  relPath: string
  content: string
  /** Revision of the disk snapshot the unsaved buffer is based on. */
  originalRevision: string
  /** Monotonic within one editor buffer, including across partial save acknowledgements. */
  bufferVersion: number
  updatedAt: string
  viewState?: EditorRecoveryViewState
}

export type EditorRecoveryDocument = {
  schemaVersion: typeof EDITOR_RECOVERY_SCHEMA_VERSION
  entries: EditorRecoveryEntry[]
}

export type EditorRecoveryCheckpointRequest = Omit<EditorRecoveryEntry, 'checkpointId' | 'updatedAt'> & {
  /** Compare-and-swap guard. Omit only when creating a previously absent draft. */
  expectedCheckpointId?: string
}

export type EditorRecoveryTarget = {
  workspacePath: string
  relPath: string
}

export type EditorRecoveryClearRequest = EditorRecoveryTarget & {
  expectedCheckpointId: string
}

export type EditorRecoveryClearResult =
  | { cleared: true }
  | { cleared: false; current?: EditorRecoveryEntry }

export interface RecoveryApi {
  editorRecoveryList(): Promise<EditorRecoveryEntry[]>
  editorRecoveryGet(target: EditorRecoveryTarget): Promise<EditorRecoveryEntry | undefined>
  editorRecoveryCheckpoint(request: EditorRecoveryCheckpointRequest): Promise<EditorRecoveryEntry>
  editorRecoveryClear(request: EditorRecoveryClearRequest): Promise<EditorRecoveryClearResult>
}

function record(value: unknown, label: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as UnknownRecord
}

function exactKeys(value: UnknownRecord, allowed: readonly string[], required: readonly string[], label: string): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key))
  if (extra) throw new Error(`${label} contains unknown field: ${extra}`)
  const missing = required.find((key) => !Object.hasOwn(value, key))
  if (missing) throw new Error(`${label} is missing field: ${missing}`)
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string no longer than ${maxLength} characters`)
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} contains control characters`)
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_POSITION) {
    throw new Error(`${label} must be a positive safe integer no greater than ${MAX_POSITION}`)
  }
  return value
}

function scrollOffset(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_SCROLL_OFFSET) {
    throw new Error(`${label} must be a finite non-negative number no greater than ${MAX_SCROLL_OFFSET}`)
  }
  return value
}


export function editorRecoveryKey(workspacePath: string, relPath: string): string {
  return workspacePath + '\0' + relPath
}

export function parseEditorRecoveryWorkspacePath(value: unknown): string {
  const path = boundedString(value, 'workspacePath', MAX_PATH_LENGTH)
  const absolute = path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
  if (!absolute) throw new Error('workspacePath must be absolute')
  return path
}

export function parseEditorRecoveryRelativePath(value: unknown): string {
  const path = boundedString(value, 'relPath', MAX_PATH_LENGTH)
  if (
    path.startsWith('/')
    || path.startsWith('\\')
    || /^[A-Za-z]:[\\/]/.test(path)
    || path.includes('\\')
    || path.endsWith('/')
    || path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`relPath must stay within the workspace: ${path}`)
  }
  return path
}

function parseRevision(value: unknown): string {
  return boundedString(value, 'originalRevision', MAX_REVISION_LENGTH)
}

function parseCheckpointId(value: unknown): string {
  const id = boundedString(value, 'checkpointId', MAX_CHECKPOINT_ID_LENGTH)
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('checkpointId contains unsupported characters')
  return id
}

function parseTimestamp(value: unknown): string {
  const timestamp = boundedString(value, 'updatedAt', 64)
  const milliseconds = Date.parse(timestamp)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
    throw new Error('updatedAt must be a canonical ISO timestamp')
  }
  return timestamp
}

function parseContent(value: unknown): string {
  if (typeof value !== 'string') throw new Error('content must be a string')
  if (UTF8_ENCODER.encode(value).byteLength > EDITOR_RECOVERY_MAX_CONTENT_BYTES) {
    throw new Error(`content exceeds the ${EDITOR_RECOVERY_MAX_CONTENT_BYTES} byte recovery limit`)
  }
  return value
}

export function parseEditorRecoveryViewState(value: unknown): EditorRecoveryViewState {
  const input = record(value, 'viewState')
  const keys = [
    'selectionStartLineNumber',
    'selectionStartColumn',
    'positionLineNumber',
    'positionColumn',
    'scrollTop',
    'scrollLeft'
  ] as const
  exactKeys(input, keys, keys, 'viewState')
  return {
    selectionStartLineNumber: positiveInteger(input.selectionStartLineNumber, 'viewState.selectionStartLineNumber'),
    selectionStartColumn: positiveInteger(input.selectionStartColumn, 'viewState.selectionStartColumn'),
    positionLineNumber: positiveInteger(input.positionLineNumber, 'viewState.positionLineNumber'),
    positionColumn: positiveInteger(input.positionColumn, 'viewState.positionColumn'),
    scrollTop: scrollOffset(input.scrollTop, 'viewState.scrollTop'),
    scrollLeft: scrollOffset(input.scrollLeft, 'viewState.scrollLeft')
  }
}

function parseEntryFields(input: UnknownRecord): Omit<EditorRecoveryEntry, 'checkpointId' | 'updatedAt'> {
  const content = parseContent(input.content)
  return {
    workspacePath: parseEditorRecoveryWorkspacePath(input.workspacePath),
    relPath: parseEditorRecoveryRelativePath(input.relPath),
    content,
    originalRevision: parseRevision(input.originalRevision),
    bufferVersion: positiveInteger(input.bufferVersion, 'bufferVersion'),
    ...(input.viewState === undefined ? {} : { viewState: parseEditorRecoveryViewState(input.viewState) })
  }
}

export function parseEditorRecoveryEntry(value: unknown, label = 'recovery entry'): EditorRecoveryEntry {
  const input = record(value, label)
  const allowed = ['checkpointId', 'workspacePath', 'relPath', 'content', 'originalRevision', 'bufferVersion', 'updatedAt', 'viewState'] as const
  const required = ['checkpointId', 'workspacePath', 'relPath', 'content', 'originalRevision', 'bufferVersion', 'updatedAt'] as const
  exactKeys(input, allowed, required, label)
  return {
    checkpointId: parseCheckpointId(input.checkpointId),
    ...parseEntryFields(input),
    updatedAt: parseTimestamp(input.updatedAt)
  }
}

export function parseEditorRecoveryCheckpointRequest(value: unknown): EditorRecoveryCheckpointRequest {
  const input = record(value, 'recovery checkpoint')
  const allowed = ['workspacePath', 'relPath', 'content', 'originalRevision', 'bufferVersion', 'viewState', 'expectedCheckpointId'] as const
  const required = ['workspacePath', 'relPath', 'content', 'originalRevision', 'bufferVersion'] as const
  exactKeys(input, allowed, required, 'recovery checkpoint')
  return {
    ...parseEntryFields(input),
    ...(input.expectedCheckpointId === undefined ? {} : { expectedCheckpointId: parseCheckpointId(input.expectedCheckpointId) })
  }
}

export function parseEditorRecoveryClearRequest(value: unknown): EditorRecoveryClearRequest {
  const input = record(value, 'recovery clear request')
  const keys = ['workspacePath', 'relPath', 'expectedCheckpointId'] as const
  exactKeys(input, keys, keys, 'recovery clear request')
  return {
    workspacePath: parseEditorRecoveryWorkspacePath(input.workspacePath),
    relPath: parseEditorRecoveryRelativePath(input.relPath),
    expectedCheckpointId: parseCheckpointId(input.expectedCheckpointId)
  }
}

export function parseEditorRecoveryTarget(value: unknown): EditorRecoveryTarget {
  const input = record(value, 'recovery target')
  const keys = ['workspacePath', 'relPath'] as const
  exactKeys(input, keys, keys, 'recovery target')
  return {
    workspacePath: parseEditorRecoveryWorkspacePath(input.workspacePath),
    relPath: parseEditorRecoveryRelativePath(input.relPath)
  }
}
export function parseEditorRecoveryDocument(value: unknown): EditorRecoveryDocument {
  const input = record(value, 'recovery document')
  exactKeys(input, ['schemaVersion', 'entries'], ['schemaVersion', 'entries'], 'recovery document')
  if (input.schemaVersion !== EDITOR_RECOVERY_SCHEMA_VERSION) {
    throw new Error(`Unsupported editor recovery schema version: ${String(input.schemaVersion)}`)
  }
  if (!Array.isArray(input.entries) || input.entries.length > EDITOR_RECOVERY_MAX_ENTRIES) {
    throw new Error(`recovery document entries must be an array with at most ${EDITOR_RECOVERY_MAX_ENTRIES} items`)
  }
  const entries = input.entries.map((entry, index) => parseEditorRecoveryEntry(entry, `recovery entry ${index}`))
  const keys = new Set<string>()
  for (const entry of entries) {
    const key = editorRecoveryKey(entry.workspacePath, entry.relPath)
    if (keys.has(key)) throw new Error(`recovery document contains duplicate entry: ${entry.relPath}`)
    keys.add(key)
  }
  const document = { schemaVersion: EDITOR_RECOVERY_SCHEMA_VERSION, entries }
  if (UTF8_ENCODER.encode(JSON.stringify(document)).byteLength > EDITOR_RECOVERY_MAX_DOCUMENT_BYTES) {
    throw new Error(`recovery document exceeds the ${EDITOR_RECOVERY_MAX_DOCUMENT_BYTES} byte storage limit`)
  }
  return document
}
