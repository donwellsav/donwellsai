import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EDITOR_RECOVERY_MAX_CONTENT_BYTES,
  EDITOR_RECOVERY_MAX_ENTRIES,
  EDITOR_RECOVERY_SCHEMA_VERSION,
  parseEditorRecoveryDocument,
  type EditorRecoveryCheckpointRequest,
  type EditorRecoveryEntry,
  type RecoveryApi
} from '../src/shared/editor-recovery'
import {
  EditorRecoveryLoadError,
  EditorRecoveryService,
  EditorRecoveryStore
} from '../src/main/editor-recovery'
import { EditorRecoveryController } from '../src/renderer/src/editor-recovery'

const temporaryDirectories: string[] = []

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `donwells-recovery-${label}-`))
  temporaryDirectories.push(directory)
  return directory
}

function checkpoint(workspacePath: string, relPath = 'notes.txt', content = 'unsaved text'): EditorRecoveryCheckpointRequest {
  return {
    workspacePath,
    relPath,
    content,
    originalRevision: 'sha256:base',
    bufferVersion: 2,
    viewState: {
      selectionStartLineNumber: 2,
      selectionStartColumn: 3,
      positionLineNumber: 2,
      positionColumn: 8,
      scrollTop: 240,
      scrollLeft: 12
    }
  }
}

function entryFrom(
  request: EditorRecoveryCheckpointRequest,
  checkpointId: string,
  updatedAt = '2026-09-05T00:00:00.000Z'
): EditorRecoveryEntry {
  return {
    checkpointId,
    workspacePath: request.workspacePath,
    relPath: request.relPath,
    content: request.content,
    originalRevision: request.originalRevision,
    bufferVersion: request.bufferVersion,
    updatedAt,
    ...(request.viewState === undefined ? {} : { viewState: request.viewState })
  }
}

