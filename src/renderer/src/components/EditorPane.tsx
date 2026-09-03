import { useEffect, useRef, useState } from 'react'
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { useAppStore } from '../store'

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  }
}

monaco.editor.defineTheme('donwells-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#0a0a0a',
    'editor.foreground': '#e4e4e7',
    'editorLineNumber.foreground': '#52525b',
    'editorLineNumber.activeForeground': '#d4d4d8',
    'editor.lineHighlightBackground': '#18181b',
    'editorCursor.foreground': '#e4e4e7',
    'editor.selectionBackground': '#3f3f4680',
    'editorWidget.background': '#18181b',
    'editorWidget.border': '#27272a',
    'editorIndentGuide.background1': '#27272a',
    'scrollbarSlider.background': '#3f3f4680',
    'scrollbarSlider.hoverBackground': '#52525bcc'
  }
})

/** Models outlive pane remounts: undo history survives, agent writes land in place. */
const modelCache = new Map<string, monaco.editor.ITextModel>()

export function EditorPane({ worktreePath, isActive }: { worktreePath: string; isActive: boolean }) {
  const preview = useAppStore((s) => s.previews[worktreePath])
  const closePreview = useAppStore((s) => s.closePreview)
  const fontSize = useAppStore((s) => s.settings.fontSize)
  const fontFamily = useAppStore((s) => s.settings.fontFamily)
  const notePreviewContent = useAppStore((s) => s.notePreviewContent)
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelRef = useRef<monaco.editor.ITextModel | null>(null)
  const [saveState, setSaveState] = useState<'saving' | 'failed' | string>('')
  const pendingRef = useRef<{ timer?: ReturnType<typeof setTimeout>; disposed: boolean }>({ disposed: false })

  // mount / file swap
  useEffect(() => {
    const host = hostRef.current
    if (!host || !preview) return
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
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      padding: { top: 8 },
      renderLineHighlight: 'line',
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      fixedOverflowWidgets: true
    })
    editorRef.current = editor
    modelRef.current = model
    pendingRef.current.disposed = false

    const flush = () => {
      pending.timer = undefined
      const content = model.getValue()
      setSaveState('saving')
      void window.orca
        .writeFile(worktreePath, preview.path, content)
        .then(() => {
          notePreviewContent(worktreePath, content)
          if (!pending.disposed) setSaveState(new Date().toLocaleTimeString('en-GB', { hour12: false }))
        })
        .catch(() => {
          if (!pending.disposed) setSaveState('failed')
        })
    }
    const pending = pendingRef.current
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
  }, [worktreePath, preview?.path])

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
      fontFamily: fontFamily || "'Geist Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace"
    })
  }, [fontSize, fontFamily])

  if (!preview) return null
  return (
    <div className={`pane non-terminal preview-pane editor-pane ${isActive ? '' : 'terminal-hidden'}`}>
      <div className="pane-toolbar">
        <span className="pane-title">{preview.path}</span>
        {preview.truncated && <span className="preview-truncated">(truncated at 512 KiB)</span>}
        <span className="editor-save-state">
          {saveState === '' ? '' : saveState === 'saving' ? 'saving…' : saveState === 'failed' ? 'save failed' : `saved ${saveState}`}
        </span>
        <button className="icon-btn" title="Close editor" onClick={() => closePreview(worktreePath)}>
          ×
        </button>
      </div>
      <div className="editor-host" ref={hostRef} />
    </div>
  )
}
