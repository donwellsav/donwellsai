import { parseDiffFromFile, type FileDiffMetadata } from '@pierre/diffs'
import { FileDiff } from '@pierre/diffs/react'
import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../store'
import { Icon } from './Icon'

/** Review surface: @pierre/diffs renders HEAD ↔ working tree. Monaco stays the
 *  editor; a review pane needs the quiet, purpose-built diff renderer. */
export function DiffPane({ worktreePath, relPath }: { worktreePath: string; relPath: string }) {
  const fontSize = useAppStore((s) => s.settings.fontSize)
  const openPreview = useAppStore((s) => s.openPreview)
  const closePane = useAppStore((s) => s.closePane)
  const [mine, setMine] = useState<FileDiffMetadata | null>(null)
  const [sideBySide, setSideBySide] = useState(true)
  const [status, setStatus] = useState<'loading' | 'ready'>('loading')
  // refresh() bumps this so the parse re-runs
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    setStatus('loading')
    void (async () => {
      const [atRef, onDisk] = await Promise.all([
        window.orca.readFileAtRef(worktreePath, relPath, 'HEAD'),
        window.orca.readFile(worktreePath, relPath).catch(() => null)
      ])
      if (!alive) return
      const oldFile = atRef.content === null ? null : { name: relPath, contents: atRef.content }
      const newFile = onDisk === null ? null : { name: relPath, contents: onDisk.content }
      if (!oldFile && !newFile) return
      setMine(parseDiffFromFile(oldFile, newFile))
      setStatus('ready')
    })()
    return () => {
      alive = false
    }
  }, [worktreePath, relPath, tick])

  const stat = useMemo(() => {
    if (!mine) return null
    let adds = 0
    let dels = 0
    for (const h of mine.hunks) {
      for (const c of h.hunkContent) {
        if (c.type === 'change') {
          adds += c.additions
          dels += c.deletions
        }
      }
    }
    return { adds, dels, hunks: mine.hunks.length, type: mine.type }
  }, [mine])

  const name = relPath.split('/').pop() ?? relPath
  const subline =
    mine === null
      ? 'loading diff…'
      : mine.type === 'new'
        ? 'HEAD → new file'
        : mine.type === 'deleted'
          ? 'HEAD → deleted'
          : mine.type === 'rename-pure'
            ? 'renamed'
            : 'HEAD ↔ working tree'

  return (
    <div className="diff-pane">
      <div className="diff-head">
        <Icon name="git" size={12} />
        <span className="diff-title">{name}</span>
        <span className="diff-sub">{subline}</span>
        {stat && (
          <span className="diff-stat">{`+${stat.adds} −${stat.dels}`}{stat.hunks > 0 && ` · ${stat.hunks} hunk${stat.hunks === 1 ? '' : 's'}`}</span>
        )}
        <span className="diff-spacer" />
        <button className="icon-btn" title="Refresh" onClick={() => setTick((t) => t + 1)}>
          <Icon name="refresh" size={11} />
        </button>
        <button
          className={`icon-btn${sideBySide ? ' active' : ''}`}
          title={sideBySide ? 'Stacked view' : 'Side-by-side view'}
          onClick={() => setSideBySide((v) => !v)}
        >
          <Icon name="columns" size={11} />
        </button>
        {status === 'ready' && mine?.type !== 'deleted' && (
          <button className="icon-btn" title="Open in editor" onClick={() => void openPreview(worktreePath, relPath)}>
            <Icon name="edit" size={11} />
          </button>
        )}
        <button className="icon-btn" title="Close diff" onClick={() => closePane(worktreePath, `diff:${relPath}`)}>
          <Icon name="x" size={11} />
        </button>
      </div>
      <div className="diff-host">
        {mine ? (
          <FileDiff
            fileDiff={mine}
            disableWorkerPool
            options={{
              theme: 'pierre-dark',
              themeType: 'dark',
              diffStyle: sideBySide ? 'split' : 'unified',
              disableFileHeader: true,
              diffIndicators: 'classic',
              overflow: 'scroll',
              lineDiffType: 'word'
            }}
            style={{ ['--diffs-font-size' as string]: `${fontSize}px` }}
          />
        ) : (
          <div className="git-loading">{status === 'loading' ? 'Loading diff…' : 'No content'}</div>
        )}
      </div>
    </div>
  )
}
