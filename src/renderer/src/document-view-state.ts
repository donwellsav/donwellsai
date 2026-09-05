import type * as monacoNs from 'monaco-editor/editor'
import type { PreviewMode } from '@shared/types'
import type { EditorRecoveryViewState } from '@shared/editor-recovery'

export type MarkdownViewState = {
  scrollTop: number
  anchor?: string
  navigationGeneration?: number
}

export type DocumentModeViewState = monacoNs.editor.ICodeEditorViewState | MarkdownViewState

type ViewStateRecord = {
  worktreePath: string
  relPath: string
  mode: PreviewMode
  state: DocumentModeViewState
  touched: number
}

const MAX_VIEW_STATES_PER_WORKSPACE = 64
const MAX_VIEW_STATES_TOTAL = 192
const states = new Map<string, ViewStateRecord>()
let touchSequence = 0

function viewStateKey(worktreePath: string, relPath: string, mode: PreviewMode): string {
  return worktreePath + '\0' + relPath + '\0' + mode
}

function trimViewStates(worktreePath: string): void {
  const workspaceRecords = [...states.entries()]
    .filter(([, record]) => record.worktreePath === worktreePath)
    .sort((left, right) => left[1].touched - right[1].touched)
  while (workspaceRecords.length > MAX_VIEW_STATES_PER_WORKSPACE) {
    const stale = workspaceRecords.shift()
    if (stale) states.delete(stale[0])
  }
  if (states.size <= MAX_VIEW_STATES_TOTAL) return
  const all = [...states.entries()].sort((left, right) => left[1].touched - right[1].touched)
  while (states.size > MAX_VIEW_STATES_TOTAL) {
    const stale = all.shift()
    if (stale) states.delete(stale[0])
  }
}

export function saveDocumentViewState(
  worktreePath: string,
  relPath: string,
  mode: PreviewMode,
  state: DocumentModeViewState
): void {
  const key = viewStateKey(worktreePath, relPath, mode)
  states.delete(key)
  states.set(key, { worktreePath, relPath, mode, state, touched: ++touchSequence })
  trimViewStates(worktreePath)
}

export function getDocumentViewState(
  worktreePath: string,
  relPath: string,
  mode: 'edit'
): monacoNs.editor.ICodeEditorViewState | undefined
export function getDocumentViewState(
  worktreePath: string,
  relPath: string,
  mode: 'preview'
): MarkdownViewState | undefined
export function getDocumentViewState(
  worktreePath: string,
  relPath: string,
  mode: PreviewMode
): DocumentModeViewState | undefined {
  const key = viewStateKey(worktreePath, relPath, mode)
  const record = states.get(key)
  if (!record) return undefined
  record.touched = ++touchSequence
  return record.state
}

/** Serializable Monaco subset used by the main-process crash-recovery authority. */
export function captureEditorRecoveryViewState(editor: monacoNs.editor.ICodeEditor): EditorRecoveryViewState | undefined {
  const selection = editor.getSelection()
  if (!selection) return undefined
  return {
    selectionStartLineNumber: selection.selectionStartLineNumber,
    selectionStartColumn: selection.selectionStartColumn,
    positionLineNumber: selection.positionLineNumber,
    positionColumn: selection.positionColumn,
    scrollTop: editor.getScrollTop(),
    scrollLeft: editor.getScrollLeft()
  }
}

function clampRecoveryPosition(
  model: monacoNs.editor.ITextModel,
  lineNumber: number,
  column: number
): monacoNs.IPosition {
  const line = Math.min(Math.max(1, lineNumber), model.getLineCount())
  return { lineNumber: line, column: Math.min(Math.max(1, column), model.getLineMaxColumn(line)) }
}

/** Restore cursor/selection and viewport without trusting stale line or column bounds. */
export function restoreEditorRecoveryViewState(
  editor: monacoNs.editor.ICodeEditor,
  state: EditorRecoveryViewState
): boolean {
  const model = editor.getModel()
  if (!model) return false
  const start = clampRecoveryPosition(model, state.selectionStartLineNumber, state.selectionStartColumn)
  const position = clampRecoveryPosition(model, state.positionLineNumber, state.positionColumn)
  editor.setSelection({
    selectionStartLineNumber: start.lineNumber,
    selectionStartColumn: start.column,
    positionLineNumber: position.lineNumber,
    positionColumn: position.column
  })
  editor.setScrollTop(state.scrollTop)
  editor.setScrollLeft(state.scrollLeft)
  return true
}
export function moveDocumentViewStates(worktreePath: string, sourcePath: string, destinationPath: string): void {
  const sourcePrefix = sourcePath + '/'
  for (const [key, record] of [...states]) {
    if (record.worktreePath !== worktreePath || (record.relPath !== sourcePath && !record.relPath.startsWith(sourcePrefix))) continue
    states.delete(key)
    const suffix = record.relPath.slice(sourcePath.length)
    const relPath = destinationPath + suffix
    states.set(viewStateKey(worktreePath, relPath, record.mode), { ...record, relPath, touched: ++touchSequence })
  }
  trimViewStates(worktreePath)
}

export function deleteDocumentViewStates(worktreePath: string, relPath: string): void {
  const prefix = relPath + '/'
  for (const [key, record] of states) {
    if (record.worktreePath === worktreePath && (record.relPath === relPath || record.relPath.startsWith(prefix))) states.delete(key)
  }
}
