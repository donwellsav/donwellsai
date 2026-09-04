import { useEffect, useRef, useState } from 'react'
import { modelCache } from '../editor-models'
import { monaco } from '../monaco-setup'
import { isMarkdownFile, useAppStore } from '../store'
import { MarkdownPreview } from './MarkdownPreview'

/**
 * One file, one pane: the tab strip lives in the pane title bar (Workbench);
 * this component is pure editor surface. Model cache survives pane remounts,
 * so undo history and agent writes land in place.
 */
export function EditorPane({ worktreePath, relPath }: { worktreePath: string; relPath: string }) {
  const preview = useAppStore((s) => s.previews[worktreePath]?.[relPath])
  const fontSize = useAppStore((s) => s.settings.fontSize)
  const fontFamily = useAppStore((s) => s.settings.fontFamily)
  const editorWordWrap = useAppStore((s) => s.settings.editorWordWrap)
  const editorMinimap = useAppStore((s) => s.settings.editorMinimap)
  const editorTabSize = useAppStore((s) => s.settings.editorTabSize)
  const markdown = isMarkdownFile(relPath)
  const mode = markdown ? preview?.mode ?? 'edit' : 'edit'
  const notePreviewContent = useAppStore((s) => s.notePreviewContent)
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelRef = useRef<monaco.editor.ITextModel | null>(null)
  const [saveState, setSaveState] = useState<'saving' | 'failed' | string>('')
  const pendingRef = useRef<{ timer?: ReturnType<typeof setTimeout>; disposed: boolean }>({ disposed: false })

  // mount / file swap
  useEffect(() => {
    const host = hostRef.current
    if (!host || !preview || mode === 'preview') return
    const uri = monaco.Uri.parse(`file://${worktreePath}/${preview.path}`)
    let model = modelCache.get(uri.toString())
    if (!model) {
      model = monaco.editor.createModel(preview.content, undefined, uri)
      modelCache.set(uri.toString(), model)
    }
    // cached model may be stale while the pane was closed — adopt store truth
    if (model.getValue() !== preview.content) model.setValue(preview.content)
    const editor = monaco.editor.create(host, {
      model,
      theme: 'donwells-dark',
      fontSize,
      fontFamily: fontFamily || "'Geist Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace",
      automaticLayout: true,
      minimap: { enabled: editorMinimap ?? false },
      wordWrap: editorWordWrap ?? 'off',
      stickyScroll: { enabled: true },
      guides: { indentation: true, bracketPairs: true, highlightActiveIndentation: true },
      bracketPairColorization: { enabled: true },
      smoothScrolling: true,
      cursorSmoothCaretAnimation: 'on',
      renderWhitespace: 'selection',
      quickSuggestions: { other: true, comments: false, strings: true },
      links: true,
      scrollBeyondLastLine: false,
      padding: { top: 8 },
      renderLineHighlight: 'line',
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      fixedOverflowWidgets: true
    })
    editorRef.current = editor
    modelRef.current = model
    model.updateOptions({ tabSize: editorTabSize ?? 4 })
    const pending = pendingRef.current
    pending.disposed = false
    const flush = () => {
      pending.timer = undefined
      const content = model.getValue()
      setSaveState('saving')
      void window.orca
        .writeFile(worktreePath, relPath, content)
        .then(() => {
          notePreviewContent(worktreePath, relPath, content)
          if (!pending.disposed) setSaveState(new Date().toLocaleTimeString('en-GB', { hour12: false }))
        })
        .catch(() => {
          if (!pending.disposed) setSaveState('failed')
        })
    }
    const sub = editor.onDidChangeModelContent(() => {
      setSaveState('saving')
      clearTimeout(pending.timer)
      pending.timer = setTimeout(flush, 400)
    })
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      clearTimeout(pending.timer)
      flush()
    })
    return () => {
      sub.dispose()
      if (pending.timer !== undefined) {
        // pane switched/closed mid-edit: flush now or keystrokes vanish
        clearTimeout(pending.timer)
        flush()
      }
      pending.disposed = true
      editor.dispose()
      editorRef.current = null
      modelRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreePath, relPath, mode])

  // adopt agent IPC writes (equality guard kills the self-write loop)
  useEffect(() => {
    const model = modelRef.current
    if (!model || !preview) return
    if (model.getValue() !== preview.content) model.setValue(preview.content)
  }, [preview])

  // settings live-apply
  useEffect(() => {
    editorRef.current?.updateOptions({
      fontSize,
      fontFamily: fontFamily || "'Geist Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace",
      wordWrap: editorWordWrap ?? 'off',
      minimap: { enabled: editorMinimap ?? false }
    })
    modelRef.current?.updateOptions({ tabSize: editorTabSize ?? 4 })
  }, [fontSize, fontFamily, editorWordWrap, editorMinimap, editorTabSize])

  if (!preview) return null
  const rendered = mode === 'preview'
  return (
    <div className="editor-pane">
      {rendered ? (
        <MarkdownPreview worktreePath={worktreePath} relPath={relPath} />
      ) : (
        <div className="editor-host" ref={hostRef} />
      )}
      {(!rendered && (saveState || preview?.truncated)) && (
        <span
          className={`editor-status-chip${saveState === 'failed' ? ' failed' : ''}`}
          title={saveState === 'failed' ? 'Could not write the file — see logs' : undefined}
        >
          {saveState === 'saving'
            ? 'saving…'
            : saveState === 'failed'
              ? 'save failed'
              : saveState
                ? `saved ${saveState}`
                : null}
          {preview.truncated && saveState === '' ? 'read cap 512 KiB' : null}
        </span>
      )}
    </div>
  )
}
