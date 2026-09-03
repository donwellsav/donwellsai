import { useEffect, useState } from 'react'
import { useAppStore } from '../store'
import { Icon } from './Icon'

/** One porcelain line parsed: `XY path` (untracked = `??`). */
type FileRow = { path: string; x: string; y: string; untracked: boolean; conflict: boolean }

function parseRaw(raw: string[]): FileRow[] {
  return raw
    .filter((l) => !l.startsWith('## '))
    .map((l) => ({
      x: l[0] ?? ' ',
      y: l[1] ?? ' ',
      path: l.slice(3),
      untracked: l.startsWith('??'),
      conflict: (l[0] === 'U' || l[1] === 'U') ?? false
    }))
}

/** Functional Git pane (Orca right-sidebar SC surface): stage/unstage/discard, commit, push/pull, branch switcher. */
export function GitPane({ worktreePath }: { worktreePath: string }) {
  const status = useAppStore((s) => s.statuses[worktreePath])
  const refreshStatuses = useAppStore((s) => s.refreshStatuses)
  const setError = useAppStore((s) => s.setError)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [openDiff, setOpenDiff] = useState<string | null>(null)
  const [diffText, setDiffText] = useState('')
  const [branches, setBranches] = useState<{ current: string; all: string[] } | null>(null)

  useEffect(() => {
    void refreshStatuses()
  }, [worktreePath, refreshStatuses])

  useEffect(() => {
    let alive = true
    void window.orca.gitBranches(worktreePath).then((b) => {
      if (alive) setBranches(b)
    })
    return () => {
      alive = false
    }
  }, [worktreePath])

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      await refreshStatuses()
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  if (!status) return <div className="git-pane"><div className="git-loading">Loading status…</div></div>

  const rows = parseRaw(status.raw)
  const stagedRows = rows.filter((r) => r.x !== ' ' && r.x !== '?')
  const unstagedRows = rows.filter((r) => (r.y !== ' ' && r.y !== '?') || r.untracked)
  const clean = rows.length === 0

  const openDiffFor = async (p: string): Promise<void> => {
    if (openDiff === p) {
      setOpenDiff(null)
      return
    }
    setOpenDiff(p)
    setDiffText(await window.orca.gitDiff(worktreePath, p))
  }

  const FileLine = ({ r, stagedSection }: { r: FileRow; stagedSection: boolean }): React.JSX.Element => (
    <div className="git-file-line">
      <button className="git-file-name" title={r.path} onClick={() => void openDiffFor(r.path)}>
        <span className={`git-status-letter ${r.conflict ? 'U' : stagedSection ? 'A' : 'M'}`}>
          {r.conflict ? 'U' : stagedSection ? r.x : r.untracked ? '?' : r.y}
        </span>
        {r.path.split('/').pop()}
      </button>
      {stagedSection ? (
        <button className="icon-btn" title="Unstage" onClick={() => void run(() => window.orca.gitUnstage(worktreePath, [r.path]))}>
          <Icon name="x" size={11} />
        </button>
      ) : (
        <>
          <button className="icon-btn" title="Stage" onClick={() => void run(() => window.orca.gitStage(worktreePath, [r.path]))}>
            <Icon name="plus" size={11} />
          </button>
          <button
            className="icon-btn danger"
            title="Discard changes"
            onClick={() => {
              if (confirm(`Discard changes to ${r.path}?`)) void run(() => window.orca.gitDiscard(worktreePath, [r.path]))
            }}
          >
            <Icon name="x" size={11} />
          </button>
        </>
      )}
    </div>
  )

  return (
    <div className="git-pane">
      <div className="git-branch-row">
        <Icon name="git" size={12} />
        {branches && branches.all.length > 0 ? (
          <select
            className="git-branch-select"
            value={status.branch || branches.current}
            onChange={(e) => void run(() => window.orca.gitCheckout(worktreePath, e.target.value))}
          >
            {[...new Set([status.branch || branches.current, ...branches.all])].map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        ) : (
          <span className="git-branch">{status.branch || '(detached)'}</span>
        )}
        {status.ahead > 0 && <span className="git-ahead">↑{status.ahead}</span>}
        {status.behind > 0 && <span className="git-behind">↓{status.behind}</span>}
        <span className="git-spacer" />
        <button className="icon-btn" title="Pull (ff-only)" disabled={busy} onClick={() => void run(() => window.orca.gitPull(worktreePath))}>
          <Icon name="refresh" size={12} />
        </button>
        <button className="icon-btn" title="Push" disabled={busy} onClick={() => void run(() => window.orca.gitPush(worktreePath))}>
          <Icon name="play" size={12} />
        </button>
      </div>

      {clean && <div className="git-clean-row">Working tree clean</div>}

      {stagedRows.length > 0 && (
        <div className="git-section">
          <div className="git-section-title">Staged ({stagedRows.length})</div>
          {stagedRows.map((r) => <FileLine key={`s-${r.path}`} r={r} stagedSection />)}
        </div>
      )}

      {unstagedRows.length > 0 && (
        <div className="git-section">
          <div className="git-section-title">Changes ({unstagedRows.length})</div>
          {unstagedRows.map((r) => <FileLine key={`u-${r.path}`} r={r} stagedSection={false} />)}
          <div className="git-section-actions">
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void run(() => window.orca.gitStage(worktreePath, unstagedRows.map((r) => r.path)))}>
              Stage all
            </button>
          </div>
        </div>
      )}

      {stagedRows.length > 0 && (
        <div className="git-commit-box">
          <textarea
            className="git-commit-input"
            placeholder="Commit message"
            rows={2}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && message.trim()) {
                void run(async () => {
                  await window.orca.gitCommit(worktreePath, message)
                  setMessage('')
                })
              }
            }}
          />
          <button
            className="btn btn-primary btn-sm"
            disabled={busy || !message.trim()}
            onClick={() =>
              void run(async () => {
                await window.orca.gitCommit(worktreePath, message)
                setMessage('')
              })
            }
          >
            Commit ⌘⏎
          </button>
        </div>
      )}

      {openDiff && (
        <div className="git-diff">
          <div className="git-diff-head">
            <span className="pane-title">{openDiff}</span>
            <button className="icon-btn" onClick={() => setOpenDiff(null)}><Icon name="x" size={11} /></button>
          </div>
          <pre className="git-diff-code">{diffText || '(no diff — binary or untracked)'}</pre>
        </div>
      )}
    </div>
  )
}
