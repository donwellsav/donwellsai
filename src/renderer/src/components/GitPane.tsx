import type { GitBranchInfo, GitCommit, GitPathFailure, GitPathOperation, GitPathOperationResult, GitStatusEntry } from '@shared/types'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { runWithEditorGuard } from '../editor-models'
import { useAppStore } from '../store'
import { Icon } from './Icon'
import { ModalDialog } from './ModalDialog'

type SectionId = 'conflicts' | 'staged' | 'changes' | 'untracked'

type GitRow = {
  id: string
  section: SectionId
  stagedComparison: boolean
  entry: GitStatusEntry
}

type GitSection = {
  id: SectionId
  title: string
  rows: GitRow[]
}

type ContextMenuState = { x: number; y: number; row: GitRow }
type GitConfirmation =
  | { kind: 'discard'; rows: readonly GitRow[]; paths: readonly string[] }
  | { kind: 'switch-branch'; branch: string }
  | { kind: 'create-branch'; branch: string }
  | { kind: 'amend'; message: string }
  | { kind: 'push'; target: string }

function sectionRows(entries: readonly GitStatusEntry[]): GitSection[] {
  const rows = (section: SectionId, candidates: readonly GitStatusEntry[], stagedComparison: boolean): GitRow[] =>
    candidates.map((entry) => ({ id: `${section}:${entry.path}`, section, stagedComparison, entry }))

  const conflicts = entries.filter((entry) => entry.conflict)
  const staged = entries.filter((entry) => !entry.conflict && entry.staged)
  const changes = entries.filter((entry) => !entry.conflict && entry.kind !== 'untracked' && entry.unstaged)
  const untracked = entries.filter((entry) => entry.kind === 'untracked')
  return [
    { id: 'conflicts', title: 'Conflicts', rows: rows('conflicts', conflicts, false) },
    { id: 'staged', title: 'Staged changes', rows: rows('staged', staged, true) },
    { id: 'changes', title: 'Changes', rows: rows('changes', changes, false) },
    { id: 'untracked', title: 'Untracked files', rows: rows('untracked', untracked, false) }
  ]
}

function rowSupports(row: GitRow, operation: GitPathOperation): boolean {
  if (operation === 'stage') return row.section === 'conflicts' || row.section === 'changes' || row.section === 'untracked'
  if (operation === 'unstage') return row.section === 'staged'
  return row.section === 'conflicts' || row.section === 'changes' || row.section === 'untracked'
}

function uniquePaths(rows: readonly GitRow[], operation: GitPathOperation): string[] {
  return [...new Set(rows.filter((row) => rowSupports(row, operation)).map((row) => row.entry.path))]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function displayPath(entry: GitStatusEntry): string {
  return entry.originalPath ? `${entry.originalPath} → ${entry.path}` : entry.path
}

function displayCode(row: GitRow): string {
  if (row.entry.conflict) return 'U'
  if (row.section === 'untracked') return '?'
  return row.stagedComparison ? row.entry.index : row.entry.workingTree
}

function formatCommitDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date)
}

