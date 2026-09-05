import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { IpcMain } from 'electron'
import {
  EDITOR_RECOVERY_MAX_ENTRIES,
  EDITOR_RECOVERY_SCHEMA_VERSION,
  editorRecoveryKey,
  parseEditorRecoveryCheckpointRequest,
  parseEditorRecoveryClearRequest,
  parseEditorRecoveryDocument,
  parseEditorRecoveryEntry,
  parseEditorRecoveryTarget,
  parseEditorRecoveryWorkspacePath,
  type EditorRecoveryCheckpointRequest,
  type EditorRecoveryClearRequest,
  type EditorRecoveryClearResult,
  type EditorRecoveryDocument,
  type EditorRecoveryEntry,
  type EditorRecoveryTarget
} from '@shared/editor-recovery'

const RECOVERY_DIRECTORY = 'recovery'
const RECOVERY_FILE = 'editor-buffers.json'

export type EditorRecoveryLoadErrorKind = 'corrupt' | 'unsupported-schema' | 'read' | 'unsafe-path'

export class EditorRecoveryLoadError extends Error {
  constructor(
    readonly kind: EditorRecoveryLoadErrorKind,
    readonly path: string,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'EditorRecoveryLoadError'
  }
}

export class EditorRecoveryConflictError extends Error {
  constructor(readonly workspacePath: string, readonly relPath: string, message = 'The recovery checkpoint changed before this operation completed') {
    super(`${message}: ${relPath}`)
    this.name = 'EditorRecoveryConflictError'
  }
}

export type EditorRecoveryStoreOptions = {
  now?: () => Date
  createId?: () => string
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === '' || (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
}

function validatePrivateDirectory(root: string, directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const identity = lstatSync(directory)
  if (identity.isSymbolicLink() || !identity.isDirectory()) {
    throw new EditorRecoveryLoadError('unsafe-path', directory, 'Editor recovery directory is not a private regular directory')
  }
  const real = realpathSync(directory)
  if (!isWithin(root, real)) {
    throw new EditorRecoveryLoadError('unsafe-path', directory, 'Editor recovery directory escapes userData')
  }
  if (process.platform !== 'win32') chmodSync(real, 0o700)
}

function readDocument(path: string, root: string): EditorRecoveryDocument {
  if (!existsSync(path)) return { schemaVersion: EDITOR_RECOVERY_SCHEMA_VERSION, entries: [] }
  const identity = lstatSync(path)
  if (identity.isSymbolicLink() || !identity.isFile()) {
    throw new EditorRecoveryLoadError('unsafe-path', path, 'Editor recovery store is not a regular file')
  }
  if (!isWithin(root, realpathSync(path))) {
    throw new EditorRecoveryLoadError('unsafe-path', path, 'Editor recovery store escapes userData')
  }

  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new EditorRecoveryLoadError('corrupt', path, 'Editor recovery store contains invalid JSON', error)
    }
    throw new EditorRecoveryLoadError('read', path, 'Editor recovery store could not be read', error)
  }
  if (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && 'schemaVersion' in value
    && value.schemaVersion !== EDITOR_RECOVERY_SCHEMA_VERSION
  ) {
    throw new EditorRecoveryLoadError(
      'unsupported-schema',
      path,
      `Unsupported editor recovery schema version: ${String(value.schemaVersion)}`
    )
  }
  try {
    return parseEditorRecoveryDocument(value)
  } catch (error) {
    throw new EditorRecoveryLoadError('corrupt', path, 'Editor recovery store failed validation', error)
  }
}

/** Fsync the complete next document before atomically publishing it. */
function writeDocument(path: string, root: string, document: EditorRecoveryDocument): void {
  const directory = dirname(path)
  validatePrivateDirectory(root, directory)
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, path)
    if (process.platform !== 'win32') chmodSync(path, 0o600)
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    rmSync(temporary, { force: true })
    throw error
  }

  if (process.platform === 'win32') return
  let directoryDescriptor: number | undefined
  try {
    directoryDescriptor = openSync(directory, 'r')
    fsyncSync(directoryDescriptor)
  } catch {
    // The file itself was flushed and atomically renamed. Some filesystems do not permit directory fsync.
  } finally {
    if (directoryDescriptor !== undefined) closeSync(directoryDescriptor)
  }
}

