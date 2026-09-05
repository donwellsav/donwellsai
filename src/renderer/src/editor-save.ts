import type { FileContent } from '../../shared/types'
import type { EditorRecoveryEntry } from '@shared/editor-recovery'

export type EditorSavePhase = 'clean' | 'dirty' | 'saving' | 'saved' | 'failed' | 'conflict' | 'readonly'
export type EditorReadOnlyReason = 'truncated' | 'unversioned'

export type EditorSaveSnapshot = {
  phase: EditorSavePhase
  content: string
  bufferVersion: number
  savedVersion: number
  sourceEpoch: number
  revision?: string
  error?: string
  readOnlyReason?: EditorReadOnlyReason
  savedAt?: number
}

export type EditorSaveAck = {
  /** Exact disk snapshot acknowledged by the backend. */
  saved: FileContent
  /** Store source epoch the write originated from. */
  sourceEpoch: number
  savedVersion: number
  currentBufferVersion: number
}

type EditorSaveOptions = {
  initial: FileContent
  sourceEpoch: number
  initialBufferVersion?: number
  recovery?: Pick<EditorRecoveryEntry, 'content' | 'originalRevision' | 'bufferVersion'>
  write(content: string, expectedRevision: string): Promise<FileContent>
  onSaveAck?(ack: EditorSaveAck): void
  now?(): number
}

export type ExternalUpdateResult = 'adopted' | 'conflict' | 'unchanged'

const CONFLICT_PREFIX = 'Write conflict:'

function readOnlyReason(file: FileContent): EditorReadOnlyReason | undefined {
  if (file.truncated) return 'truncated'
  if (!file.revision) return 'unversioned'
  return undefined
}

/**
 * Per-document save state. One instance lives beside the cached Monaco model,
 * so dirty text and in-flight work survive pane and preview-mode remounts.
 */
export class VersionedEditorSave {
  private content: string
  private bufferVersion: number
  private savedVersion: number
  private sourceEpoch: number
  private observedSourceEpoch: number
  private revision: string | undefined
  private phase: EditorSavePhase
  private error: string | undefined
  private readonlyReason: EditorReadOnlyReason | undefined
  private savedAt: number | undefined
  private externalConflict = false
  private mutationLocks = 0
  private inFlight: Promise<EditorSaveSnapshot> | null = null
  private readonly listeners = new Set<(snapshot: EditorSaveSnapshot) => void>()
  private readonly write: EditorSaveOptions['write']
  private readonly onSaveAck: EditorSaveOptions['onSaveAck']
  private readonly now: () => number

  constructor(options: EditorSaveOptions) {
    const initialBufferVersion = options.initialBufferVersion ?? 0
    const recovery = options.recovery
    this.content = recovery?.content ?? options.initial.content
    this.bufferVersion = recovery ? Math.max(initialBufferVersion, recovery.bufferVersion) : initialBufferVersion
    this.savedVersion = recovery ? Math.max(0, this.bufferVersion - 1) : this.bufferVersion
    this.sourceEpoch = options.sourceEpoch
    this.observedSourceEpoch = options.sourceEpoch
    this.revision = recovery?.originalRevision ?? options.initial.revision
    this.readonlyReason = readOnlyReason(options.initial)
    if (recovery && this.readonlyReason) {
      this.phase = 'readonly'
      this.error = 'Recovered text is preserved, but the current disk snapshot cannot be written safely.'
    } else if (recovery && options.initial.revision !== recovery.originalRevision) {
      this.externalConflict = true
      this.phase = 'conflict'
      this.error = 'File changed on disk since this recovery checkpoint was created.'
    } else {
      this.phase = this.readonlyReason ? 'readonly' : recovery ? 'dirty' : 'clean'
    }
    this.write = options.write
    this.onSaveAck = options.onSaveAck
    this.now = options.now ?? Date.now
  }

