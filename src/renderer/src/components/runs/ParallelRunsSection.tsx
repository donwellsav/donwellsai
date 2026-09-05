import { useCallback, useEffect, useMemo, useState } from 'react'
import type { OperationalTarget, ParallelRun, ParallelRunInput, ParallelRunTask } from '@shared/operational-runs'
import { operationalTargetKey } from '@shared/operational-runs'
import { useAppStore } from '../../store'
import { ModalDialog } from '../ModalDialog'
import { RunStatus, formatRunTime, localOperationalTarget, targetDescription } from './RunStatus'

type Props = { onError(error: unknown): void }
type Confirmation = { kind: 'cancel' | 'delete'; run: ParallelRun }

function runMayBeLive(run: ParallelRun): boolean {
  return run.status === 'queued' || run.status === 'running' || run.status === 'unverifiable' || run.status === 'cancelling'
}

function taskSearchText(task: ParallelRunTask): string {
  return [task.target.label, task.target.root, task.status, task.error ?? '', task.output ?? '', String(task.exitCode ?? '')].join('\n').toLocaleLowerCase()
}

export function ParallelRunsSection({ onError }: Props) {
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
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [composerOpen, setComposerOpen] = useState(false)

  const refresh = useCallback(async () => {
    setRuns(await window.donwells.parallelRunsList())
  }, [])

  useEffect(() => {
    void refresh().catch(onError)
  }, [onError, refresh])

  const hasLiveRuns = runs.some(runMayBeLive)
  useEffect(() => {
    if (!hasLiveRuns) return
    const timer = window.setInterval(() => void refresh().catch(onError), 1_500)
    return () => window.clearInterval(timer)
  }, [hasLiveRuns, onError, refresh])

  const chosenTargets = targets.filter((target) => selectedTargets[operationalTargetKey(target)])
  const matchingRuns = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return runs
    return runs.filter((run) => [
      run.name,
      run.command,
      run.status,
      ...run.tasks.map(taskSearchText)
    ].some((value) => value.toLocaleLowerCase().includes(needle)))
  }, [query, runs])

  const runAction = async (key: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    try {
      await action()
      await refresh()
    } catch (error) {
      onError(error)
    } finally {
      setBusy(null)
    }
  }

  const start = async (): Promise<void> => {
    const input: ParallelRunInput = {
      name: name.trim() || `Command · ${new Date().toLocaleTimeString()}`,
      command,
      targets: chosenTargets,
      concurrency
    }
    await runAction('start', async () => {
      const run = await window.donwells.parallelRunStart(input)
      setName('')
      setCommand('')
      setSelectedTargets({})
      setComposerOpen(false)
      setExpanded(run.id)
    })
  }

  const retryFailures = async (run: ParallelRun): Promise<void> => {
    const taskIds = run.tasks.filter((task) => task.status === 'failed' && selectedFailures[task.id]).map((task) => task.id)
    await runAction(`retry:${run.id}`, async () => {
      const retry = await window.donwells.parallelRunRetry(run.id, taskIds)
      setSelectedFailures({})
      setExpanded(retry.id)
    })
  }

  return (
    <div className="op-section">
      <div className="op-section-heading">
        <div>
          <span className="op-eyebrow">Bounded fan-out</span>
          <h3>Parallel runs</h3>
          <p>Review retained outcomes first, or launch one finite command per target with explicit concurrency.</p>
        </div>
        <button
          className={`btn ${composerOpen ? 'btn-secondary' : 'btn-primary'}`}
          aria-expanded={composerOpen}
          aria-controls="parallel-run-composer"
          onClick={() => setComposerOpen((open) => !open)}
        >
          {composerOpen ? 'Close setup' : 'New run'}
        </button>
      </div>

      {composerOpen && (
        <div id="parallel-run-composer" className="op-composer" aria-label="Create parallel run">
        <div className="op-composer-title"><div><span className="op-eyebrow">New run</span><h4>Command across targets</h4></div><span className="op-count">{chosenTargets.length} selected</span></div>
        <div className="op-form-grid">
          <label className="modal-field">Run name
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Optional label" />
          </label>
          <label className="modal-field">Max concurrency
            <input className="input" type="number" min={1} max={16} value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))} />
          </label>
          <label className="modal-field op-command-field">Command
            <textarea className="input op-command-input" rows={3} value={command} onChange={(event) => setCommand(event.target.value)} placeholder="Finite shell command, for example: pnpm test" />
          </label>
        </div>
        <div className="op-target-head">
          <span>Registered folders & worktrees</span>
          <button className="op-text-action" onClick={() => {
            const allSelected = chosenTargets.length === targets.length
            setSelectedTargets(Object.fromEntries(targets.map((target) => [operationalTargetKey(target), !allSelected])))
          }}>{chosenTargets.length === targets.length && targets.length > 0 ? 'Clear all' : 'Select all'}</button>
        </div>
        <div className="op-target-grid" role="group" aria-label="Parallel run targets">
          {targets.map((target) => {
            const key = operationalTargetKey(target)
            return (
              <label key={key} className={`op-target${selectedTargets[key] ? ' selected' : ''}`} title={target.root}>
                <input type="checkbox" checked={Boolean(selectedTargets[key])} onChange={(event) => setSelectedTargets((current) => ({ ...current, [key]: event.target.checked }))} />
                <span><strong>{target.label}</strong><small>{target.root}</small></span>
              </label>
            )
          })}
          {targets.length === 0 && <div className="op-empty">Add a folder or repository before starting an operational run.</div>}
        </div>
        <div className="op-composer-footer">
          <span className="op-hint">At most {Math.min(Math.max(1, concurrency || 1), chosenTargets.length || 1)} tasks will be live at once.</span>
          <button className="btn btn-primary" disabled={!command.trim() || chosenTargets.length === 0 || concurrency < 1 || concurrency > 16 || busy === 'start'} onClick={() => void start()}>{busy === 'start' ? 'Starting…' : `Run on ${chosenTargets.length} target${chosenTargets.length === 1 ? '' : 's'}`}</button>
        </div>
        </div>
      )}

      <div className="op-toolbar">
        <label className="op-search"><span className="sr-only">Search parallel run history</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search runs, targets, output, errors…" /></label>
        <span className="op-count">{matchingRuns.length} of {runs.length}</span>
      </div>

      <div className="op-list">
        {matchingRuns.map((run) => {
          const isExpanded = expanded === run.id
          const counts = run.tasks.reduce<Record<string, number>>((current, task) => {
            current[task.status] = (current[task.status] ?? 0) + 1
            return current
          }, {})
          const selectedFailureCount = run.tasks.filter((task) => task.status === 'failed' && selectedFailures[task.id]).length
          return (
            <article key={run.id} className={`op-run-card${isExpanded ? ' selected' : ''}`}>
              <div className="op-run-summary">
                <button className="op-run-main" onClick={() => setExpanded(isExpanded ? null : run.id)} aria-expanded={isExpanded}>
                  <RunStatus status={run.status} />
                  <span className="op-run-copy"><strong>{run.name}</strong><span>{run.tasks.length} targets · concurrency {run.concurrency} · {formatRunTime(run.createdAt)}</span></span>
                </button>
                <div className="op-card-state op-counts" aria-label="Task status counts">
                  {Object.entries(counts).map(([status, count]) => <span key={status}>{count} {status}</span>)}
                </div>
                <div className="op-actions">
                  {runMayBeLive(run) && <button className="btn btn-danger btn-sm" disabled={busy === `cancel:${run.id}`} onClick={() => setConfirmation({ kind: 'cancel', run })}>{busy === `cancel:${run.id}` ? 'Cancelling…' : 'Cancel…'}</button>}
                  {!runMayBeLive(run) && <button className="btn btn-secondary btn-sm" onClick={() => setConfirmation({ kind: 'delete', run })}>Delete…</button>}
                </div>
              </div>
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
                      <span>Select failed targets to create a new, independently tracked retry run.</span>
                      <button className="btn btn-secondary" disabled={selectedFailureCount === 0 || busy === `retry:${run.id}`} onClick={() => void retryFailures(run)}>{busy === `retry:${run.id}` ? 'Retrying…' : `Retry selected (${selectedFailureCount})`}</button>
                    </div>
                  )}
                  {run.status === 'unverifiable' && <p className="op-unverifiable-note">One or more daemon jobs may still be live. This run cannot be deleted or safely retried until their state is reconciled.</p>}
                </div>
              )}
            </article>
          )
        })}
        {runs.length === 0 && (
          <div className="op-empty op-first-run-empty">
            <strong>No parallel run history yet</strong>
            <span>Start with a finite command across one or more registered targets.</span>
            <button className="btn btn-primary btn-sm" onClick={() => setComposerOpen(true)}>Create first run</button>
          </div>
        )}
        {runs.length > 0 && matchingRuns.length === 0 && <div className="op-empty">No runs match this search.</div>}
      </div>

      {confirmation && (
        <ModalDialog className="modal op-confirm" labelledBy="parallel-run-confirm-title" onClose={() => setConfirmation(null)}>
          <span className="op-eyebrow">Confirm operation</span>
          <h3 id="parallel-run-confirm-title" className="modal-title">{confirmation.kind === 'cancel' ? `Cancel “${confirmation.run.name}”?` : `Delete “${confirmation.run.name}”?`}</h3>
          <p>{confirmation.kind === 'cancel' ? 'Queued tasks will be cancelled immediately. Live daemon jobs will only be marked Cancelled after every stop request is acknowledged; unknown jobs remain Unverifiable.' : 'This removes the run, its task outcomes, errors, and retained output from bounded history.'}</p>
          <div className="modal-actions">
            <button className="btn" onClick={() => setConfirmation(null)}>Keep</button>
            <button className="btn btn-danger" onClick={() => {
              const current = confirmation
              setConfirmation(null)
              if (current.kind === 'cancel') void runAction(`cancel:${current.run.id}`, () => window.donwells.parallelRunCancel(current.run.id))
              else void runAction(`delete:${current.run.id}`, () => window.donwells.parallelRunDelete(current.run.id))
            }}>{confirmation.kind === 'cancel' ? 'Cancel run' : 'Delete history'}</button>
          </div>
        </ModalDialog>
      )}
    </div>
  )
}