/** Atomic, owner-only and bounded main-process authority for unsaved editor text. */
export class EditorRecoveryStore {
  readonly path: string
  private readonly root: string
  private readonly now: () => Date
  private readonly createId: () => string
  private document: EditorRecoveryDocument

  constructor(userDataDir: string, options: EditorRecoveryStoreOptions = {}) {
    if (!isAbsolute(userDataDir)) throw new EditorRecoveryLoadError('unsafe-path', userDataDir, 'userData path must be absolute')
    mkdirSync(userDataDir, { recursive: true })
    this.root = realpathSync(userDataDir)
    const directory = resolve(this.root, RECOVERY_DIRECTORY)
    if (!isWithin(this.root, directory)) throw new EditorRecoveryLoadError('unsafe-path', directory, 'Editor recovery path escapes userData')
    this.path = join(directory, RECOVERY_FILE)
    if (existsSync(directory)) validatePrivateDirectory(this.root, directory)
    this.document = readDocument(this.path, this.root)
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? randomUUID
  }

  list(): EditorRecoveryEntry[] {
    return this.document.entries
      .map((entry, index) => parseEditorRecoveryEntry(entry, `stored recovery entry ${index}`))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.relPath.localeCompare(right.relPath))
  }

  get(target: EditorRecoveryTarget): EditorRecoveryEntry | undefined {
    const parsed = parseEditorRecoveryTarget(target)
    const key = editorRecoveryKey(parsed.workspacePath, parsed.relPath)
    const entry = this.document.entries.find((candidate) => editorRecoveryKey(candidate.workspacePath, candidate.relPath) === key)
    return entry === undefined ? undefined : parseEditorRecoveryEntry(entry)
  }

  checkpoint(value: EditorRecoveryCheckpointRequest): EditorRecoveryEntry {
    const request = parseEditorRecoveryCheckpointRequest(value)
    const key = editorRecoveryKey(request.workspacePath, request.relPath)
    const index = this.document.entries.findIndex((entry) => editorRecoveryKey(entry.workspacePath, entry.relPath) === key)
    const current = index < 0 ? undefined : this.document.entries[index]
    if (current?.checkpointId !== request.expectedCheckpointId || (!current && request.expectedCheckpointId !== undefined)) {
      throw new EditorRecoveryConflictError(request.workspacePath, request.relPath)
    }
    if (current && request.bufferVersion < current.bufferVersion) {
      throw new EditorRecoveryConflictError(request.workspacePath, request.relPath, 'A newer recovery buffer is already stored')
    }
    if (current && request.bufferVersion === current.bufferVersion && request.content !== current.content) {
      throw new EditorRecoveryConflictError(request.workspacePath, request.relPath, 'Buffer content changed without advancing its version')
    }
    if (!current && this.document.entries.length >= EDITOR_RECOVERY_MAX_ENTRIES) {
      throw new Error(`Editor recovery entry limit reached (${EDITOR_RECOVERY_MAX_ENTRIES}); discard an old recovery before editing another file`)
    }

    const entry = parseEditorRecoveryEntry({
      checkpointId: this.createId(),
      workspacePath: request.workspacePath,
      relPath: request.relPath,
      content: request.content,
      originalRevision: request.originalRevision,
      bufferVersion: request.bufferVersion,
      updatedAt: this.timestamp(),
      ...(request.viewState === undefined ? {} : { viewState: request.viewState })
    })
    const entries = this.document.entries.slice()
    if (index < 0) entries.push(entry)
    else entries[index] = entry
    this.commit({ schemaVersion: EDITOR_RECOVERY_SCHEMA_VERSION, entries })
    return parseEditorRecoveryEntry(entry)
  }

  clear(value: EditorRecoveryClearRequest): EditorRecoveryClearResult {
    const request = parseEditorRecoveryClearRequest(value)
    const key = editorRecoveryKey(request.workspacePath, request.relPath)
    const index = this.document.entries.findIndex((entry) => editorRecoveryKey(entry.workspacePath, entry.relPath) === key)
    if (index < 0) return { cleared: false }
    const current = this.document.entries[index]!
    if (current.checkpointId !== request.expectedCheckpointId) {
      return { cleared: false, current: parseEditorRecoveryEntry(current) }
    }
    const entries = this.document.entries.slice()
    entries.splice(index, 1)
    this.commit({ schemaVersion: EDITOR_RECOVERY_SCHEMA_VERSION, entries })
    return { cleared: true }
  }

  private timestamp(): string {
    const instant = this.now()
    if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) throw new Error('Editor recovery clock returned an invalid instant')
    return instant.toISOString()
  }

  private commit(value: EditorRecoveryDocument): void {
    const document = parseEditorRecoveryDocument(value)
    writeDocument(this.path, this.root, document)
    this.document = document
  }
}

