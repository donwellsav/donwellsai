import type * as monacoNs from 'monaco-editor/editor'

export type EditorModel = monacoNs.editor.ITextModel

/** Models outlive pane remounts: undo history survives, agent writes land in place.
 *  Lives apart from monaco-setup so node-side tests can import the store without
 *  pulling the browser-only monaco runtime. */
export const modelCache = new Map<string, EditorModel>()

/** Drop a closed file's cached model — editor memory does not grow forever. */
export function disposePreviewModel(worktreePath: string, relPath: string): void {
  const uri = `file://${worktreePath}/${relPath}`
  modelCache.get(uri)?.dispose()
  modelCache.delete(uri)
}
