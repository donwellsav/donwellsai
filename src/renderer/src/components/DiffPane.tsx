import { useEffect, useRef, useState } from 'react'
import { modelCache } from '../editor-models'
import { monaco } from '../monaco-setup'
import { useAppStore } from '../store'
import { Icon } from './Icon'

type HunkSummary = { adds: number; dels: number; current: number; total: number }

/**
 * Review surface for one file: HEAD (original) vs working-tree (modified, read-only —
 * edits belong in the editor pane). The modified model is shared with the editor cache
 * when the file is open, so live edits update the diff instantly.
 */
export function DiffPane({ worktreePath, relPath }: { worktreePath: string; relPath: string }) {
  const fontSize = useAppStore((s) => s.settings.fontSize)
  const fontFamily = useAppStore((s) => s.settings.fontFamily)
  const openPreview = useAppStore((s) => s.openPreview)
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const originalRef = useRef<monaco.editor.ITextModel | null>(null)
  const modifiedRef = useRef<monaco.editor.ITextModel | null>(null)
  const modifiedOwnedRef = useRef(false)
  const [stat, setStat] = useState<HunkSummary | null>(null)
  const [sideBySide, setSideBySide] = useState(true)
  const [deleted, setDeleted] = useState(false)
  const [untracked, setUntracked] = useState(false)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const diff = monaco.editor.createDiffEditor(host, {
      theme: 'donwells-dark',
      fontSize,
      fontFamily: fontFamily || "'Geist Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace",
      automaticLayout: true,
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: true,
      ignoreTrimWhitespace: false,
      originalEditable: false,
      readOnly: true,
      minimap: { enabled: false },
      stickyScroll: { enabled: true },
      renderMarginRevertIcon: false,
      smoothScrolling: true,
      padding: { top: 8, bottom: 8 },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 }
    })
    editorRef.current = diff

    const recount = () => {
      const changes = diff.getLineChanges() ?? []
      // an empty side yields a phantom 1-line span (start=end on line 1 with 0
      // content); skip line counts for a side that has nothing
      const origEmpty = (originalRef.current?.getValueLength() ?? 0) === 0
      const modEmpty = (modifiedRef.current?.getValueLength() ?? 0) === 0
      let adds = 0
      let dels = 0
      for (const c of changes) {
        if (!modEmpty) adds += c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1
        if (!origEmpty) dels += c.originalEndLineNumber - c.originalStartLineNumber + 1
      }
      const pos = diff.getModifiedEditor().getPosition()
      let current = 0
      if (pos) {
        const idx = changes.findIndex(
          (c) => c.modifiedStartLineNumber <= pos.lineNumber && pos.lineNumber <= Math.max(c.modifiedStartLineNumber, c.modifiedEndLineNumber)
        )
        if (idx !== -1) current = idx + 1
      }
      setStat({ adds, dels, current, total: changes.length })
    }

    const load = async () => {
      const [atRef, onDisk] = await Promise.all([
        window.orca.readFileAtRef(worktreePath, relPath, 'HEAD'),
        window.orca.readFile(worktreePath, relPath).catch(() => null)
      ])
      if (!editorRef.current) return
      setUntracked(atRef.content === null && onDisk !== null)
      setDeleted(onDisk === null)
      setMissing(atRef.content === null && onDisk === null)
      // original is diff-scoped (scheme keeps it out of the editor's file cache);
      // the modified side reuses the editor's model when the file is open there
      if (!originalRef.current) {
        originalRef.current = monaco.editor.createModel(atRef.content ?? '', undefined, monaco.Uri.parse(`donwells-diff://${relPath}#HEAD`))
      } else if (originalRef.current.getValue() !== (atRef.content ?? '')) {
        originalRef.current.setValue(atRef.content ?? '')
      }
      const fileUri = monaco.Uri.parse(`file://${worktreePath}/${relPath}`)
      const shared = monaco.editor.getModel(fileUri) ?? modelCache.get(fileUri.toString())
      if (shared) {
        modifiedRef.current = shared
        modifiedOwnedRef.current = false
        if (shared.getValue() !== (onDisk?.content ?? '')) shared.setValue(onDisk?.content ?? '')
      } else {
        if (!modifiedRef.current) {
          modifiedRef.current = monaco.editor.createModel(onDisk?.content ?? '', undefined, monaco.Uri.parse(`donwells-diff://${relPath}#worktree`))
          modifiedOwnedRef.current = true
        } else if (modifiedRef.current.getValue() !== (onDisk?.content ?? '')) {
          modifiedRef.current.setValue(onDisk?.content ?? '')
        }
      }
      diff.setModel({ original: originalRef.current, modified: modifiedRef.current })
      recount()
    }
    void load()
    diff.onDidUpdateDiff(recount)
    const disposer = diff.getModifiedEditor().onDidChangeCursorPosition(recount)

    return () => {
      disposer.dispose()
      diff.dispose()
      originalRef.current?.dispose()
      originalRef.current = null
      if (modifiedOwnedRef.current) modifiedRef.current?.dispose()
      modifiedRef.current = null
      modifiedOwnedRef.current = false
      editorRef.current = null
    }
  }, [worktreePath, relPath, fontSize, fontFamily])

  const refresh = () => {
    // rerun the effect's reader via state recycle: bumping the key is heavier;
    // direct re-read keeps models + scroll where they are
    void Promise.all([
      window.orca.readFileAtRef(worktreePath, relPath, 'HEAD'),
      window.orca.readFile(worktreePath, relPath).catch(() => null)
    ]).then(([atRef, onDisk]) => {
      const o = originalRef.current
      const m = modifiedRef.current
      if (!o || !m) return
      setUntracked(atRef.content === null && onDisk !== null)
      setDeleted(onDisk === null)
      if (o.getValue() !== (atRef.content ?? '')) o.setValue(atRef.content ?? '')
      if (m.getValue() !== (onDisk?.content ?? '')) m.setValue(onDisk?.content ?? '')
    })
  }

  const goTo = (dir: 'next' | 'previous') => editorRef.current?.goToDiff(dir)

  const name = relPath.split('/').pop() ?? relPath
  return (
    <div className="diff-pane">
      <div className="diff-head">
        <Icon name="git" size={12} />
        <span className="diff-title">{name}</span>
        <span className="diff-sub">{missing ? 'missing on both sides' : untracked ? 'HEAD → new file' : deleted ? 'HEAD → deleted' : 'HEAD ↔ working tree'}</span>
        {stat && <span className="diff-stat">{`+${stat.adds} −${stat.dels}`}{stat.total > 0 && ` · ${stat.current > 0 ? `${stat.current}/` : ''}${stat.total} hunk${stat.total === 1 ? '' : 's'}`}</span>}
        <span className="diff-spacer" />
        <button className="icon-btn" title="Previous change" disabled={!stat?.total} onClick={() => goTo('previous')}>
          <Icon name="up" size={11} />
        </button>
        <button className="icon-btn" title="Next change" disabled={!stat?.total} onClick={() => goTo('next')}>
          <Icon name="down" size={11} />
        </button>
        <button
          className={`icon-btn${sideBySide ? ' active' : ''}`}
          title={sideBySide ? 'Inline view' : 'Side-by-side view'}
          onClick={() => {
            const next = !sideBySide
            setSideBySide(next)
            editorRef.current?.updateOptions({ renderSideBySide: next })
          }}
        >
          <Icon name="columns" size={11} />
        </button>
        <button className="icon-btn" title="Refresh" onClick={refresh}>
          <Icon name="refresh" size={11} />
        </button>
        <button className="icon-btn" title="Open in editor" onClick={() => void openPreview(worktreePath, relPath)}>
          <Icon name="edit" size={11} />
        </button>
      </div>
      <div className="diff-host" ref={hostRef} />
    </div>
  )
}