export type EditorRecoveryWorkspaceResolver = (workspacePath: string) => string | Promise<string>

export type EditorRecoveryServiceOptions = EditorRecoveryStoreOptions & {
  resolveWorkspace: EditorRecoveryWorkspaceResolver
}

/** Authorized facade. Writes and lookups re-resolve a currently registered local workspace. */
export class EditorRecoveryService {
  private readonly recoveryStore: EditorRecoveryStore | undefined
  private readonly loadFailure: Error | undefined
  private readonly resolveWorkspace: EditorRecoveryWorkspaceResolver

  constructor(userDataDir: string, options: EditorRecoveryServiceOptions) {
    if (!options?.resolveWorkspace) throw new Error('EditorRecoveryService requires a registered-workspace resolver')
    let recoveryStore: EditorRecoveryStore | undefined
    let loadFailure: Error | undefined
    try {
      recoveryStore = new EditorRecoveryStore(userDataDir, options)
    } catch (error) {
      loadFailure = error instanceof Error ? error : new Error(String(error))
    }
    this.recoveryStore = recoveryStore
    this.loadFailure = loadFailure
    this.resolveWorkspace = options.resolveWorkspace
  }

  get store(): EditorRecoveryStore {
    if (this.recoveryStore) return this.recoveryStore
    throw this.loadFailure ?? new Error('Editor recovery store is unavailable')
  }

  list(): EditorRecoveryEntry[] {
    return this.store.list()
  }

  async get(value: EditorRecoveryTarget): Promise<EditorRecoveryEntry | undefined> {
    const target = parseEditorRecoveryTarget(value)
    const workspacePath = await this.authorizedWorkspace(target.workspacePath)
    return this.store.get({ ...target, workspacePath })
  }

  async checkpoint(value: EditorRecoveryCheckpointRequest): Promise<EditorRecoveryEntry> {
    const request = parseEditorRecoveryCheckpointRequest(value)
    const workspacePath = await this.authorizedWorkspace(request.workspacePath)
    return this.store.checkpoint({ ...request, workspacePath })
  }

  clear(value: EditorRecoveryClearRequest): EditorRecoveryClearResult {
    return this.store.clear(parseEditorRecoveryClearRequest(value))
  }

  private async authorizedWorkspace(workspacePath: string): Promise<string> {
    const resolved = await this.resolveWorkspace(parseEditorRecoveryWorkspacePath(workspacePath))
    return parseEditorRecoveryWorkspacePath(resolved)
  }
}

type EditorRecoveryIpcRegistrar = Pick<IpcMain, 'handle'>

/** Parent integration seam; the caller owns app lifecycle and supplies Electron's ipcMain. */
export function registerEditorRecoveryHandlers(ipc: EditorRecoveryIpcRegistrar, service: EditorRecoveryService): void {
  ipc.handle('editorRecoveryList', () => service.list())
  ipc.handle('editorRecoveryGet', (_event, value: unknown) => service.get(parseEditorRecoveryTarget(value)))
  ipc.handle('editorRecoveryCheckpoint', (_event, value: unknown) => service.checkpoint(parseEditorRecoveryCheckpointRequest(value)))
  ipc.handle('editorRecoveryClear', (_event, value: unknown) => service.clear(parseEditorRecoveryClearRequest(value)))
}
