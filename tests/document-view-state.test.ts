import { describe, expect, it, vi } from 'vitest'
import {
  captureEditorRecoveryViewState,
  deleteDocumentViewStates,
  getDocumentViewState,
  moveDocumentViewStates,
  restoreEditorRecoveryViewState,
  saveDocumentViewState
} from '../src/renderer/src/document-view-state'

describe('Markdown document view state', () => {
  it('keeps scroll and consumed navigation together across a path move', () => {
    const workspace = '/fixture/navigation-continuity'
    const before = 'docs/guide.md'
    const after = 'handbook/guide.md'
    saveDocumentViewState(workspace, before, 'preview', {
      scrollTop: 842,
      anchor: 'deployment',
      navigationGeneration: 7
    })

    moveDocumentViewStates(workspace, 'docs', 'handbook')

    expect(getDocumentViewState(workspace, before, 'preview')).toBeUndefined()
    expect(getDocumentViewState(workspace, after, 'preview')).toEqual({
      scrollTop: 842,
      anchor: 'deployment',
      navigationGeneration: 7
    })

    deleteDocumentViewStates(workspace, 'handbook')
    expect(getDocumentViewState(workspace, after, 'preview')).toBeUndefined()
  })
  it('captures and restores cursor, selection, and scroll while clamping stale positions', () => {
    const model = Object.create(null)
    model.getLineCount = vi.fn(() => 3)
    model.getLineMaxColumn = vi.fn((lineNumber: number) => lineNumber === 3 ? 5 : 20)
    const editor = Object.create(null)
    editor.getSelection = vi.fn(() => ({
      selectionStartLineNumber: 2,
      selectionStartColumn: 4,
      positionLineNumber: 2,
      positionColumn: 9
    }))
    editor.getScrollTop = vi.fn(() => 380)
    editor.getScrollLeft = vi.fn(() => 16)
    editor.getModel = vi.fn(() => model)
    editor.setSelection = vi.fn()
    editor.setScrollTop = vi.fn()
    editor.setScrollLeft = vi.fn()

    expect(captureEditorRecoveryViewState(editor)).toEqual({
      selectionStartLineNumber: 2,
      selectionStartColumn: 4,
      positionLineNumber: 2,
      positionColumn: 9,
      scrollTop: 380,
      scrollLeft: 16
    })
    expect(restoreEditorRecoveryViewState(editor, {
      selectionStartLineNumber: 99,
      selectionStartColumn: 99,
      positionLineNumber: 3,
      positionColumn: 99,
      scrollTop: 900,
      scrollLeft: 22
    })).toBe(true)
    expect(editor.setSelection).toHaveBeenCalledWith({
      selectionStartLineNumber: 3,
      selectionStartColumn: 5,
      positionLineNumber: 3,
      positionColumn: 5
    })
    expect(editor.setScrollTop).toHaveBeenCalledWith(900)
    expect(editor.setScrollLeft).toHaveBeenCalledWith(22)
  })
})
