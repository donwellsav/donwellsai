import { useCallback, useEffect, useMemo, useState } from 'react'
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

export function ParallelRunsSection() {
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
  const [runs, setRuns] = useState<ParallelRun[]>([])
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [concurrency, setConcurrency] = useState(4)
  const [selectedTargets, setSelectedTargets] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [selectedFailures, setSelectedFailures] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<OperationError | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [composerOpen, setComposerOpen] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setRuns(await window.donwells.parallelRunsList())
      setLoadError(null)
    } catch (error) {
      setLoadError(errorMessage(error))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const hasLiveRuns = runs.some(runMayBeLive)
  useEffect(() => {
    if (!hasLiveRuns) return
    const timer = window.setInterval(() => void refresh(), 1_500)
    return () => window.clearInterval(timer)
  }, [hasLiveRuns, refresh])

  const chosenTargets = targets.filter((target) => selectedTargets[operationalTargetKey(target)])
  const runAction = async <Result,>(key: string, action: () => Promise<Result>, apply: (result: Result) => void): Promise<boolean> => {
    setBusy(key)
    setOperationError((current) => current?.key === key ? null : current)
    try {
      apply(await action())
      return true
    } catch (error) {
      setOperationError({ key, message: errorMessage(error) })
      return false
    } finally {
      setBusy(null)
    }
  }

  const start = async (): Promise<void> => {
    const input: ParallelRunInput = {
      name: name.trim() || `Shell fan-out · ${new Date().toLocaleTimeString()}`,
      command,
      targets: chosenTargets,
      concurrency
    }
    await runAction('start', () => window.donwells.parallelRunStart(input), (run) => {
      setRuns((current) => [run, ...current.filter((candidate) => candidate.id !== run.id)])
      setName('')
      setCommand('')
      setSelectedTargets({})
      setComposerOpen(false)
      setExpanded(run.id)
    })
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
          <span className="op-eyebrow">Finite shell fan-out</span>
          <h3>Parallel shells</h3>
          <p>Run the same bounded shell command in selected local folders or worktrees. This does not start AI agents.</p>
        </div>
        <button
          type="button"
          className={`btn ${composerOpen ? 'btn-secondary' : 'btn-primary'}`}
          aria-expanded={composerOpen}
          aria-controls="parallel-run-composer"
          onClick={() => setComposerOpen((open) => !open)}
        >
          {composerOpen ? 'Close setup' : 'New shell run'}
        </button>
      </div>

      {loadError && (
        <div className="op-inline-error" role="alert">
          <span>Could not load parallel run history: {loadError}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void refresh()}>Retry</button>
        </div>
      )}

      {composerOpen && (
        <div id="parallel-run-composer" className="op-composer" aria-label="Create parallel shell run">
          <div className="op-composer-title">
            <div><span className="op-eyebrow">New shell run</span><h4>One command, exact targets</h4></div>
            <span className="op-count">{chosenTargets.length} selected</span>
          </div>
          <div className="op-form-grid">
            <label className="modal-field">Run name
              <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Optional label" />
            </label>
            <label className="modal-field">Max concurrency
              <input className="input" type="number" min={1} max={16} value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))} />
            </label>
            <label className="modal-field op-command-field">Finite shell command
              <textarea className="input op-command-input" rows={3} value={command} onChange={(event) => setCommand(event.target.value)} placeholder="For example: pnpm test" />
            </label>
          </div>
          <div className="op-target-head">
            <span>Local folders & worktrees</span>
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
            <span className="op-hint">At most {Math.min(Math.max(1, concurrency || 1), chosenTargets.length || 1)} commands will be live at once.</span>
            <button type="button" className="btn btn-primary" disabled={!command.trim() || chosenTargets.length === 0 || concurrency < 1 || concurrency > 16 || busy === 'start'} onClick={() => void start()}>{busy === 'start' ? 'Starting…' : `Run on ${chosenTargets.length} target${chosenTargets.length === 1 ? '' : 's'}`}</button>
          </div>
        </div>
      )}

      <div className="op-list">
        {runs.map((run) => {
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
                  <span className="op-run-copy"><strong>{run.name}</strong><span>{run.tasks.length} targets · concurrency {run.concurrency} · {formatRunTime(run.createdAt)}</span></span>
                </button>
                <div className="op-card-state op-counts" aria-label="Task status counts">
                  {Object.entries(counts).map(([status, count]) => <span key={status}>{count} {status}</span>)}
                </div>
                <div className="op-actions">
                  {runMayBeLive(run) && <button type="button" className="btn btn-danger btn-sm" disabled={busy === `cancel:${run.id}`} onClick={() => setConfirmation({ kind: 'cancel', run })}>{busy === `cancel:${run.id}` ? 'Cancelling…' : 'Cancel…'}</button>}
                  {!runMayBeLive(run) && <button type="button" className="btn btn-secondary btn-sm" disabled={busy === `delete:${run.id}`} onClick={() => setConfirmation({ kind: 'delete', run })}>Delete…</button>}
                </div>
              </div>
              {runError && <div className="op-inline-error" role="alert">Operation failed: {runError}</div>}
              {isExpanded && (
                <div className="op-run-detail">
                  {run.retryOfRunId && <p className="op-retry-note">Retry of run <code>{run.retryOfRunId}</code></p>}
                  <pre className="op-command">{run.command}</pre>
                  <div className="op-task-list">
                    {run.tasks.map((task) => (
                      <details key={task.id} className="op-task-row">
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
                      <button type="button" className="btn btn-secondary" disabled={selectedFailureCount === 0 || busy === `retry:${run.id}`} onClick={() => void retryFailures(run)}>{busy === `retry:${run.id}` ? 'Retrying…' : `Retry selected (${selectedFailureCount})`}</button>
                    </div>
                  )}
                  {run.status === 'unverifiable' && <p className="op-unverifiable-note">One or more daemon jobs may still be live. This run cannot be deleted or safely retried until their state is reconciled.</p>}
                </div>
              )}
            </article>
          )
        })}
        {runs.length === 0 && !loadError && (
          <div className="op-empty op-first-run-empty">
            <strong>No parallel shell history yet</strong>
            <span>Start with a finite command across one or more registered local targets.</span>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setComposerOpen(true)}>Create first shell run</button>
          </div>
        )}

      </div>

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
