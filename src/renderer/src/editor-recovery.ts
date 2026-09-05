import {
  editorRecoveryKey,
  parseEditorRecoveryCheckpointRequest,
  parseEditorRecoveryEntry,
  parseEditorRecoveryTarget,
  type EditorRecoveryCheckpointRequest,
  type EditorRecoveryEntry,
  type EditorRecoveryTarget,
  type RecoveryApi
} from '@shared/editor-recovery'

export type EditorRecoveryPersistencePhase = 'idle' | 'pending' | 'protected' | 'error'

export type EditorRecoveryPersistenceStatus = {
  phase: EditorRecoveryPersistencePhase
  error?: string
}

export type EditorRecoveryControllerSnapshot = {
  entries: readonly EditorRecoveryEntry[]
  loading: boolean
  error?: string
  revision: number
}

type RecoveryDraft = Omit<EditorRecoveryCheckpointRequest, 'expectedCheckpointId'>

type RecoveryChannel = {
  workspacePath: string
  relPath: string
  stored?: EditorRecoveryEntry
  desired?: RecoveryDraft
  savedThrough: number
  checkpointQueued: boolean
  tail: Promise<void>
  status: EditorRecoveryPersistenceStatus
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Renderer-side serializer. One channel per document coalesces edits, orders
 * checkpoint/clear IPC, and keeps compare-and-swap tokens out of pane code.
 */
export class EditorRecoveryController {
  private readonly api: RecoveryApi
  private readonly entries = new Map<string, EditorRecoveryEntry>()
  private readonly channels = new Map<string, RecoveryChannel>()
  private readonly aliases = new Map<string, string>()
  private readonly listeners = new Set<() => void>()
  private loadPromise: Promise<void> | null = null
  private loaded = false
  private loadError: string | undefined
  private revision = 0
  private snapshot: EditorRecoveryControllerSnapshot = { entries: [], loading: false, revision: 0 }

  constructor(api: RecoveryApi) {
    this.api = api
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot(): EditorRecoveryControllerSnapshot {
    return this.snapshot
  }

  statusFor(value: EditorRecoveryTarget): EditorRecoveryPersistenceStatus {
    const target = parseEditorRecoveryTarget(value)
    const requestedKey = editorRecoveryKey(target.workspacePath, target.relPath)
    const channel = this.channels.get(this.aliases.get(requestedKey) ?? requestedKey)
    return channel?.status ?? { phase: 'idle' }
  }
  /** Keeps buffer versions monotonic across model disposal within this renderer lifetime. */
  bufferVersionFloorFor(value: EditorRecoveryTarget): number {
    const target = parseEditorRecoveryTarget(value)
    const channel = this.channelForTarget(target)
    return Math.max(channel.savedThrough, channel.stored?.bufferVersion ?? 0, channel.desired?.bufferVersion ?? 0)
  }

  async load(): Promise<void> {
    if (this.loaded) return
    if (this.loadPromise) return this.loadPromise
    this.loadError = undefined
    this.publish(true)
    this.loadPromise = this.api.editorRecoveryList().then((entries) => {
      const seen = new Set<string>()
      for (let index = 0; index < entries.length; index += 1) {
        const entry = parseEditorRecoveryEntry(entries[index], `recovery list entry ${index}`)
        const key = editorRecoveryKey(entry.workspacePath, entry.relPath)
        if (seen.has(key)) throw new Error(`Recovery list contains duplicate document: ${entry.relPath}`)
        seen.add(key)
        this.entries.set(key, entry)
        this.channelFor(entry.workspacePath, entry.relPath).stored = entry
      }
      this.loaded = true
    }).catch((error: unknown) => {
      this.loadError = `Editor recovery is unavailable: ${errorMessage(error)}`
      throw error
    }).finally(() => {
      this.loadPromise = null
      this.publish(false)
    })
    return this.loadPromise
  }

  async refresh(): Promise<void> {
    await this.waitForAll()
    this.entries.clear()
    this.aliases.clear()
    this.channels.clear()
    this.loaded = false
    await this.load()
  }

  /** Resolves through the main-process workspace authority so symlink spellings cannot fork a draft. */
  async draftFor(value: EditorRecoveryTarget): Promise<EditorRecoveryEntry | undefined> {
    const target = parseEditorRecoveryTarget(value)
    try {
      await this.load()
    } catch {
      return undefined
    }
    const requestedKey = editorRecoveryKey(target.workspacePath, target.relPath)
    const aliased = this.aliases.get(requestedKey)
    if (aliased) return this.entries.get(aliased)
    const exact = this.entries.get(requestedKey)
    if (exact) {
      this.aliases.set(requestedKey, requestedKey)
      return exact
    }

    try {
      const result = await this.api.editorRecoveryGet(target)
      if (!result) {
        this.aliases.set(requestedKey, requestedKey)
        return undefined
      }
      const entry = parseEditorRecoveryEntry(result)
      const canonicalKey = editorRecoveryKey(entry.workspacePath, entry.relPath)
      this.aliases.set(requestedKey, canonicalKey)
      this.entries.set(canonicalKey, entry)
      this.channelFor(entry.workspacePath, entry.relPath).stored = entry
      this.publish(false)
      return entry
    } catch (error) {
      const channel = this.channelFor(target.workspacePath, target.relPath)
      channel.status = { phase: 'error', error: `Recovery lookup failed: ${errorMessage(error)}` }
      this.publish(false)
      return undefined
    }
  }

  async checkpoint(value: RecoveryDraft): Promise<void> {
    const request = parseEditorRecoveryCheckpointRequest(value)
    await this.load()
    await this.draftFor({ workspacePath: request.workspacePath, relPath: request.relPath })
    const channel = this.channelForTarget(request)
    const canonicalRequest: RecoveryDraft = {
      workspacePath: channel.stored?.workspacePath ?? request.workspacePath,
      relPath: channel.stored?.relPath ?? request.relPath,
      content: request.content,
      originalRevision: request.originalRevision,
      bufferVersion: request.bufferVersion,
      ...(request.viewState === undefined ? {} : { viewState: request.viewState })
    }
    if (canonicalRequest.bufferVersion <= channel.savedThrough) return
    if (!channel.desired || canonicalRequest.bufferVersion >= channel.desired.bufferVersion) {
      channel.desired = canonicalRequest
    }
    channel.status = { phase: 'pending' }
    this.publish(false)
    return this.queueCheckpoint(channel)
  }

  /** Called only for a save acknowledgement that covered the then-current buffer. */
  async acknowledgeSaved(value: EditorRecoveryTarget, savedVersion: number): Promise<void> {
    const target = parseEditorRecoveryTarget(value)
    if (!Number.isSafeInteger(savedVersion) || savedVersion < 1) throw new Error('savedVersion must be a positive safe integer')
    let channel = this.channelForTarget(target)
    channel.status = { phase: 'pending' }
    this.publish(false)
    try {
      await this.load()
    } catch (error) {
      channel.status = { phase: 'error', error: `Recovery cleanup failed: ${errorMessage(error)}` }
      this.publish(false)
      throw error
    }
    const loadedChannel = this.channelForTarget(target)
    if (loadedChannel !== channel) {
      channel.status = channel.stored ? { phase: 'protected' } : { phase: 'idle' }
      channel = loadedChannel
      channel.status = { phase: 'pending' }
      this.publish(false)
    }
    channel.savedThrough = Math.max(channel.savedThrough, savedVersion)
    if (channel.desired && channel.desired.bufferVersion <= channel.savedThrough) channel.desired = undefined
    return this.enqueue(channel, async () => {
      const current = channel.stored
      if (!current || current.bufferVersion > channel.savedThrough) {
        channel.status = current ? { phase: 'protected' } : { phase: 'idle' }
        this.publish(false)
        return
      }
      try {
        const result = await this.api.editorRecoveryClear({
          workspacePath: current.workspacePath,
          relPath: current.relPath,
          expectedCheckpointId: current.checkpointId
        })
        if (result.cleared) {
          this.removeStored(channel, current.checkpointId)
        } else if (result.current) {
          this.setStored(channel, parseEditorRecoveryEntry(result.current))
        } else {
          this.removeStored(channel, current.checkpointId)
        }
        channel.status = channel.stored ? { phase: 'protected' } : { phase: 'idle' }
        this.publish(false)
      } catch (error) {
        channel.status = { phase: 'error', error: `Recovery cleanup failed: ${errorMessage(error)}` }
        this.publish(false)
        throw error
      }
    })
  }

  /** Clears only the exact buffer version the editor just confirmed it discarded. */
  async discardDocument(value: EditorRecoveryTarget, maximumBufferVersion: number): Promise<boolean> {
    const target = parseEditorRecoveryTarget(value)
    if (!Number.isSafeInteger(maximumBufferVersion) || maximumBufferVersion < 1) {
      throw new Error('maximumBufferVersion must be a positive safe integer')
    }
    await this.load()
    await this.draftFor(target)
    const channel = this.channelForTarget(target)
    if (channel.desired && channel.desired.bufferVersion <= maximumBufferVersion) channel.desired = undefined
    return this.enqueue(channel, async () => {
      const current = channel.stored
      if (channel.desired || (current && current.bufferVersion > maximumBufferVersion)) {
        channel.status = { phase: 'error', error: 'A newer recovery checkpoint was preserved; confirm discard again.' }
        this.publish(false)
        return false
      }
      if (!current) {
        channel.status = { phase: 'idle' }
        this.publish(false)
        return true
      }
      channel.status = { phase: 'pending' }
      this.publish(false)
      try {
        const result = await this.api.editorRecoveryClear({
          workspacePath: current.workspacePath,
          relPath: current.relPath,
          expectedCheckpointId: current.checkpointId
        })
        if (!result.cleared && result.current) {
          this.setStored(channel, parseEditorRecoveryEntry(result.current))
          channel.status = { phase: 'error', error: 'A newer recovery checkpoint was preserved; confirm discard again.' }
          this.publish(false)
          return false
        }
        this.removeStored(channel, current.checkpointId)
        channel.status = { phase: 'idle' }
        this.publish(false)
        return true
      } catch (error) {
        channel.status = { phase: 'error', error: `Recovery discard failed: ${errorMessage(error)}` }
        this.publish(false)
        throw error
      }
    })
  }
  /** Explicit, user-confirmed discard. A stale panel row never deletes a newer checkpoint. */
  async discard(entryValue: EditorRecoveryEntry): Promise<boolean> {
    const entry = parseEditorRecoveryEntry(entryValue)
    await this.load()
    const channel = this.channelFor(entry.workspacePath, entry.relPath)
    return this.enqueue(channel, async () => {
      if (channel.desired || channel.stored?.checkpointId !== entry.checkpointId) return false
      channel.status = { phase: 'pending' }
      this.publish(false)
      try {
        const result = await this.api.editorRecoveryClear({
          workspacePath: entry.workspacePath,
          relPath: entry.relPath,
          expectedCheckpointId: entry.checkpointId
        })
        if (!result.cleared) {
          if (result.current) this.setStored(channel, parseEditorRecoveryEntry(result.current))
          else this.removeStored(channel, entry.checkpointId)
          channel.status = channel.stored ? { phase: 'protected' } : { phase: 'idle' }
          this.publish(false)
          return false
        }
        this.removeStored(channel, entry.checkpointId)
        channel.status = { phase: 'idle' }
        this.publish(false)
        return true
      } catch (error) {
        channel.status = { phase: 'error', error: `Recovery discard failed: ${errorMessage(error)}` }
        this.publish(false)
        throw error
      }
    })
  }

  async retry(value: EditorRecoveryTarget): Promise<void> {
    const target = parseEditorRecoveryTarget(value)
    await this.load()
    const channel = this.channelForTarget(target)
    channel.status = { phase: 'pending' }
    this.publish(false)
    if (channel.desired) return this.queueCheckpoint(channel)
    if (channel.stored && channel.stored.bufferVersion <= channel.savedThrough) {
      return this.acknowledgeSaved({ workspacePath: channel.workspacePath, relPath: channel.relPath }, channel.savedThrough)
    }
    channel.status = channel.stored ? { phase: 'protected' } : { phase: 'idle' }
    this.publish(false)
  }

  async waitForDocument(value: EditorRecoveryTarget): Promise<void> {
    const target = parseEditorRecoveryTarget(value)
    try {
      await this.load()
    } catch {
      return
    }
    const channel = this.channelForTarget(target)
    await channel.tail
  }

  async waitForAll(): Promise<void> {
    try {
      await this.load()
    } catch {
      return
    }
    await Promise.all([...this.channels.values()].map((channel) => channel.tail))
  }

  private queueCheckpoint(channel: RecoveryChannel): Promise<void> {
    if (channel.checkpointQueued) return channel.tail
    channel.checkpointQueued = true
    return this.enqueue(channel, async () => {
      try {
        while (channel.desired) {
          const candidate = channel.desired
          if (candidate.bufferVersion <= channel.savedThrough) {
            if (channel.desired === candidate) channel.desired = undefined
            continue
          }
          const stored = await this.api.editorRecoveryCheckpoint({
            ...candidate,
            ...(channel.stored === undefined ? {} : { expectedCheckpointId: channel.stored.checkpointId })
          })
          this.setStored(channel, parseEditorRecoveryEntry(stored))
          if (channel.desired === candidate) channel.desired = undefined
        }
        channel.status = channel.stored ? { phase: 'protected' } : { phase: 'idle' }
        this.publish(false)
      } catch (error) {
        channel.status = { phase: 'error', error: `Recovery checkpoint failed: ${errorMessage(error)}` }
        this.publish(false)
        throw error
      } finally {
        channel.checkpointQueued = false
      }
    })
  }

  private enqueue<T>(channel: RecoveryChannel, operation: () => Promise<T>): Promise<T> {
    const pending = channel.tail.then(operation, operation)
    channel.tail = pending.then(() => undefined, () => undefined)
    return pending
  }

  private channelForTarget(target: EditorRecoveryTarget): RecoveryChannel {
    const requestedKey = editorRecoveryKey(target.workspacePath, target.relPath)
    const canonicalKey = this.aliases.get(requestedKey) ?? requestedKey
    const existing = this.channels.get(canonicalKey)
    if (existing) return existing
    return this.channelFor(target.workspacePath, target.relPath)
  }

  private channelFor(workspacePath: string, relPath: string): RecoveryChannel {
    const key = editorRecoveryKey(workspacePath, relPath)
    const existing = this.channels.get(key)
    if (existing) return existing
    const channel: RecoveryChannel = {
      workspacePath,
      relPath,
      savedThrough: 0,
      checkpointQueued: false,
      tail: Promise.resolve(),
      status: { phase: this.entries.has(key) ? 'protected' : 'idle' },
      ...(this.entries.get(key) === undefined ? {} : { stored: this.entries.get(key) })
    }
    this.channels.set(key, channel)
    return channel
  }

  private setStored(channel: RecoveryChannel, entry: EditorRecoveryEntry): void {
    const previousKey = editorRecoveryKey(channel.workspacePath, channel.relPath)
    const nextKey = editorRecoveryKey(entry.workspacePath, entry.relPath)
    channel.workspacePath = entry.workspacePath
    channel.relPath = entry.relPath
    channel.stored = entry
    this.entries.delete(previousKey)
    this.entries.set(nextKey, entry)
    if (previousKey !== nextKey) {
      this.channels.delete(previousKey)
      this.channels.set(nextKey, channel)
      this.aliases.set(previousKey, nextKey)
    }
  }

  private removeStored(channel: RecoveryChannel, checkpointId: string): void {
    if (channel.stored?.checkpointId !== checkpointId) return
    this.entries.delete(editorRecoveryKey(channel.stored.workspacePath, channel.stored.relPath))
    channel.stored = undefined
  }

  private publish(loading: boolean): void {
    this.revision += 1
    this.snapshot = {
      entries: [...this.entries.values()].sort(
        (left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.relPath.localeCompare(right.relPath)
      ),
      loading,
      revision: this.revision,
      ...(this.loadError === undefined ? {} : { error: this.loadError })
    }
    for (const listener of this.listeners) listener()
  }
}

let defaultController: EditorRecoveryController | undefined

/** Parent may call this eagerly; editor panes also initialize it lazily. */
export function startEditorRecoveryController(api: RecoveryApi = window.donwells): EditorRecoveryController {
  defaultController ??= new EditorRecoveryController(api)
  void defaultController.load().catch(() => undefined)
  return defaultController
}

export function getEditorRecoveryController(): EditorRecoveryController {
  return defaultController ?? startEditorRecoveryController()
}
