import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  OperationalTarget,
  ScheduledExecution,
  ScheduledRunDefinition,
  ScheduledRunInput
} from '@shared/operational-runs'
import { operationalTargetKey } from '@shared/operational-runs'
import { useAppStore } from '../../store'
import { ModalDialog } from '../ModalDialog'
import { RunStatus, formatRunTime, localOperationalTarget, targetDescription } from './RunStatus'

type ScheduleDraft = ScheduledRunInput
type OperationError = { key: string; message: string }
type Confirmation =
  | { kind: 'delete'; definition: ScheduledRunDefinition }
  | { kind: 'cancel'; execution: ScheduledExecution; definition: ScheduledRunDefinition }

const COMMON_TIME_ZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'Europe/London',
  'Europe/Paris',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Australia/Sydney'
]

function emptyDraft(target: OperationalTarget | undefined): ScheduleDraft {
  return {
    name: '',
    target: target ?? { kind: 'local', root: '/', label: '/' },
    command: '',
    schedule: { kind: 'interval', minutes: 30 },
    enabled: true
  }
}

function scheduleText(definition: ScheduledRunDefinition): string {
  if (definition.schedule.kind === 'interval') return `Every ${definition.schedule.minutes} min`
  return `Daily at ${definition.schedule.time} · ${definition.schedule.timeZone}`
}