  snapshot(): EditorSaveSnapshot {
    return {
      phase: this.phase,
      content: this.content,
      bufferVersion: this.bufferVersion,
      savedVersion: this.savedVersion,
      sourceEpoch: this.sourceEpoch,
      ...(this.revision ? { revision: this.revision } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(this.readonlyReason ? { readOnlyReason: this.readonlyReason } : {}),
      ...(this.savedAt !== undefined ? { savedAt: this.savedAt } : {})
    }
  }

  subscribe(listener: (snapshot: EditorSaveSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  isWritable(): boolean {
    return this.readonlyReason === undefined && this.mutationLocks === 0
  }

  /** Freeze Monaco edits while a filesystem/git operation flushes and mutates the backing file. */
  beginMutationLock(): () => void {
    this.mutationLocks += 1
    this.emit()
    let released = false
    return () => {
      if (released) return
      released = true
      this.mutationLocks -= 1
      this.emit()
    }
  }

  isDirty(): boolean {
    return this.bufferVersion !== this.savedVersion || this.externalConflict
  }

  canDispose(): boolean {
    return this.inFlight === null && !this.isDirty() && this.phase !== 'failed' && this.phase !== 'conflict'
  }

  /** Monaco user edit. Read-only documents reject the transition. */
  edit(content: string, modelVersion?: number): boolean {
    if (!this.isWritable() || content === this.content) return false
    this.content = content
    const nextVersion = modelVersion ?? this.bufferVersion + 1
    this.bufferVersion = nextVersion > this.bufferVersion ? nextVersion : this.bufferVersion + 1
    if (!this.externalConflict) {
      this.phase = 'dirty'
      this.error = undefined
    }
    this.savedAt = undefined
    this.emit()
    return true
  }

  /**
   * Observe a store/agent source epoch. Clean models adopt it; dirty models
   * enter conflict without replacing their authoritative buffer.
   */
  observeExternal(file: FileContent, sourceEpoch: number): ExternalUpdateResult {
    if (sourceEpoch <= this.observedSourceEpoch) return 'unchanged'
    this.observedSourceEpoch = sourceEpoch

    if (this.isDirty() || this.inFlight !== null) {
      this.externalConflict = true
      this.phase = 'conflict'
      this.error = 'File changed on disk while this editor had unsaved changes.'
      this.emit()
      return 'conflict'
    }

    this.replaceWith(file, sourceEpoch)
    return 'adopted'
  }

  /** Explicit destructive reload after the user chooses to discard local edits. */
  reload(file: FileContent, sourceEpoch: number): boolean {
    const reason = readOnlyReason(file)
    if (reason) {
      this.externalConflict = true
      this.phase = 'conflict'
      this.error = reason === 'truncated'
        ? 'Reload refused because only a truncated file prefix was returned.'
        : 'Reload refused because the host did not return a guarded file revision.'
      this.emit()
      return false
    }
    this.externalConflict = false
    this.replaceWith(file, sourceEpoch)
    return true
  }
  reportReloadFailure(error: unknown): void {
    if (this.phase !== 'failed') this.phase = 'conflict'
    this.error = error instanceof Error ? error.message : String(error)
    this.emit()
  }

  /** Serialize writes; edits made during save A are written only after A acknowledges. */
  flush(): Promise<EditorSaveSnapshot> {
    if (this.readonlyReason !== undefined || this.externalConflict || !this.isDirty()) {
      return Promise.resolve(this.snapshot())
    }
    if (this.inFlight) return this.inFlight
    this.inFlight = this.drain().finally(() => {
      this.inFlight = null
      this.emit()
    })
    return this.inFlight
  }

  private async drain(): Promise<EditorSaveSnapshot> {
    while (this.bufferVersion !== this.savedVersion && !this.externalConflict) {
      const expectedRevision = this.revision
      if (!expectedRevision) {
        this.readonlyReason = 'unversioned'
        this.phase = 'readonly'
        this.error = 'The host did not return a revision, so further writes are disabled.'
        this.emit()
        break
      }

      const content = this.content
      const version = this.bufferVersion
      const sourceEpoch = this.sourceEpoch
      this.phase = 'saving'
      this.error = undefined
      this.emit()

      let saved: FileContent
      try {
        saved = await this.write(content, expectedRevision)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.error = message
        this.phase = message.includes(CONFLICT_PREFIX) ? 'conflict' : 'failed'
        if (this.phase === 'conflict') this.externalConflict = true
        this.emit()
        break
      }

      this.savedVersion = version
      this.revision = saved.revision
      this.onSaveAck?.({
        saved,
        sourceEpoch,
        savedVersion: version,
        currentBufferVersion: this.bufferVersion
      })

      if (!saved.revision) {
        this.readonlyReason = 'unversioned'
        this.phase = 'readonly'
        this.error = 'The write succeeded, but the host did not return a revision; further writes are disabled.'
        this.emit()
        break
      }

      if (this.externalConflict) {
        this.phase = 'conflict'
      } else if (this.bufferVersion === this.savedVersion) {
        this.phase = 'saved'
        this.savedAt = this.now()
      } else {
        this.phase = 'dirty'
      }
      this.emit()
    }
    return this.snapshot()
  }

  private replaceWith(file: FileContent, sourceEpoch: number): void {
    this.content = file.content
    this.bufferVersion += 1
    this.savedVersion = this.bufferVersion
    this.sourceEpoch = sourceEpoch
    this.observedSourceEpoch = sourceEpoch
    this.revision = file.revision
    this.readonlyReason = readOnlyReason(file)
    this.phase = this.readonlyReason ? 'readonly' : 'clean'
    this.error = undefined
    this.savedAt = undefined
    this.emit()
  }

  private emit(): void {
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}