export function GitPane({ worktreePath }: { worktreePath: string }) {
  const status = useAppStore((state) => state.statuses[worktreePath])
  const refreshStatuses = useAppStore((state) => state.refreshStatuses)
  const setError = useAppStore((state) => state.setError)
  const reloadOpenPreviews = useAppStore((state) => state.reloadOpenPreviews)
  const message = useAppStore((state) => state.gitCommitDrafts[worktreePath] ?? '')
  const setGitCommitDraft = useAppStore((state) => state.setGitCommitDraft)

  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [failures, setFailures] = useState<GitPathFailure[]>([])
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [confirmation, setConfirmation] = useState<GitConfirmation | null>(null)
  const [branches, setBranches] = useState<GitBranchInfo | null>(null)
  const [branchPickerOpen, setBranchPickerOpen] = useState(false)
  const [branchSearch, setBranchSearch] = useState('')
  const [newBranch, setNewBranch] = useState('')
  const [amend, setAmend] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyBusy, setHistoryBusy] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [history, setHistory] = useState<GitCommit[]>([])
  const [historyCursor, setHistoryCursor] = useState<string | undefined>()
  const historyRequestRef = useRef(0)
  const sections = useMemo(() => sectionRows(status?.entries ?? []), [status?.entries])
  const allRows = useMemo(() => sections.flatMap((section) => section.rows), [sections])
  const selectedRows = useMemo(() => allRows.filter((row) => selected.has(row.id)), [allRows, selected])
  const failureByPath = useMemo(() => new Map(failures.map((failure) => [failure.path, failure.error])), [failures])
  const paneId = useId()
  useEffect(() => {
    void refreshStatuses()
  }, [refreshStatuses, worktreePath])

  useEffect(() => {
    historyRequestRef.current += 1
    setSelected(new Set())
    setFailures([])
    setNotice(null)
    setBranchPickerOpen(false)
    setBranchSearch('')
    setNewBranch('')
    setConfirmation(null)
    setHistory([])
    setHistoryError(null)
    setHistoryBusy(false)
    setHistoryCursor(undefined)
    setHistoryOpen(false)
  }, [worktreePath])

  useEffect(() => {
    const valid = new Set(allRows.map((row) => row.id))
    setSelected((current) => {
      const next = new Set([...current].filter((id) => valid.has(id)))
      return next.size === current.size ? current : next
    })
  }, [allRows])

  useEffect(() => {
    if (!status || status.kind === 'folder') {
      setBranches(null)
      return
    }
    setBranches(null)
    let cancelled = false
    void window.donwells.gitBranches(worktreePath)
      .then((value) => {
        if (!cancelled) setBranches(value)
      })
      .catch((error: unknown) => {
        if (!cancelled) setNotice(errorMessage(error))
      })
    return () => {
      cancelled = true
    }
  }, [status?.kind, worktreePath])

  useEffect(() => {
    if (!contextMenu) return
    const dismiss = (): void => setContextMenu(null)
    window.addEventListener('blur', dismiss)
    document.addEventListener('pointerdown', dismiss)
    return () => {
      window.removeEventListener('blur', dismiss)
      document.removeEventListener('pointerdown', dismiss)
    }
  }, [contextMenu])

  const reportError = (error: unknown): void => {
    const detail = errorMessage(error)
    setNotice(detail)
    setError(detail)
  }

  const refreshGit = async (): Promise<void> => {
    await refreshStatuses()
    if (status?.kind !== 'folder') setBranches(await window.donwells.gitBranches(worktreePath))
  }

  const runTask = async <T,>(label: string, operation: () => Promise<T>): Promise<T | undefined> => {
    if (busy) return undefined
    setBusy(label)
    setNotice(null)
    setFailures([])
    try {
      return await operation()
    } catch (error) {
      reportError(error)
      return undefined
    } finally {
      setBusy(null)
    }
  }

  const toggleRow = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const openDiff = (row: GitRow): void => {
    useAppStore.getState().openDiff(worktreePath, row.entry.path, row.stagedComparison ? 'staged' : 'unstaged')
  }

  const applyResult = (result: GitPathOperationResult, rows: readonly GitRow[]): void => {
    setFailures(result.failures)
    const succeeded = new Set(result.succeeded)
    const completedIds = new Set(rows.filter((row) => succeeded.has(row.entry.path)).map((row) => row.id))
    setSelected((current) => new Set([...current].filter((id) => !completedIds.has(id))))
    if (result.failures.length > 0) {
      setNotice(`${result.operation} failed for ${result.failures.length} ${result.failures.length === 1 ? 'path' : 'paths'}.`)
    } else {
      setNotice(`${result.operation} completed for ${result.succeeded.length} ${result.succeeded.length === 1 ? 'path' : 'paths'}.`)
    }
  }

  const operate = async (operation: GitPathOperation, rows: readonly GitRow[], confirmed = false): Promise<void> => {
    const paths = uniquePaths(rows, operation)
    if (paths.length === 0 || busy) return
    if (operation === 'discard' && !confirmed) {
      setConfirmation({ kind: 'discard', rows, paths })
      return
    }
    await runTask(`${operation}:${paths.length}`, async () => {
      let result: GitPathOperationResult
      if (operation === 'stage') result = await window.donwells.gitStage(worktreePath, paths)
      else if (operation === 'unstage') result = await window.donwells.gitUnstage(worktreePath, paths)
      else {
        result = await runWithEditorGuard(worktreePath, paths, async () => {
          const discarded = await window.donwells.gitDiscard(worktreePath, paths)
          if (discarded.succeeded.length > 0) await reloadOpenPreviews(worktreePath, discarded.succeeded)
          return discarded
        })
      }
      applyResult(result, rows)
      await refreshStatuses()
    })
  }

  const switchBranch = async (branch: string, confirmed = false): Promise<void> => {
    if (!branch || branch === branches?.current || busy) return
    if (!confirmed) {
      setConfirmation({ kind: 'switch-branch', branch })
      return
    }
    await runTask('checkout', async () => {
      const next = await runWithEditorGuard(worktreePath, undefined, async () => {
        const checkedOut = await window.donwells.gitCheckout(worktreePath, branch)
        await reloadOpenPreviews(worktreePath)
        return checkedOut
      })
      setBranches(next)
      setBranchPickerOpen(false)
      setBranchSearch('')
      setSelected(new Set())
      await refreshStatuses()
    })
  }

  const createBranch = async (confirmed = false, requestedBranch?: string): Promise<void> => {
    const branch = requestedBranch ?? newBranch.trim()
    if (!branch || busy) return
    if (!confirmed) {
      setConfirmation({ kind: 'create-branch', branch })
      return
    }
    await runTask('create-branch', async () => {
      const next = await runWithEditorGuard(worktreePath, undefined, async () => {
        const created = await window.donwells.gitCreateBranch(worktreePath, branch, branches?.current ?? undefined)
        await reloadOpenPreviews(worktreePath)
        return created
      })
      setBranches(next)
      setNewBranch('')
      setBranchPickerOpen(false)
      setSelected(new Set())
      await refreshStatuses()
    })
  }

  const loadHistory = async (append: boolean): Promise<void> => {
    if (historyBusy || (append && !historyCursor)) return
    const generation = ++historyRequestRef.current
    setHistoryBusy(true)
    setHistoryError(null)
    try {
      const page = await window.donwells.gitHistory(worktreePath, { cursor: append ? historyCursor : undefined, limit: 25 })
      if (historyRequestRef.current !== generation) return
      setHistory((current) => append ? [...current, ...page.commits] : page.commits)
      setHistoryCursor(page.nextCursor)
    } catch (error: unknown) {
      if (historyRequestRef.current === generation) setHistoryError(errorMessage(error))
    } finally {
      if (historyRequestRef.current === generation) setHistoryBusy(false)
    }
  }

  const toggleHistory = (): void => {
    const opening = !historyOpen
    setHistoryOpen(opening)
    if (opening && (history.length === 0 || historyError)) void loadHistory(false)
  }

  const commit = async (confirmed = false, confirmedMessage?: string): Promise<void> => {
    const summary = confirmedMessage ?? message.trim()
    if (!summary || busy) return
    if (amend && !confirmed) {
      setConfirmation({ kind: 'amend', message: summary })
      return
    }
    await runTask(amend ? 'amend' : 'commit', async () => {
      await window.donwells.gitCommit(worktreePath, summary, { amend })
      setGitCommitDraft(worktreePath, '')
      setAmend(false)
      setHistory([])
      setHistoryError(null)
      setHistoryCursor(undefined)
      await refreshStatuses()
      if (historyOpen) await loadHistory(false)
      setNotice(amend ? 'Commit amended.' : 'Commit created.')
    })
  }

  const sync = async (operation: 'fetch' | 'pull' | 'push', confirmed = false): Promise<void> => {
    if (operation === 'push' && !confirmed) {
      setConfirmation({ kind: 'push', target: branches?.current ?? status?.branch ?? 'detached HEAD' })
      return
    }
    await runTask(operation, async () => {
      if (operation === 'fetch') await window.donwells.gitFetch(worktreePath)
      else if (operation === 'push') await window.donwells.gitPush(worktreePath)
      else {
        await runWithEditorGuard(worktreePath, undefined, async () => {
          await window.donwells.gitPull(worktreePath)
          await reloadOpenPreviews(worktreePath)
        })
      }
      await refreshGit()
      setNotice(operation === 'pull' ? 'Fast-forward pull complete.' : `${operation[0].toUpperCase()}${operation.slice(1)} complete.`)
    })
  }

  const confirmGitAction = async (): Promise<void> => {
    const action = confirmation
    if (!action || busy) return
    setConfirmation(null)
    if (action.kind === 'discard') await operate('discard', action.rows, true)
    else if (action.kind === 'switch-branch') await switchBranch(action.branch, true)
    else if (action.kind === 'create-branch') await createBranch(true, action.branch)
    else if (action.kind === 'amend') await commit(true, action.message)
    else await sync('push', true)
  }

  const handlePaneKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'a') {
      const target = event.target as HTMLElement
      if (target.matches('input, textarea')) return
      event.preventDefault()
      setSelected(new Set(allRows.map((row) => row.id)))
    } else if (event.key === 'Escape') {
      setSelected(new Set())
      setContextMenu(null)
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedRows.length > 0) {
      const target = event.target as HTMLElement
      if (target.matches('input, textarea')) return
      event.preventDefault()
      void operate('discard', selectedRows)
    }
  }

  const showContextMenu = (event: MouseEvent, row: GitRow): void => {
    event.preventDefault()
    if (!selected.has(row.id)) setSelected(new Set([row.id]))
    setContextMenu({ x: event.clientX, y: event.clientY, row })
  }

  if (!status) {
    return <div className="git-pane"><div className="git-loading" role="status">Loading source control…</div></div>
  }

  if (status.kind === 'folder') {
    return (
      <div className="git-pane git-pane-folder">
        <div className="git-pane-header"><Icon name="git" size={15} /><strong>Source control</strong></div>
        <div className="git-empty-state">
          <strong>Folder workspace</strong>
          <span>This folder is not a Git repository. File editing remains available; source control actions are unavailable.</span>
        </div>
      </div>
    )
  }

  const branchLabel = branches?.detached
    ? `Detached at ${(branches.headOid ?? status.headOid ?? '').slice(0, 8)}`
    : (branches?.current ?? status.branch) || 'No branch'
  const branchNeedle = branchSearch.trim().toLocaleLowerCase()
  const matchingBranches = (branches?.all ?? []).filter((branch) => branch.toLocaleLowerCase().includes(branchNeedle))
  const selectedStage = uniquePaths(selectedRows, 'stage').length
  const selectedUnstage = uniquePaths(selectedRows, 'unstage').length
  const selectedDiscard = uniquePaths(selectedRows, 'discard').length

  return (
    <div className="git-pane" onKeyDown={handlePaneKeyDown}>
      <div className="pane-header git-pane-header">
        <button className="btn btn-secondary btn-sm" onClick={() => void useAppStore.getState().openProjectTaskTool(worktreePath, 'lazygit').catch(reportError)}>Lazygit</button>
        <div className="git-pane-title"><Icon name="git" size={15} /><strong>Source control</strong></div>
        <button className="icon-btn" type="button" title="Refresh source control" aria-label="Refresh source control" disabled={busy !== null} onClick={() => void runTask('refresh', refreshGit)}>
          <Icon name="refresh" size={14} />
        </button>
      </div>

      <div className="git-branch-card">
        <div className="git-branch-summary">
          <span className="git-branch-name" title={branchLabel}>{branchLabel}</span>
          <span className="git-sync-state" aria-label={`${status.ahead} commits ahead and ${status.behind} behind`}>
            ↑ {status.ahead} · ↓ {status.behind}
          </span>
          <button className="btn btn-secondary btn-sm" type="button" disabled={!branches || busy !== null} aria-expanded={branchPickerOpen} onClick={() => setBranchPickerOpen((open) => !open)}>
            {!branches ? 'Loading branches…' : branchPickerOpen ? 'Close branches' : 'Switch branch'}
          </button>
        </div>
        {branchPickerOpen && branches && (
          <div className="git-branch-picker">
            <input className="input git-filter-input" autoFocus value={branchSearch} onChange={(event) => setBranchSearch(event.target.value)} placeholder="Filter local branches" aria-label="Filter local branches" />
            <div className="git-branch-results" role="listbox" aria-label="Local branches">
              {matchingBranches.length === 0 && <span className="git-muted">No matching branches</span>}
              {matchingBranches.map((branch) => (
                <button key={branch} type="button" role="option" aria-selected={branch === branches.current} disabled={busy !== null || branch === branches.current} onClick={() => void switchBranch(branch)}>
                  <span>{branch}</span>{branch === branches.current && <span>Current</span>}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="git-create-branch">
          <input className="input" value={newBranch} onChange={(event) => setNewBranch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createBranch() }} placeholder="New branch name" aria-label="New branch name" />
          <button className="btn btn-secondary" type="button" disabled={!newBranch.trim() || busy !== null} onClick={() => void createBranch()}>Create branch</button>
        </div>
        <div className="git-sync-actions" aria-label="Remote actions">
          <button className="btn btn-secondary btn-sm" type="button" disabled={busy !== null} onClick={() => void sync('fetch')}>Fetch</button>
          <button className="btn btn-secondary btn-sm" type="button" disabled={busy !== null} onClick={() => void sync('pull')}>Pull (ff-only)</button>
          <button className="btn btn-secondary btn-sm" type="button" disabled={busy !== null || status.detached} onClick={() => void sync('push')}>Push</button>
        </div>
      </div>

      {busy && <div className="git-notice" role="status">Working… {busy.replace(':', ' · ')}</div>}
      {notice && <div className={failures.length > 0 ? 'git-notice git-notice-error' : 'git-notice'} role={failures.length > 0 ? 'alert' : 'status'}>{notice}</div>}
      {failures.length > 0 && (
        <ul className="git-failure-list" aria-label="Source control failures">
          {failures.map((failure) => <li key={`${failure.path}:${failure.error}`}><code>{failure.path}</code><span>{failure.error}</span></li>)}
        </ul>
      )}

      {status.entries === undefined ? (
        <div className="git-empty-state" role="status">
          <strong>Path details unavailable</strong>
          <span>The connected host cannot provide typed source-control entries. Update the host to manage individual files safely.</span>
        </div>
      ) : (
        <>
          {selected.size > 0 && (
            <div className="git-selection-bar" aria-label={`${selected.size} selected source control rows`}>
              <strong>{selected.size} selected</strong>
              <button className="btn btn-secondary btn-sm" type="button" disabled={selectedStage === 0 || busy !== null} onClick={() => void operate('stage', selectedRows)}>Stage ({selectedStage})</button>
              <button className="btn btn-secondary btn-sm" type="button" disabled={selectedUnstage === 0 || busy !== null} onClick={() => void operate('unstage', selectedRows)}>Unstage ({selectedUnstage})</button>
              <button className="btn btn-danger btn-sm" type="button" disabled={selectedDiscard === 0 || busy !== null} onClick={() => void operate('discard', selectedRows)}>Discard ({selectedDiscard})</button>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => setSelected(new Set())}>Clear selection</button>
            </div>
          )}

          <div className="git-changes-list" role="listbox" aria-label="Changed files" aria-multiselectable="true">
            {sections.map((section) => section.rows.length > 0 && (
              <section className={`git-section git-section-${section.id}`} key={section.id} aria-labelledby={`${paneId}-git-${section.id}`}>
                <div className="git-section-title" id={`${paneId}-git-${section.id}`}>
                  <span>{section.title}</span><span>{section.rows.length}</span>
                </div>
                {section.rows.map((row) => {
                  const failure = failureByPath.get(row.entry.path)
                  return (
                    <div
                      className={`git-file-line${selected.has(row.id) ? ' selected' : ''}${failure ? ' failed' : ''}`}
                      key={row.id}
                      role="option"
                      aria-selected={selected.has(row.id)}
                      tabIndex={0}
                      title={failure}
                      onContextMenu={(event) => showContextMenu(event, row)}
                      onKeyDown={(event) => {
                        if (event.key === ' ') {
                          event.preventDefault()
                          toggleRow(row.id)
                        } else if (event.key === 'Enter') {
                          event.preventDefault()
                          openDiff(row)
                        }
                      }}
                    >
                      <input type="checkbox" checked={selected.has(row.id)} onChange={() => toggleRow(row.id)} aria-label={`Select ${displayPath(row.entry)}`} />
                      <button className="git-file-name" type="button" title={displayPath(row.entry)} onClick={() => openDiff(row)}>
                        <span>{displayPath(row.entry)}</span>
                      </button>
                      <span className="git-status-code" aria-label={`Git status ${displayCode(row)}`}>{displayCode(row)}</span>
                    </div>
                  )
                })}
              </section>
            ))}
            {allRows.length === 0 && <div className="git-clean-row"><span className="git-clean-dot" />Working tree clean</div>}
          </div>
        </>
      )}

      <div className="git-commit-box">
        <textarea className="input git-commit-input" rows={3} value={message} onChange={(event) => setGitCommitDraft(worktreePath, event.target.value)} placeholder="Commit message" aria-label="Commit message" />
        <label className="git-amend-toggle"><input type="checkbox" checked={amend} onChange={(event) => setAmend(event.target.checked)} />Amend current commit</label>
        <button className="btn btn-primary git-commit-button" type="button" disabled={!message.trim() || (!amend && status.staged === 0) || busy !== null} onClick={() => void commit()}>
          {busy === 'commit' || busy === 'amend' ? 'Committing…' : amend ? 'Amend commit' : `Commit ${status.staged || ''}`.trim()}
        </button>
      </div>

      <section className="git-history">
        <button className="git-history-toggle" type="button" aria-expanded={historyOpen} onClick={toggleHistory}>
          <span>History</span><span>{historyOpen ? 'Hide' : 'Show'}</span>
        </button>
        {historyOpen && (
          <div className="git-history-list">
            {history.map((commitEntry) => (
              <article className="git-history-row" key={commitEntry.oid} title={commitEntry.oid}>
                <code>{commitEntry.shortOid}</code>
                <div><strong>{commitEntry.subject}</strong><span>{commitEntry.author} · {formatCommitDate(commitEntry.authoredAt)}</span></div>
              </article>
            ))}
            {historyError && (
              <div className="git-empty-state" role="alert">
                <strong>History unavailable</strong><span>{historyError}</span>
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => void loadHistory(false)}>Retry</button>
              </div>
            )}
            {history.length === 0 && !historyBusy && !historyError && <div className="git-muted">No commits yet.</div>}
            {historyBusy && <div className="git-muted" role="status">Loading history…</div>}
            {historyCursor && !historyBusy && !historyError && <button className="btn btn-ghost" type="button" onClick={() => void loadHistory(true)}>Load older commits</button>}
          </div>
        )}
      </section>

      {confirmation && (
        <ModalDialog className="modal git-confirmation" labelledBy="git-confirmation-title" onClose={() => !busy && setConfirmation(null)}>
          <h3 id="git-confirmation-title" className="modal-title">
            {confirmation.kind === 'discard' ? 'Discard local changes?'
              : confirmation.kind === 'switch-branch' ? 'Switch branch?'
                : confirmation.kind === 'create-branch' ? 'Create and switch branch?'
                  : confirmation.kind === 'amend' ? 'Amend current commit?'
                    : 'Publish local commits?'}
          </h3>
          {confirmation.kind === 'discard' && (
            <>
              <p>The current contents of these exact paths will be discarded permanently:</p>
              <ul className="git-confirmation-paths">{confirmation.paths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
            </>
          )}
          {confirmation.kind === 'switch-branch' && <p>Switch this workspace to <strong>{confirmation.branch}</strong>? Open files are saved before checkout.</p>}
          {confirmation.kind === 'create-branch' && <p>Create and check out <strong>{confirmation.branch}</strong> from <strong>{branches?.current ?? 'the current HEAD'}</strong>? Open files are saved first.</p>}
          {confirmation.kind === 'amend' && <><p>This rewrites the current commit with the staged changes and this exact message:</p><blockquote>{confirmation.message}</blockquote></>}
          {confirmation.kind === 'push' && <p>Push <strong>{confirmation.target}</strong> to its configured remote? This publishes local commits outside this app.</p>}
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" disabled={busy !== null} onClick={() => setConfirmation(null)}>Cancel</button>
            <button type="button" className={confirmation.kind === 'discard' || confirmation.kind === 'amend' ? 'btn btn-danger' : 'btn btn-primary'} disabled={busy !== null} onClick={() => void confirmGitAction()}>
              {confirmation.kind === 'discard' ? 'Discard permanently'
                : confirmation.kind === 'switch-branch' ? 'Save and switch'
                  : confirmation.kind === 'create-branch' ? 'Create and switch'
                    : confirmation.kind === 'amend' ? 'Amend commit'
                      : 'Push to remote'}
            </button>
          </div>
        </ModalDialog>
      )}
      {contextMenu && (
        <div className="git-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
          <button role="menuitem" type="button" onClick={() => { openDiff(contextMenu.row); setContextMenu(null) }}>Open diff</button>
          {rowSupports(contextMenu.row, 'stage') && <button role="menuitem" type="button" onClick={() => { void operate('stage', [contextMenu.row]); setContextMenu(null) }}>Stage</button>}
          {rowSupports(contextMenu.row, 'unstage') && <button role="menuitem" type="button" onClick={() => { void operate('unstage', [contextMenu.row]); setContextMenu(null) }}>Unstage</button>}
          {rowSupports(contextMenu.row, 'discard') && <button className="git-danger-action" role="menuitem" type="button" onClick={() => { void operate('discard', [contextMenu.row]); setContextMenu(null) }}>Discard changes…</button>}
        </div>
      )}
    </div>
  )
}
