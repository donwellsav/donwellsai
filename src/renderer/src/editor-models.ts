import type * as monacoNs from 'monaco-editor/editor'
import type { VersionedEditorSave } from './editor-save'

export type EditorModel = monacoNs.editor.ITextModel

export type EditorDocument = {
  model: EditorModel
  save: VersionedEditorSave
  /** Lets close/preview transitions wait until queued recovery IPC has reached the main authority. */
  recovery?: { waitForPersistence(): Promise<void> }
}

type EditorDocumentMeta = {
  worktreePath: string
  relPath: string
  attachments: number
  touched: number
}

const MAX_DOCUMENTS_PER_WORKSPACE = 64
const MAX_DOCUMENTS_TOTAL = 192
const documents = new Map<string, EditorDocument>()
const metadata = new Map<string, EditorDocumentMeta>()
let touchSequence = 0

/** A platform-neutral identity; Monaco's file URI encoding is not a cache key. */
export function editorDocumentKey(worktreePath: string, relPath: string): string {
  return worktreePath + '\0' + relPath
}

function disposeCachedDocument(key: string, document: EditorDocument): void {
  document.model.dispose()
  documents.delete(key)
  metadata.delete(key)
}

function evictionCandidate(worktreePath?: string): [string, EditorDocument] | undefined {
  let candidate: [string, EditorDocument] | undefined
  let oldest = Number.POSITIVE_INFINITY
  for (const entry of documents) {
    const meta = metadata.get(entry[0])
    if (!meta || (worktreePath !== undefined && meta.worktreePath !== worktreePath)) continue
    if (meta.attachments > 0 || !entry[1].save.canDispose() || meta.touched >= oldest) continue
    candidate = entry
    oldest = meta.touched
  }
  return candidate
}

function trimDocumentCache(worktreePath: string): void {
  let workspaceCount = 0
  for (const meta of metadata.values()) if (meta.worktreePath === worktreePath) workspaceCount += 1
  while (workspaceCount > MAX_DOCUMENTS_PER_WORKSPACE) {
    const candidate = evictionCandidate(worktreePath)
    if (!candidate) break
    disposeCachedDocument(candidate[0], candidate[1])
    workspaceCount -= 1
  }
  while (documents.size > MAX_DOCUMENTS_TOTAL) {
    const candidate = evictionCandidate()
    if (!candidate) break
    disposeCachedDocument(candidate[0], candidate[1])
  }
}

export function getEditorDocument(worktreePath: string, relPath: string): EditorDocument | undefined {
  const key = editorDocumentKey(worktreePath, relPath)
  const document = documents.get(key)
  const meta = metadata.get(key)
  if (meta) meta.touched = ++touchSequence
  return document
}

export function cacheEditorDocument(worktreePath: string, relPath: string, document: EditorDocument): void {
  const key = editorDocumentKey(worktreePath, relPath)
  const previous = documents.get(key)
  if (previous && previous !== document) {
    const previousMeta = metadata.get(key)
    if ((previousMeta?.attachments ?? 0) > 0 || !previous.save.canDispose()) {
      throw new Error('Refusing to replace active or unsaved editor: ' + relPath)
    }
    previous.model.dispose()
  }
  documents.set(key, document)
  metadata.set(key, { worktreePath, relPath, attachments: 0, touched: ++touchSequence })
  trimDocumentCache(worktreePath)
}

export function retainEditorDocument(worktreePath: string, relPath: string): () => void {
  const key = editorDocumentKey(worktreePath, relPath)
  const meta = metadata.get(key)
  if (!meta) throw new Error('Editor document is not cached: ' + relPath)
  meta.attachments += 1
  meta.touched = ++touchSequence
  let released = false
  return () => {
    if (released) return
    released = true
    meta.attachments = Math.max(0, meta.attachments - 1)
    meta.touched = ++touchSequence
    trimDocumentCache(worktreePath)
  }
}

/** Flush one dirty buffer. Rejection tells callers to keep its pane/model alive. */
export async function flushPreviewModel(worktreePath: string, relPath: string): Promise<void> {
  const document = getEditorDocument(worktreePath, relPath)
  if (!document) return
  const state = await document.save.flush()
  await document.recovery?.waitForPersistence()
  if (!document.save.canDispose()) throw new Error(state.error ?? 'Unsaved changes remain in ' + relPath)
}

/** App-close gate: every dirty model must reach disk before renderer teardown. */
export async function flushAllPreviewModels(): Promise<void> {
  await Promise.all(
    [...documents.values()].map(async (document) => {
      const state = await document.save.flush()
      await document.recovery?.waitForPersistence()
      if (!document.save.canDispose()) throw new Error(state.error ?? 'Unsaved editor changes remain')
    })
  )
  for (const document of documents.values()) {
    if (!document.save.canDispose()) throw new Error(document.save.snapshot().error ?? 'Unsaved editor changes remain')
  }
}

function pathMatches(relPath: string, targets: readonly string[] | undefined): boolean {
  if (targets === undefined) return true
  return targets.some((target) => relPath === target || relPath.startsWith(target + '/'))
}

/**
 * Freeze matching editors, persist all dirty text, then keep them read-only until
 * a filesystem or git mutation has finished. The operation never starts while
 * a matching document is conflicted or failed.
 */
export async function runWithEditorGuard<T>(
  worktreePath: string,
  relPaths: readonly string[] | undefined,
  operation: () => Promise<T>
): Promise<T> {
  const matching: EditorDocument[] = []
  for (const [key, document] of documents) {
    const meta = metadata.get(key)
    if (meta?.worktreePath === worktreePath && pathMatches(meta.relPath, relPaths)) matching.push(document)
  }
  const releases = matching.map((document) => document.save.beginMutationLock())
  try {
    await Promise.all(
      matching.map(async (document) => {
        const state = await document.save.flush()
        if (!document.save.canDispose()) throw new Error(state.error ?? 'Unsaved editor changes remain')
      })
    )
    return await operation()
  } finally {
    for (const release of releases.reverse()) release()
  }
}

/** Call only after the buffer flushes; dirty documents are never discarded. */
export function disposePreviewModel(worktreePath: string, relPath: string): void {
  const key = editorDocumentKey(worktreePath, relPath)
  const document = documents.get(key)
  if (!document) return
  if (!document.save.canDispose()) throw new Error('Refusing to dispose unsaved editor: ' + relPath)
  disposeCachedDocument(key, document)
}

export function disposePreviewModelsUnder(worktreePath: string, relPath: string): void {
  const prefix = relPath + '/'
  for (const [key, document] of [...documents]) {
    const meta = metadata.get(key)
    if (meta?.worktreePath !== worktreePath || (meta.relPath !== relPath && !meta.relPath.startsWith(prefix))) continue
    if (!document.save.canDispose()) throw new Error('Refusing to dispose unsaved editor: ' + meta.relPath)
    disposeCachedDocument(key, document)
  }
}