function executionMayBeLive(execution: ScheduledExecution): boolean {
  return execution.status === 'running' || execution.status === 'cancelling' || execution.status === 'unverifiable'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function ScheduledRunsSection() {
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
  const [definitions, setDefinitions] = useState<ScheduledRunDefinition[]>([])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [history, setHistory] = useState<ScheduledExecution[]>([])
  const [draft, setDraft] = useState<ScheduleDraft | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<OperationError | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)

  const refreshDefinitions = useCallback(async () => {
    try {
      setDefinitions(await window.donwells.scheduledRunsList())
      setLoadError(null)
    } catch (error) {
      setLoadError(errorMessage(error))
    }
  }, [])

  const refreshHistory = useCallback(async (id: string) => {
    try {
      setHistory(await window.donwells.scheduledRunHistory(id))
      setHistoryError(null)
    } catch (error) {
      setHistoryError(errorMessage(error))
    }
  }, [])

  useEffect(() => {
    void refreshDefinitions()
  }, [refreshDefinitions])

  useEffect(() => {
    if (!selectedId) {
      setHistory([])
      setHistoryError(null)
      return
    }
    void refreshHistory(selectedId)
  }, [refreshHistory, selectedId])

  const hasLiveHistory = history.some(executionMayBeLive)
  useEffect(() => {
    if (!selectedId || !hasLiveHistory) return
    const timer = window.setInterval(() => {
      void refreshDefinitions()
      void refreshHistory(selectedId)
    }, 1_500)
    return () => window.clearInterval(timer)
  }, [hasLiveHistory, refreshDefinitions, refreshHistory, selectedId])

  useEffect(() => {
    if (!draft || draft.id || targets.length === 0 || draft.target.root !== '/') return
    setDraft({ ...draft, target: targets[0]! })
  }, [draft, targets])


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

  const saveDraft = async (): Promise<void> => {
    if (!draft) return
    await runAction('save', () => window.donwells.scheduledRunSave(draft), (saved) => {
      setDefinitions((current) => [saved, ...current.filter((definition) => definition.id !== saved.id)])
      setDraft(null)
      setSelectedId(saved.id)
    })
  }

  const confirmOperation = async (): Promise<void> => {
    if (!confirmation) return
    const current = confirmation
    const succeeded = current.kind === 'delete'
      ? await runAction(`delete:${current.definition.id}`, () => window.donwells.scheduledRunDelete(current.definition.id), () => {
          setDefinitions((definitionsNow) => definitionsNow.filter((definition) => definition.id !== current.definition.id))
          if (selectedId === current.definition.id) setSelectedId(null)
        })
      : await runAction(`cancel:${current.execution.id}`, () => window.donwells.scheduledRunCancel(current.execution.id), (updated) => {
          setHistory((historyNow) => historyNow.map((execution) => execution.id === updated.id ? updated : execution))
        })
    if (succeeded) setConfirmation(null)
  }

  const targetChoices = useMemo(() => {
    if (!draft) return targets
    const key = operationalTargetKey(draft.target)
    return targets.some((target) => operationalTargetKey(target) === key) ? targets : [draft.target, ...targets]
  }, [draft, targets])

  const draftValid = Boolean(draft?.name.trim() && draft.command.trim() && (
    draft.schedule.kind === 'interval'
      ? draft.schedule.minutes >= 1 && draft.schedule.minutes <= 525_600
      : draft.schedule.time.length > 0 && draft.schedule.timeZone.trim().length > 0
  ))

  return (
    <div className="op-section">
      <div className="op-section-heading">
        <div>
          <span className="op-eyebrow">Finite local automation</span>
          <h3>Scheduled shells</h3>
          <p>Run a bounded shell command on an interval or daily wall-clock time. A schedule never overlaps itself.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setDraft(emptyDraft(targets[0]))} disabled={targets.length === 0}>
          New schedule
        </button>
      </div>

      {loadError && (
        <div className="op-inline-error" role="alert">
          <span>Could not load schedules: {loadError}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void refreshDefinitions()}>Retry</button>
        </div>
      )}

      {draft && (
        <div className="op-composer" aria-label={draft.id ? 'Edit scheduled shell' : 'Create scheduled shell'}>
          <div className="op-composer-title">
            <div><span className="op-eyebrow">{draft.id ? 'Editing schedule' : 'New schedule'}</span><h4>{draft.id ? draft.name : 'Schedule a finite command'}</h4></div>
            <button type="button" className="icon-btn" aria-label="Discard schedule editor" onClick={() => setDraft(null)}>×</button>
          </div>
          <div className="op-form-grid">
            <label className="modal-field">Name
              <input className="input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </label>
            <label className="modal-field">Exact target
              <select
                className="input"
                value={operationalTargetKey(draft.target)}
                onChange={(event) => {
                  const target = targetChoices.find((candidate) => operationalTargetKey(candidate) === event.target.value)
                  if (target) setDraft({ ...draft, target })
                }}
              >
                {targetChoices.map((target) => <option key={operationalTargetKey(target)} value={operationalTargetKey(target)}>{target.label} · {target.root}</option>)}
              </select>
            </label>
            <label className="modal-field op-command-field">Finite shell command
              <textarea className="input op-command-input" rows={3} value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} />
            </label>
            <label className="modal-field">Trigger
              <select
                className="input"
                value={draft.schedule.kind}
                onChange={(event) => setDraft({
                  ...draft,
                  schedule: event.target.value === 'daily'
                    ? { kind: 'daily', time: '09:00', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }
                    : { kind: 'interval', minutes: 30 }
                })}
              >
                <option value="interval">Interval</option>
                <option value="daily">Daily wall-clock time</option>
              </select>
            </label>
            {draft.schedule.kind === 'interval' ? (
              <label className="modal-field">Minutes
                <input className="input" type="number" min={1} max={525600} value={draft.schedule.minutes} onChange={(event) => setDraft({ ...draft, schedule: { ...draft.schedule, minutes: Number(event.target.value) } })} />
              </label>
            ) : (
              <>
                <label className="modal-field">Local time
                  <input className="input" type="time" value={draft.schedule.time} onChange={(event) => setDraft({ ...draft, schedule: { ...draft.schedule, time: event.target.value } })} />
                </label>
                <label className="modal-field">IANA time zone
                  <input className="input" list="op-common-time-zones" value={draft.schedule.timeZone} onChange={(event) => setDraft({ ...draft, schedule: { ...draft.schedule, timeZone: event.target.value } })} />
                  <datalist id="op-common-time-zones">{COMMON_TIME_ZONES.map((zone) => <option key={zone} value={zone} />)}</datalist>
                </label>
              </>
            )}
          </div>
          <div className="op-target-fact"><strong>Will run in</strong><span>{targetDescription(draft.target.kind, draft.target.root, draft.target.kind === 'remote' ? draft.target.connectionId : undefined)}</span></div>
          {operationError?.key === 'save' && <div className="op-inline-error" role="alert">Save failed: {operationError.message}</div>}
          <div className="op-composer-footer">
            <label className="op-switch"><input type="checkbox" checked={draft.enabled ?? true} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> Enable after saving</label>
            <button type="button" className="btn btn-secondary" disabled={busy === 'save'} onClick={() => setDraft(null)}>Discard</button>
            <button type="button" className="btn btn-primary" disabled={!draftValid || busy === 'save'} onClick={() => void saveDraft()}>{busy === 'save' ? 'Saving…' : 'Save schedule'}</button>
          </div>
        </div>
      )}

      <div className="op-list">
        {definitions.map((definition) => {
          const selected = selectedId === definition.id
          const definitionError = operationError?.key.endsWith(`:${definition.id}`) ? operationError.message : null
          return (
            <article key={definition.id} className={`op-run-card${selected ? ' selected' : ''}`}>
              <div className="op-run-summary">
                <button type="button" className="op-run-main" onClick={() => setSelectedId(selected ? null : definition.id)} aria-expanded={selected}>
                  <span className={`op-live-dot${definition.enabled ? ' enabled' : ''}`} aria-hidden="true" />
                  <span className="op-run-copy">
                    <strong>{definition.name}</strong>
                    <span>{definition.target.label} · {scheduleText(definition)}</span>
                  </span>
                </button>
                <div className="op-card-state">
                  {definition.lastStatus && <RunStatus status={definition.lastStatus} />}
                  <span className="op-next">{definition.enabled ? `Next ${formatRunTime(definition.nextRunAt)}` : 'Paused'}</span>
                </div>
                <div className="op-actions">
                  <button type="button" className="btn btn-secondary btn-sm" disabled={Boolean(busy)} onClick={() => void runAction(`enable:${definition.id}`, () => window.donwells.scheduledRunSetEnabled(definition.id, !definition.enabled), (updated) => {
                    setDefinitions((current) => current.map((entry) => entry.id === updated.id ? updated : entry))
                  })}>{busy === `enable:${definition.id}` ? 'Saving…' : definition.enabled ? 'Pause' : 'Enable'}</button>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={Boolean(busy)} onClick={() => setDraft({ id: definition.id, name: definition.name, target: definition.target, command: definition.command, schedule: definition.schedule, enabled: definition.enabled })}>Edit</button>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={Boolean(busy)} onClick={() => void runAction(`run:${definition.id}`, () => window.donwells.scheduledRunRunNow(definition.id), (execution) => {
                    setSelectedId(definition.id)
                    setHistory((current) => [execution, ...current.filter((entry) => entry.id !== execution.id)])
                  })}>{busy === `run:${definition.id}` ? 'Starting…' : 'Run now'}</button>
                  <details className="op-more"><summary aria-label={`More actions for ${definition.name}`}>•••</summary><div className="op-more-menu">
                    <button type="button" disabled={Boolean(busy)} onClick={() => void runAction(`duplicate:${definition.id}`, () => window.donwells.scheduledRunDuplicate(definition.id), (copy) => {
                      setDefinitions((current) => [copy, ...current])
                    })}>Duplicate paused</button>
                    <button type="button" className="danger" disabled={Boolean(busy)} onClick={() => setConfirmation({ kind: 'delete', definition })}>Delete…</button>
                  </div></details>
                </div>
              </div>
              {definitionError && <div className="op-inline-error" role="alert">Operation failed: {definitionError}</div>}
              {selected && (
                <div className="op-run-detail">
                  <div className="op-detail-meta">
                    <span><b>Target</b>{targetDescription(definition.target.kind, definition.target.root, definition.target.kind === 'remote' ? definition.target.connectionId : undefined)}</span>
                    <span><b>Created</b>{formatRunTime(definition.createdAt)}</span>
                    <span><b>Last run</b>{formatRunTime(definition.lastRunAt)}</span>
                  </div>
                  <pre className="op-command">{definition.command}</pre>
                  <div className="op-history-head"><h4>Execution history</h4></div>
                  {historyError && <div className="op-inline-error" role="alert"><span>Could not load history: {historyError}</span><button type="button" className="btn btn-secondary btn-sm" onClick={() => void refreshHistory(definition.id)}>Retry</button></div>}
                  <div className="op-history">
                    {history.map((execution) => (
                      <details key={execution.id} className="op-history-row">
                        <summary>
                          <RunStatus status={execution.status} />
                          <span>{execution.trigger === 'manual' ? 'Manual' : 'Scheduled'}</span>
                          <time>{formatRunTime(execution.startedAt)}</time>
                          {execution.exitCode !== undefined && <code>exit {execution.exitCode}</code>}
                        </summary>
                        <div className="op-log-detail">
                          {execution.error && <p className="op-run-error">{execution.error}</p>}
                          <pre>{execution.output || (execution.status === 'running' ? 'Running; no output captured yet.' : 'No output captured.')}</pre>
                          {executionMayBeLive(execution) && <button type="button" className="btn btn-danger btn-sm" disabled={Boolean(busy)} onClick={() => setConfirmation({ kind: 'cancel', execution, definition })}>Cancel execution…</button>}
                        </div>
                      </details>
                    ))}
                    {!historyError && history.length === 0 && <div className="op-empty">No execution history yet.</div>}
                  </div>
                </div>
              )}
            </article>
          )
        })}
        {definitions.length === 0 && !loadError && <div className="op-empty">No schedules yet. Create one for a registered local folder or worktree.</div>}
      </div>

      {confirmation && (
        <ModalDialog className="modal op-confirm" labelledBy="scheduled-run-confirm-title" onClose={() => { if (!busy) setConfirmation(null) }}>
          <span className="op-eyebrow">Confirm exact operation</span>
          <h3 id="scheduled-run-confirm-title" className="modal-title">{confirmation.kind === 'delete' ? `Delete “${confirmation.definition.name}”?` : `Cancel “${confirmation.definition.name}” execution?`}</h3>
          <p>{confirmation.kind === 'delete' ? 'This permanently removes the schedule and its bounded execution history. Running or unverifiable executions cannot be deleted.' : 'The daemon will be asked to stop this finite command. The UI reports Cancelled only after that request is acknowledged.'}</p>
          <pre className="op-confirm-command">{confirmation.definition.command}</pre>
          <p className="op-confirm-fact">{targetDescription(confirmation.definition.target.kind, confirmation.definition.target.root, confirmation.definition.target.kind === 'remote' ? confirmation.definition.target.connectionId : undefined)}</p>
          {operationError?.key === (confirmation.kind === 'delete' ? `delete:${confirmation.definition.id}` : `cancel:${confirmation.execution.id}`) && <div className="op-inline-error" role="alert">{operationError.message}</div>}
          <div className="modal-actions">
            <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => setConfirmation(null)}>Keep</button>
            <button type="button" className="btn btn-danger" disabled={Boolean(busy)} onClick={() => void confirmOperation()}>{busy ? (confirmation.kind === 'delete' ? 'Deleting…' : 'Cancelling…') : (confirmation.kind === 'delete' ? 'Delete schedule' : 'Cancel execution')}</button>
          </div>
        </ModalDialog>
      )}
    </div>
  )
}
