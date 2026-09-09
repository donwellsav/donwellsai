import { describe, expect, it, vi } from 'vitest'
import { VersionedEditorSave, type EditorSaveAck } from '../src/renderer/src/editor-save'
import {
  cacheEditorDocument,
  disposePreviewModel,
  flushAllPreviewModels,
  type EditorModel
} from '../src/renderer/src/editor-models'
import type { FileContent } from '../src/shared/types'

function file(content: string, revision?: string, truncated = false): FileContent {
  return { path: 'notes.txt', content, bytes: Buffer.byteLength(content), truncated, ...(revision ? { revision } : {}) }
}

function disposableModel(): EditorModel {
  const model: EditorModel = Object.create(null)
  model.dispose = vi.fn()
  return model
}

describe('versioned editor saves', () => {
  it('serializes writes and never lets save A acknowledge over newer buffer AB', async () => {
    const first = Promise.withResolvers<FileContent>()
    const second = Promise.withResolvers<FileContent>()
    const secondStarted = Promise.withResolvers<void>()
    const acknowledgements: EditorSaveAck[] = []
    let activeWrites = 0
    let maximumActiveWrites = 0
    const write = vi.fn((_content: string, _expectedRevision: string) => {
      activeWrites += 1
      maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites)
      const callNumber = write.mock.calls.length
      if (callNumber === 2) secondStarted.resolve()
      const pending = callNumber === 1 ? first.promise : second.promise
      return pending.finally(() => {
        activeWrites -= 1
      })
    })
    const save = new VersionedEditorSave({
      initial: file('', 'r0'),
      sourceEpoch: 7,
      initialBufferVersion: 1,
      write,
      onSaveAck: (ack) => acknowledgements.push(ack),
      now: () => 1234
    })

    save.edit('A', 2)
    const flushing = save.flush()
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenLastCalledWith('A', 'r0')

    save.edit('AB', 3)
    first.resolve(file('A', 'r1'))
    await first.promise
    await Promise.resolve()
    await secondStarted.promise
    expect(write).toHaveBeenLastCalledWith('AB', 'r1')
    expect(acknowledgements[0]).toMatchObject({
      saved: { content: 'A', revision: 'r1' },
      sourceEpoch: 7,
      savedVersion: 2,
      currentBufferVersion: 3
    })
    expect(save.snapshot().content).toBe('AB')

    second.resolve(file('AB', 'r2'))
    await expect(flushing).resolves.toMatchObject({ phase: 'saved', content: 'AB', revision: 'r2', savedAt: 1234 })
    expect(maximumActiveWrites).toBe(1)
    expect(save.canDispose()).toBe(true)
  })

  it('keeps a dirty model authoritative when a newer store epoch arrives', async () => {
    const write = vi.fn(async () => file('local edit', 'r2'))
    const save = new VersionedEditorSave({ initial: file('base', 'r1'), sourceEpoch: 1, write })

    save.edit('local edit', 2)
    expect(save.observeExternal(file('agent edit', 'agent-r2'), 2)).toBe('conflict')
    expect(save.snapshot()).toMatchObject({ phase: 'conflict', content: 'local edit', sourceEpoch: 1 })
    await save.flush()
    expect(write).not.toHaveBeenCalled()
    expect(save.canDispose()).toBe(false)

    expect(save.reload(file('agent edit', 'agent-r2'), 2)).toBe(true)
    expect(save.snapshot()).toMatchObject({ phase: 'clean', content: 'agent edit', sourceEpoch: 2 })
    expect(save.canDispose()).toBe(true)
  })

  it('retains failed text for retry instead of becoming disposable', async () => {
    let fail = true
    const write = vi.fn(async (content: string) => {
      if (fail) throw new Error('disk temporarily unavailable')
      return file(content, 'r2')
    })
    const save = new VersionedEditorSave({ initial: file('base', 'r1'), sourceEpoch: 1, write })

    save.edit('irreplaceable edit', 2)
    await expect(save.flush()).resolves.toMatchObject({ phase: 'failed', content: 'irreplaceable edit' })
    expect(save.canDispose()).toBe(false)

    fail = false
    await expect(save.flush()).resolves.toMatchObject({ phase: 'saved', content: 'irreplaceable edit', revision: 'r2' })
    expect(write).toHaveBeenCalledTimes(2)
    expect(save.canDispose()).toBe(true)
  })

  it('never edits or writes truncated and unversioned reads', async () => {
    for (const initial of [file('prefix', undefined, true), file('legacy host')]) {
      const write = vi.fn(async () => file('should not write', 'r2'))
      const save = new VersionedEditorSave({ initial, sourceEpoch: 1, write })
      expect(save.snapshot()).toMatchObject({ phase: 'readonly', content: initial.content })
      expect(save.edit('replacement', 2)).toBe(false)
      await save.flush()
      expect(write).not.toHaveBeenCalled()
      expect(save.canDispose()).toBe(true)
    }
  })

  it('stops after an acknowledgement without a revision and preserves a newer edit', async () => {
    const pending = Promise.withResolvers<FileContent>()
    const write = vi.fn(() => pending.promise)
    const save = new VersionedEditorSave({ initial: file('', 'r0'), sourceEpoch: 1, write })

    save.edit('A', 2)
    const flushing = save.flush()
    save.edit('AB', 3)
    pending.resolve(file('A'))

    await expect(flushing).resolves.toMatchObject({
      phase: 'readonly',
      content: 'AB',
      readOnlyReason: 'unversioned'
    })
    expect(write).toHaveBeenCalledTimes(1)
    expect(save.canDispose()).toBe(false)
  })
  it('recovers a dirty buffer against the matching original disk revision', async () => {
    const write = vi.fn(async (content: string) => file(content, 'r2'))
    const save = new VersionedEditorSave({
      initial: file('disk base', 'r1'),
      sourceEpoch: 4,
      initialBufferVersion: 1,
      recovery: { content: 'recovered draft', originalRevision: 'r1', bufferVersion: 9 },
      write
    })

    expect(save.snapshot()).toMatchObject({
      phase: 'dirty',
      content: 'recovered draft',
      revision: 'r1',
      bufferVersion: 9,
      savedVersion: 8
    })
    await expect(save.flush()).resolves.toMatchObject({ phase: 'saved', revision: 'r2' })
    expect(write).toHaveBeenCalledWith('recovered draft', 'r1')
  })

  it('opens recovered text in conflict when disk changed after the checkpoint', async () => {
    const write = vi.fn(async (content: string) => file(content, 'r3'))
    const save = new VersionedEditorSave({
      initial: file('agent changed disk', 'r2'),
      sourceEpoch: 5,
      recovery: { content: 'irreplaceable recovered text', originalRevision: 'r1', bufferVersion: 7 },
      write
    })

    expect(save.snapshot()).toMatchObject({
      phase: 'conflict',
      content: 'irreplaceable recovered text',
      revision: 'r1',
      error: 'File changed on disk since this recovery checkpoint was created.'
    })
    await save.flush()
    expect(write).not.toHaveBeenCalled()
    expect(save.canDispose()).toBe(false)
  })
})
describe('editor close flush', () => {
  it('rechecks every document after concurrent flushes before allowing teardown', async () => {
    const secondWrite = Promise.withResolvers<FileContent>()
    const firstGateChecked = Promise.withResolvers<void>()
    const firstSave = new VersionedEditorSave({
      initial: file('base-a', 'a0'),
      sourceEpoch: 1,
      write: async (content) => file(content, 'a1')
    })
    const secondSave = new VersionedEditorSave({
      initial: file('base-b', 'b0'),
      sourceEpoch: 1,
      write: () => secondWrite.promise
    })
    const originalCanDispose = firstSave.canDispose.bind(firstSave)
    firstSave.canDispose = () => {
      const disposable = originalCanDispose()
      if (disposable) firstGateChecked.resolve()
      return disposable
    }
    cacheEditorDocument('/close-race', 'a.txt', { model: disposableModel(), save: firstSave })
    cacheEditorDocument('/close-race', 'b.txt', { model: disposableModel(), save: secondSave })
    firstSave.edit('saved-a', 2)
    secondSave.edit('saved-b', 2)

    try {
      const closing = flushAllPreviewModels()
      await firstGateChecked.promise
      firstSave.edit('edited-again-during-close', 3)
      secondWrite.resolve(file('saved-b', 'b1'))
      await expect(closing).rejects.toThrow('Unsaved editor changes remain')
    } finally {
      secondWrite.resolve(file('saved-b', 'b1'))
      firstSave.reload(file('saved-a', 'a1'), 2)
      disposePreviewModel('/close-race', 'a.txt')
      disposePreviewModel('/close-race', 'b.txt')
    }
  })
})


it('allows app teardown only when conflicted text has an exact durable recovery copy', async () => {
  const save = new VersionedEditorSave({ initial: file('new disk', 'r2'), sourceEpoch: 1, recovery: { content: 'retained draft', originalRevision: 'r1', bufferVersion: 7 }, write: async () => { throw new Error('Must not overwrite disk') } })
  const protectedState = save.snapshot()
  cacheEditorDocument('/protected-close', 'draft.txt', { model: disposableModel(), save, recovery: { waitForPersistence: async () => {}, protects: snapshot => snapshot.content === protectedState.content && snapshot.bufferVersion === protectedState.bufferVersion } })
  try {
    await expect(flushAllPreviewModels()).resolves.toBeUndefined()
    save.edit('new unprotected draft', 8)
    await expect(flushAllPreviewModels()).rejects.toThrow()
  } finally { save.reload(file('new disk', 'r2'), 2); disposePreviewModel('/protected-close', 'draft.txt') }
})