async function waitForControllerPublish(controller: EditorRecoveryController, afterRevision: number): Promise<void> {
  if (controller.getSnapshot().revision > afterRevision) return
  const published = Promise.withResolvers<void>()
  const unsubscribe = controller.subscribe(() => {
    if (controller.getSnapshot().revision > afterRevision) published.resolve()
  })
  try {
    await published.promise
  } finally {
    unsubscribe()
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('editor recovery authority', () => {
  it('survives a service restart with original revision and editor view intact', () => {
    const userData = temporaryDirectory('restart')
    const workspace = join(userData, 'workspace')
    mkdirSync(workspace)
    let id = 0
    const first = new EditorRecoveryStore(userData, {
      createId: () => `checkpoint_${++id}`,
      now: () => new Date('2026-09-05T01:02:03.000Z')
    })

    const saved = first.checkpoint(checkpoint(realpathSync(workspace)))
    const restarted = new EditorRecoveryStore(userData)

    expect(restarted.list()).toEqual([saved])
    expect(restarted.list()[0]).toMatchObject({
      content: 'unsaved text',
      originalRevision: 'sha256:base',
      bufferVersion: 2,
      viewState: { positionLineNumber: 2, positionColumn: 8, scrollTop: 240 }
    })
    if (process.platform !== 'win32') {
      expect(statSync(join(userData, 'recovery')).mode & 0o777).toBe(0o700)
      expect(statSync(first.path).mode & 0o777).toBe(0o600)
    }
  })

  it('preserves a corrupt store instead of replacing it during startup', () => {
    const userData = temporaryDirectory('corrupt')
    const recoveryDirectory = join(userData, 'recovery')
    const path = join(recoveryDirectory, 'editor-buffers.json')
    mkdirSync(recoveryDirectory)
    writeFileSync(path, '{broken json', 'utf8')

    expect(() => new EditorRecoveryStore(userData)).toThrow(EditorRecoveryLoadError)
    const service = new EditorRecoveryService(userData, { resolveWorkspace: async (workspacePath) => workspacePath })
    expect(() => service.list()).toThrow(EditorRecoveryLoadError)
    expect(readFileSync(path, 'utf8')).toBe('{broken json')
  })

  it('fails closed for traversal, unauthorized workspaces, symlinked storage, and capacity overflow', async () => {
    const userData = temporaryDirectory('confinement')
    const workspace = join(userData, 'workspace')
    mkdirSync(workspace)
    const resolver = vi.fn(async (requested: string) => {
      if (requested !== workspace) throw new Error('workspace not registered')
      return realpathSync(workspace)
    })
    const service = new EditorRecoveryService(userData, { resolveWorkspace: resolver })

    await expect(service.checkpoint(checkpoint(workspace, '../outside.txt'))).rejects.toThrow('stay within the workspace')
    await expect(service.checkpoint(checkpoint(workspace, 'bad\0path'))).rejects.toThrow()
    await expect(service.checkpoint(checkpoint(join(userData, 'unknown')))).rejects.toThrow('workspace not registered')
    expect(service.list()).toEqual([])

    expect(() => service.store.checkpoint(checkpoint(workspace, 'large.txt', 'x'.repeat(EDITOR_RECOVERY_MAX_CONTENT_BYTES + 1))))
      .toThrow('recovery limit')
    expect(() => parseEditorRecoveryDocument({
      schemaVersion: EDITOR_RECOVERY_SCHEMA_VERSION,
      entries: Array.from({ length: EDITOR_RECOVERY_MAX_ENTRIES + 1 })
    })).toThrow('at most')

    if (process.platform !== 'win32') {
      const symlinkUserData = temporaryDirectory('symlink')
      const external = temporaryDirectory('external')
      symlinkSync(external, join(symlinkUserData, 'recovery'), 'dir')
      expect(() => new EditorRecoveryStore(symlinkUserData)).toThrow('private regular directory')
      expect(existsSync(service.store.path)).toBe(false)
    }
  })
})

describe('renderer recovery serialization', () => {
  it('keeps a newer checkpoint when an older save acknowledgement arrives late', async () => {
    const workspacePath = '/workspace'
    const target = { workspacePath, relPath: 'notes.txt' }
    const firstWriteStarted = Promise.withResolvers<void>()
    const secondWriteStarted = Promise.withResolvers<void>()
    const firstWrite = Promise.withResolvers<EditorRecoveryEntry>()
    const secondWrite = Promise.withResolvers<EditorRecoveryEntry>()
    const checkpointRequests: EditorRecoveryCheckpointRequest[] = []
    const clear = vi.fn(async () => ({ cleared: true as const }))
    const api: RecoveryApi = {
      editorRecoveryList: async () => [],
      editorRecoveryGet: async () => undefined,
      editorRecoveryCheckpoint: async (request) => {
        checkpointRequests.push(request)
        if (checkpointRequests.length === 1) {
          firstWriteStarted.resolve()
          return firstWrite.promise
        }
        secondWriteStarted.resolve()
        return secondWrite.promise
      },
      editorRecoveryClear: clear
    }
    const controller = new EditorRecoveryController(api)
    await controller.load()

    const versionTwo = checkpoint(workspacePath, target.relPath, 'A')
    const firstPending = controller.checkpoint(versionTwo)
    await firstWriteStarted.promise

    let revision = controller.getSnapshot().revision
    const oldAcknowledgement = controller.acknowledgeSaved(target, 2)
    await waitForControllerPublish(controller, revision)

    revision = controller.getSnapshot().revision
    const versionThree = { ...versionTwo, content: 'AB', bufferVersion: 3 }
    const secondPending = controller.checkpoint(versionThree)
    await waitForControllerPublish(controller, revision)

    firstWrite.resolve(entryFrom(versionTwo, 'checkpoint_1'))
    await secondWriteStarted.promise
    expect(checkpointRequests[1]).toMatchObject({
      content: 'AB',
      bufferVersion: 3,
      expectedCheckpointId: 'checkpoint_1'
    })
    secondWrite.resolve(entryFrom(versionThree, 'checkpoint_2', '2026-09-05T00:00:01.000Z'))

    await Promise.all([firstPending, secondPending, oldAcknowledgement])
    expect(clear).not.toHaveBeenCalled()
    expect(controller.getSnapshot().entries).toMatchObject([
      { checkpointId: 'checkpoint_2', content: 'AB', bufferVersion: 3 }
    ])

    await controller.acknowledgeSaved(target, 3)
    expect(clear).toHaveBeenCalledWith({
      workspacePath,
      relPath: target.relPath,
      expectedCheckpointId: 'checkpoint_2'
    })
    expect(controller.getSnapshot().entries).toEqual([])
  })
  it('refuses a stale confirmed discard when a newer recovered buffer exists', async () => {
    const request = checkpoint('/workspace', 'notes.txt', 'newer text')
    const current = entryFrom({ ...request, bufferVersion: 4 }, 'checkpoint_newer')
    const clear = vi.fn(async () => ({ cleared: true as const }))
    const api: RecoveryApi = {
      editorRecoveryList: async () => [current],
      editorRecoveryGet: async () => current,
      editorRecoveryCheckpoint: async (value) => entryFrom(value, 'unused'),
      editorRecoveryClear: clear
    }
    const controller = new EditorRecoveryController(api)
    await controller.load()

    await expect(controller.discardDocument({ workspacePath: request.workspacePath, relPath: request.relPath }, 3))
      .resolves.toBe(false)
    expect(clear).not.toHaveBeenCalled()
    expect(controller.getSnapshot().entries).toEqual([current])
    expect(controller.statusFor({ workspacePath: request.workspacePath, relPath: request.relPath })).toEqual({
      phase: 'error',
      error: 'A newer recovery checkpoint was preserved; confirm discard again.'
    })
  })

  it('reports checkpoint failures and retains the unsaved candidate for retry', async () => {
    let available = false
    const request = checkpoint('/workspace')
    const api: RecoveryApi = {
      editorRecoveryList: async () => [],
      editorRecoveryGet: async () => undefined,
      editorRecoveryCheckpoint: async (value) => {
        if (!available) throw new Error('disk full')
        return entryFrom(value, 'checkpoint_retry')
      },
      editorRecoveryClear: async () => ({ cleared: true })
    }
    const controller = new EditorRecoveryController(api)

    await expect(controller.checkpoint(request)).rejects.toThrow('disk full')
    expect(controller.statusFor({ workspacePath: request.workspacePath, relPath: request.relPath })).toEqual({
      phase: 'error',
      error: 'Recovery checkpoint failed: disk full'
    })

    available = true
    await controller.retry({ workspacePath: request.workspacePath, relPath: request.relPath })
    expect(controller.statusFor({ workspacePath: request.workspacePath, relPath: request.relPath })).toEqual({ phase: 'protected' })
    expect(controller.getSnapshot().entries[0]).toMatchObject({ content: 'unsaved text' })
  })
  it('retries recovery cleanup after the disk save has already succeeded', async () => {
    const target = { workspacePath: '/workspace', relPath: 'notes.txt' }
    const current = entryFrom(checkpoint(target.workspacePath, target.relPath), 'checkpoint_cleanup')
    let available = false
    const clear = vi.fn(async () => {
      if (!available) throw new Error('store unavailable')
      return { cleared: true as const }
    })
    const api: RecoveryApi = {
      editorRecoveryList: async () => [current],
      editorRecoveryGet: async () => current,
      editorRecoveryCheckpoint: async (value) => entryFrom(value, 'unused'),
      editorRecoveryClear: clear
    }
    const controller = new EditorRecoveryController(api)
    await controller.load()

    await expect(controller.acknowledgeSaved(target, current.bufferVersion)).rejects.toThrow()
    expect(controller.getSnapshot().entries).toEqual([current])

    available = true
    await controller.retry(target)
    expect(clear).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot().entries).toEqual([])
    expect(controller.statusFor(target)).toEqual({ phase: 'idle' })
    const nextVersion = controller.bufferVersionFloorFor(target) + 1
    await controller.checkpoint({
      ...checkpoint(target.workspacePath, target.relPath, 'edited after reopen'),
      bufferVersion: nextVersion
    })
    expect(controller.getSnapshot().entries[0]).toMatchObject({
      content: 'edited after reopen',
      bufferVersion: nextVersion
    })
  })
})
