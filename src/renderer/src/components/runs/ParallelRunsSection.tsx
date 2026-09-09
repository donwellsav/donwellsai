import { PopupMenu } from 'flexlayout-react'
import { Icon } from '../Icon'
import { guiDraftMap } from '../../gui-drafts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OperationalTarget, ParallelRun, ParallelRunInput } from '@shared/operational-runs'
import { operationalTargetKey } from '@shared/operational-runs'
import { useAppStore } from '../../store'
import { ModalDialog } from '../ModalDialog'
import { RunStatus, formatRunTime, localOperationalTarget, targetDescription } from './RunStatus'

type Confirmation = { kind: 'cancel' | 'delete'; run: ParallelRun }
type OperationError = { key: string; message: string }

function runMayBeLive(run: ParallelRun): boolean {
  return run.status === 'queued' || run.status === 'running' || run.status === 'unverifiable' || run.status === 'cancelling'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

let pendingStart: Promise<boolean> | null = null
const emptyComposer = { name: '', command: '', concurrency: 4, selectedTargets: {} as Record<string, boolean>, composerOpen: false }

const composerDrafts = guiDraftMap<typeof emptyComposer>('parallel-composer')

export function ParallelRunsSection() {
  const composerDraft = composerDrafts.get('draft') ?? emptyComposer
  const repos = useAppStore((state) => state.repos)
  const targets = useMemo(() => {
    const unique = new Map<string, OperationalTarget>()
    for (const repo of repos) {
      for (const worktree of repo.worktrees) {
        const target = localOperationalTarget(worktree.path)
        unique.set(operationalTargetKey(target), target)
      }
    }
    return [...unique.values()]
  }, [repos])
  const listRequest = useRef(0)
  const [runs, setRuns] = useState<ParallelRun[]>([])
  const [name, setName] = useState(composerDraft.name)
  const [command, setCommand] = useState(composerDraft.command)
  const [concurrency, setConcurrency] = useState(composerDraft.concurrency)
  const [selectedTargets, setSelectedTargets] = useState<Record<string, boolean>>(() => {
    if (composerDrafts.has('draft')) return composerDraft.selectedTargets
    const current = targets.find(target => target.root === useAppStore.getState().activeWorktreePath)
    return current ? { [operationalTargetKey(current)]: true } : {}
  })
  const [menu, setMenu] = useState<{ anchor: HTMLElement; run: ParallelRun } | null>(null)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [selectedFailures, setSelectedFailures] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<string | null>(pendingStart ? 'start' : null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<OperationError | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [composerOpen, setComposerOpen] = useState(composerDraft.composerOpen)
  useEffect(() => { if (composerOpen) document.querySelector<HTMLTextAreaElement>('#parallel-run-composer textarea')?.focus() }, [composerOpen])

  useEffect(() => {
    let live = true
    if (pendingStart) void pendingStart.then(ok => {
      if (!live) return
      setBusy(null)
      if (ok) { const retained = composerDrafts.get('draft') ?? emptyComposer; setName(retained.name); setCommand(retained.command); setSelectedTargets(retained.selectedTargets); setComposerOpen(false); void refresh() }
      else setOperationError({ key: 'start', message: 'Start failed; the draft is retained. Check existing runs before retrying.' })
    })
    return () => { live = false }
  }, [])
  useEffect(() => { composerDrafts.set('draft', { name, command, concurrency, selectedTargets, composerOpen }) }, [name, command, concurrency, selectedTargets, composerOpen])

  const refresh = useCallback(async () => {
    const request = ++listRequest.current
    try {
      const result = await window.donwells.parallelRunsList()
      if (request !== listRequest.current) return
      setRuns(result)
      setLoadError(null)
    } catch (error) {
      if (request === listRequest.current) setLoadError(errorMessage(error))
    }
  }, [])

  useEffect(() => {
    void refresh()
    return () => { listRequest.current++ }
  }, [refresh])

  const hasLiveRuns = runs.some(runMayBeLive)
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), hasLiveRuns ? 1_500 : 5_000)
    return () => window.clearInterval(timer)
  }, [hasLiveRuns, refresh])

  const visibleRuns = runs.filter(run => `${run.name} ${run.command} ${run.tasks.map(task => task.target.root).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()))
  const chosenTargets = targets.filter((target) => selectedTargets[operationalTargetKey(target)])
  const runAction = async <Result,>(key: string, action: () => Promise<Result>, apply: (result: Result) => void): Promise<boolean> => {
    setBusy(key)
    setOperationError((current) => current?.key === key ? null : current)
    try {
      const result = await action()
      listRequest.current++
      apply(result)
      return true
    } catch (error) {
      setOperationError({ key, message: errorMessage(error) })
      return false
    } finally {
      setBusy(null)
    }
  }

  const start = async (): Promise<void> => {
    if (pendingStart) return
    const input: ParallelRunInput = {
      name: name.trim() || command.trim().split('\n')[0]!.slice(0, 256),
      command,
      targets: chosenTargets,
      concurrency
    }
    pendingStart = runAction('start', () => window.donwells.parallelRunStart(input), (run) => {
      setRuns((current) => [run, ...current.filter((candidate) => candidate.id !== run.id)])
      composerDrafts.delete('draft')
      setName('')
      setCommand('')
      setSelectedTargets({})
      setComposerOpen(false)
      setExpanded(run.id)
    }).finally(() => { pendingStart = null })
    await pendingStart
  }

  const retryFailures = async (run: ParallelRun): Promise<void> => {
    const taskIds = run.tasks.filter((task) => task.status === 'failed' && selectedFailures[task.id]).map((task) => task.id)
    await runAction(`retry:${run.id}`, () => window.donwells.parallelRunRetry(run.id, taskIds), (retry) => {
      setRuns((current) => [retry, ...current.filter((candidate) => candidate.id !== retry.id)])
      setSelectedFailures({})
      setExpanded(retry.id)
    })
  }

  const confirmOperation = async (): Promise<void> => {
    if (!confirmation) return
    const current = confirmation
    const key = `${current.kind}:${current.run.id}`
    const succeeded = current.kind === 'cancel'
      ? await runAction(key, () => window.donwells.parallelRunCancel(current.run.id), (updated) => {
          setRuns((runsNow) => runsNow.map((run) => run.id === updated.id ? updated : run))
        })
      : await runAction(key, () => window.donwells.parallelRunDelete(current.run.id), () => {
          setRuns((runsNow) => runsNow.filter((run) => run.id !== current.run.id))
          if (expanded === current.run.id) setExpanded(null)
        })
    if (succeeded) setConfirmation(null)
  }

  return (
    <div className="op-section">
      <div className="op-section-heading">
        <div>
          <p>{runs.length ? `${runs.length} command${runs.length === 1 ? '' : 's'}` : "Run a command in one or more project checkouts."}</p>
        </div>
        <button
          type="button"
          className={`btn ${composerOpen ? 'btn-secondary' : 'btn-primary'}`}
          aria-expanded={composerOpen}
          aria-controls="parallel-run-composer"
          onClick={() => {
            if (!command && !name && Object.keys(selectedTargets).length === 0) {
              const current = targets.find(target => target.root === useAppStore.getState().activeWorktreePath)
              if (current) setSelectedTargets({ [operationalTargetKey(current)]: true })
            }
            setComposerOpen(true)
          }}
        >
          <Icon name="plus" size={14} />New command
        </button>
      </div>

      {loadError && (
        <div className="op-inline-error" role="alert">
          <span>Could not load parallel run history: {loadError}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void refresh()}>Retry</button>
        </div>
      )}

      {composerOpen && (
        <ModalDialog className="modal op-setup-dialog" labelledBy="parallel-setup-title" onClose={() => { if (busy !== 'start') setComposerOpen(false) }}>
        <form onSubmit={event => { event.preventDefault(); void start() }}>
        <fieldset disabled={busy === 'start'} id="parallel-run-composer" className="op-composer" aria-label="Run command">
          <div className="op-composer-title">
            <h3 id="parallel-setup-title" className="modal-title">New command</h3>
            <button type="button" className="icon-btn" aria-label="Close command setup" title="Close setup and keep your draft" onClick={() => setComposerOpen(false)}><Icon name="x" size={14} /></button>
          </div>
          <div className="op-form-grid">
            <label className="modal-field op-command-field">Command
              <textarea autoFocus className="input op-command-input" rows={3} value={command} onChange={(event) => setCommand(event.target.value)} placeholder="For example: pnpm test" />
            </label>
          </div>
          <details><summary>Run options</summary><div className="op-form-grid">
            <label className="modal-field">Run name
              <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Optional label" />
            </label>
            <label className="modal-field">Run at once
              <input className="input" type="number" required min={1} max={16} onInvalid={event => event.currentTarget.closest('details')?.setAttribute('open', '')} value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))} />
            </label>
          </div></details>
          <div className="op-target-head">
            <span>Projects and checkouts</span>
            <button type="button" className="op-text-action" onClick={() => {
              const allSelected = chosenTargets.length === targets.length
              setSelectedTargets(Object.fromEntries(targets.map((target) => [operationalTargetKey(target), !allSelected])))
            }}>{chosenTargets.length === targets.length && targets.length > 0 ? 'Clear all' : 'Select all'}</button>
          </div>
          <div className="op-target-grid" role="group" aria-label="Parallel shell targets">
            {targets.map((target) => {
              const key = operationalTargetKey(target)
              return (
                <label key={key} className={`op-target${selectedTargets[key] ? ' selected' : ''}`} title={target.root}>
                  <input type="checkbox" checked={Boolean(selectedTargets[key])} onChange={(event) => setSelectedTargets((current) => ({ ...current, [key]: event.target.checked }))} />
                  <span><strong>{target.label}</strong><small>{target.root}</small></span>
                </label>
              )
            })}
            {targets.length === 0 && <div className="op-empty">Add a local folder or repository before starting a shell run.</div>}
          </div>
          {operationError?.key === 'start' && <div className="op-inline-error" role="alert">Start failed: {operationError.message}</div>}
          <div className="op-composer-footer">
            <span className="op-hint">{chosenTargets.length > 1 ? `Up to ${Math.min(Math.max(1, concurrency || 1), chosenTargets.length)} running at once.` : chosenTargets.length === 0 ? 'Select checkouts to run this command.' : ''}</span>
            <button type="submit" className="btn btn-primary" disabled={!command.trim() || chosenTargets.length === 0 || busy === 'start'}>{busy === 'start' ? 'Starting…' : `Run on ${chosenTargets.length} target${chosenTargets.length === 1 ? '' : 's'}`}</button>
          </div>
        </fieldset>
        </form>
        </ModalDialog>
      )}

      {(runs.length > 5 || query) && <input className="input" type="search" aria-label="Search command history" placeholder="Search commands or projects" value={query} onChange={event => setQuery(event.target.value)} />}
      {query && visibleRuns.length === 0 && <p className="op-empty" role="status">No commands match your search.</p>}
      <div className="op-list">
        {visibleRuns.map((run) => {
          const isExpanded = expanded === run.id
          const counts = run.tasks.reduce<Record<string, number>>((current, task) => {
            current[task.status] = (current[task.status] ?? 0) + 1
            return current
          }, {})
          const selectedFailureCount = run.tasks.filter((task) => task.status === 'failed' && selectedFailures[task.id]).length
          const runError = operationError?.key.endsWith(`:${run.id}`) ? operationError.message : null
          return (
            <article key={run.id} className={`op-run-card${isExpanded ? ' selected' : ''}`}>
              <div className="op-run-summary">
                <button type="button" className="op-run-main" onClick={() => setExpanded(isExpanded ? null : run.id)} aria-expanded={isExpanded}>
                  <RunStatus status={run.status} />
                  <span className="op-run-copy"><strong>{run.name}</strong><span>{run.tasks.length === 1 ? run.tasks[0]!.target.label : `${run.tasks.length} checkouts`} · {formatRunTime(run.createdAt)}</span></span>
                </button>
                <div className="op-actions">
                  <button type="button" className="icon-btn" aria-label={`Actions for ${run.name}`} title="Stop command or delete retained history" aria-haspopup="menu" disabled={Boolean(busy)} onClick={event => setMenu({ anchor: event.currentTarget, run })}><Icon name="more" size={14} /></button>
                </div>
              </div>
              {runError && <div className="op-inline-error" role="alert">Operation failed: {runError}</div>}
              {isExpanded && (
                <div className="op-run-detail">
                  {run.retryOfRunId && <p className="op-retry-note">Retry of run <code>{run.retryOfRunId}</code></p>}
                  <div className="op-counts" aria-label="Task status counts">{run.tasks.length > 1 && Object.entries(counts).map(([status, count]) => <span key={status}>{count} {status}</span>)}</div>
                  {run.name !== run.command.trim() && <pre className="op-command">{run.command}</pre>}
                  <div className="op-task-list">
                    {run.tasks.map((task) => (
                      <details key={task.id} className="op-task-row" open={run.tasks.length === 1}>
                        <summary>
                          {task.status === 'failed' ? <input type="checkbox" aria-label={`Select failed task ${task.target.label}`} checked={Boolean(selectedFailures[task.id])} onClick={(event) => event.stopPropagation()} onChange={(event) => setSelectedFailures((current) => ({ ...current, [task.id]: event.target.checked }))} /> : <span className="op-checkbox-space" />}
                          <RunStatus status={task.status} />
                          <span className="op-task-target"><strong>{task.target.label}</strong><small>{targetDescription(task.target.kind, task.target.root, task.target.kind === 'remote' ? task.target.connectionId : undefined)}</small></span>
                          <time>{formatRunTime(task.startedAt)}</time>
                          {task.exitCode !== undefined && <code>exit {task.exitCode}</code>}
                        </summary>
                        <div className="op-log-detail">
                          {task.retryOfTaskId && <p>Retry of task <code>{task.retryOfTaskId}</code></p>}
                          {task.error && <p className="op-run-error">{task.error}</p>}
                          <pre>{task.output || (task.status === 'queued' ? 'Waiting for an available concurrency slot.' : 'No output captured.')}</pre>
                        </div>
                      </details>
                    ))}
                  </div>
                  {run.tasks.some((task) => task.status === 'failed') && (
                    <div className="op-retry-bar">
                      <span>Select failed targets to create a separately tracked retry run.</span>
                      <button type="button" className="btn btn-secondary" title={runMayBeLive(run) ? 'Wait for all commands to finish and their state to be verified before retrying' : 'Run the selected failed checkouts again'} disabled={runMayBeLive(run) || selectedFailureCount === 0 || Boolean(busy)} onClick={() => void retryFailures(run)}>{busy === `retry:${run.id}` ? 'Retrying…' : `Retry selected (${selectedFailureCount})`}</button>
                    </div>
                  )}
                  {run.status === 'unverifiable' && <p className="op-unverifiable-note">One or more daemon jobs may still be live. This run cannot be deleted or safely retried until their state is reconciled.</p>}
                </div>
              )}
            </article>
          )
        })}


      </div>

      {menu && <PopupMenu anchor={menu.anchor} title="Command actions" onClose={() => setMenu(null)} items={[
        { key: 'action', label: runMayBeLive(menu.run) ? 'Cancel command…' : 'Delete history…', disabled: Boolean(busy), onSelect: () => setConfirmation({ kind: runMayBeLive(menu.run) ? 'cancel' : 'delete', run: menu.run }) }
      ]} />}
      {confirmation && (
        <ModalDialog className="modal op-confirm" labelledBy="parallel-run-confirm-title" onClose={() => { if (!busy) setConfirmation(null) }}>
          <span className="op-eyebrow">Confirm exact operation</span>
          <h3 id="parallel-run-confirm-title" className="modal-title">{confirmation.kind === 'cancel' ? `Cancel “${confirmation.run.name}”?` : `Delete “${confirmation.run.name}”?`}</h3>
          <p>{confirmation.kind === 'cancel' ? 'Queued commands will be cancelled immediately. Live daemon jobs are only marked Cancelled after every stop request is acknowledged; unknown jobs remain Unverifiable.' : 'This permanently removes the run, task outcomes, errors and retained output from bounded local history.'}</p>
          <pre className="op-confirm-command">{confirmation.run.command}</pre>
          <p className="op-confirm-fact">{confirmation.run.tasks.length} exact target{confirmation.run.tasks.length === 1 ? '' : 's'}</p>
          {operationError?.key === `${confirmation.kind}:${confirmation.run.id}` && <div className="op-inline-error" role="alert">{operationError.message}</div>}
          <div className="modal-actions">
            <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => setConfirmation(null)}>Keep run</button>
            <button type="button" className="btn btn-danger" disabled={Boolean(busy)} onClick={() => void confirmOperation()}>{busy ? (confirmation.kind === 'cancel' ? 'Cancelling…' : 'Deleting…') : (confirmation.kind === 'cancel' ? 'Cancel run' : 'Delete history')}</button>
          </div>
        </ModalDialog>
      )}
    </div>
  )
}
