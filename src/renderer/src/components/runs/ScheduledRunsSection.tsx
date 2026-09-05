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

type Props = { onError(error: unknown): void }
type ScheduleDraft = ScheduledRunInput

type Confirmation =
  | { kind: 'delete'; definition: ScheduledRunDefinition }
  | { kind: 'cancel'; execution: ScheduledExecution }

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

export function ScheduledRunsSection({ onError }: Props) {
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
  const [query, setQuery] = useState('')
  const [historyQuery, setHistoryQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [history, setHistory] = useState<ScheduledExecution[]>([])
  const [draft, setDraft] = useState<ScheduleDraft | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)

  const refreshDefinitions = useCallback(async () => {
    setDefinitions(await window.donwells.scheduledRunsList())
  }, [])

  const refreshHistory = useCallback(async (id: string) => {
    setHistory(await window.donwells.scheduledRunHistory(id))
  }, [])

  useEffect(() => {
    void refreshDefinitions().catch(onError)
  }, [onError, refreshDefinitions])

  useEffect(() => {
    if (!selectedId) {
      setHistory([])
      return
    }
    void refreshHistory(selectedId).catch(onError)
  }, [onError, refreshHistory, selectedId, definitions])

  const hasLiveHistory = history.some(executionMayBeLive)
  useEffect(() => {
    if (!selectedId || !hasLiveHistory) return
    const timer = window.setInterval(() => {
      void Promise.all([refreshDefinitions(), refreshHistory(selectedId)]).catch(onError)
    }, 1_500)
    return () => window.clearInterval(timer)
  }, [hasLiveHistory, onError, refreshDefinitions, refreshHistory, selectedId])

  useEffect(() => {
    if (!draft || draft.id || targets.length === 0 || draft.target.root !== '/') return
    setDraft({ ...draft, target: targets[0]! })
  }, [draft, targets])

  const matchingDefinitions = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return definitions
    return definitions.filter((definition) => [
      definition.name,
      definition.command,
      definition.target.label,
      definition.target.root,
      scheduleText(definition),
      definition.lastStatus ?? ''
    ].some((value) => value.toLocaleLowerCase().includes(needle)))
  }, [definitions, query])

  const matchingHistory = useMemo(() => {
    const needle = historyQuery.trim().toLocaleLowerCase()
    if (!needle) return history
    return history.filter((execution) => [
      execution.status,
      execution.output ?? '',
      execution.error ?? '',
      String(execution.exitCode ?? '')
    ].some((value) => value.toLocaleLowerCase().includes(needle)))
  }, [history, historyQuery])

  const runAction = async (key: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    try {
      await action()
      await refreshDefinitions()
      if (selectedId) await refreshHistory(selectedId)
    } catch (error) {
      onError(error)
    } finally {
      setBusy(null)
    }
  }

  const saveDraft = async (): Promise<void> => {
    if (!draft) return
    await runAction('save', async () => {
      const saved = await window.donwells.scheduledRunSave(draft)
      setDraft(null)
      setSelectedId(saved.id)
    })
  }

  const targetChoices = useMemo(() => {
    if (!draft) return targets
    const key = operationalTargetKey(draft.target)
    return targets.some((target) => operationalTargetKey(target) === key) ? targets : [draft.target, ...targets]
  }, [draft, targets])

  return (
    <div className="op-section">
      <div className="op-section-heading">
        <div>
          <span className="op-eyebrow">Calendar & interval triggers</span>
          <h3>Scheduled runs</h3>
          <p>Finite commands follow each target’s registered execution boundary and never overlap themselves.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setDraft(emptyDraft(targets[0]))} disabled={targets.length === 0}>
          New schedule
        </button>
      </div>

      {draft && (
        <div className="op-composer" aria-label={draft.id ? 'Edit scheduled run' : 'Create scheduled run'}>
          <div className="op-composer-title">
            <div><span className="op-eyebrow">{draft.id ? 'Editing' : 'New'}</span><h4>{draft.id ? draft.name : 'Schedule a command'}</h4></div>
            <button className="icon-btn" aria-label="Close schedule editor" onClick={() => setDraft(null)}>×</button>
          </div>
          <div className="op-form-grid">
            <label className="modal-field">Name
              <input className="input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </label>
            <label className="modal-field">Target
              <select
                className="input"
                value={operationalTargetKey(draft.target)}
                onChange={(event) => {
                  const target = targetChoices.find((candidate) => operationalTargetKey(candidate) === event.target.value)
                  if (target) setDraft({ ...draft, target })
                }}
              >
                {targetChoices.map((target) => <option key={operationalTargetKey(target)} value={operationalTargetKey(target)}>{target.label} · {target.kind}</option>)}
              </select>
            </label>
            <label className="modal-field op-command-field">Command
              <textarea className="input op-command-input" rows={3} value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} />
            </label>
            <label className="modal-field">Schedule
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
          <div className="op-composer-footer">
            <label className="op-switch"><input type="checkbox" checked={draft.enabled ?? true} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> Enable after saving</label>
            <button className="btn btn-secondary" onClick={() => setDraft(null)}>Cancel</button>
            <button className="btn btn-primary" disabled={!draft.name.trim() || !draft.command.trim() || busy === 'save'} onClick={() => void saveDraft()}>{busy === 'save' ? 'Saving…' : 'Save schedule'}</button>
          </div>
        </div>
      )}

      <div className="op-toolbar">
        <label className="op-search"><span className="sr-only">Search scheduled runs</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search schedules, targets, commands…" /></label>
        <span className="op-count">{matchingDefinitions.length} of {definitions.length}</span>
      </div>

      <div className="op-list">
        {matchingDefinitions.map((definition) => {
          const selected = selectedId === definition.id
          return (
            <article key={definition.id} className={`op-run-card${selected ? ' selected' : ''}`}>
              <div className="op-run-summary">
                <button className="op-run-main" onClick={() => setSelectedId(selected ? null : definition.id)} aria-expanded={selected}>
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
                  <button className="btn btn-secondary btn-sm" disabled={busy === `enable:${definition.id}`} onClick={() => void runAction(`enable:${definition.id}`, () => window.donwells.scheduledRunSetEnabled(definition.id, !definition.enabled))}>{definition.enabled ? 'Pause' : 'Enable'}</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setDraft({ id: definition.id, name: definition.name, target: definition.target, command: definition.command, schedule: definition.schedule, enabled: definition.enabled })}>Edit</button>
                  <button className="btn btn-secondary btn-sm" disabled={busy === `run:${definition.id}`} onClick={() => void runAction(`run:${definition.id}`, async () => { await window.donwells.scheduledRunRunNow(definition.id); setSelectedId(definition.id) })}>{busy === `run:${definition.id}` ? 'Starting…' : 'Run now'}</button>
                  <details className="op-more"><summary aria-label={`More actions for ${definition.name}`}>•••</summary><div className="op-more-menu">
                    <button onClick={() => void runAction(`duplicate:${definition.id}`, () => window.donwells.scheduledRunDuplicate(definition.id))}>Duplicate paused</button>
                    <button className="danger" onClick={() => setConfirmation({ kind: 'delete', definition })}>Delete…</button>
                  </div></details>
                </div>
              </div>
              {selected && (
                <div className="op-run-detail">
                  <div className="op-detail-meta">
                    <span><b>Target</b>{targetDescription(definition.target.kind, definition.target.root, definition.target.kind === 'remote' ? definition.target.connectionId : undefined)}</span>
                    <span><b>Created</b>{formatRunTime(definition.createdAt)}</span>
                    <span><b>Last run</b>{formatRunTime(definition.lastRunAt)}</span>
                  </div>
                  <pre className="op-command">{definition.command}</pre>
                  <div className="op-history-head"><h4>History</h4><input className="input" value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="Search status, output, exit code…" /></div>
                  <div className="op-history">
                    {matchingHistory.map((execution) => (
                      <details key={execution.id} className="op-history-row">
                        <summary>
                          <RunStatus status={execution.status} />
                          <span>{execution.trigger === 'manual' ? 'Manual' : 'Scheduled'}</span>
                          <time>{formatRunTime(execution.startedAt)}</time>
                          {execution.exitCode !== undefined && <code>exit {execution.exitCode}</code>}
                        </summary>
                        <div className="op-log-detail">
                          {execution.error && <p className="op-run-error">{execution.error}</p>}
                          <pre>{execution.output || 'No output captured.'}</pre>
                          {executionMayBeLive(execution) && <button className="btn btn-danger btn-sm" onClick={() => setConfirmation({ kind: 'cancel', execution })}>Cancel execution…</button>}
                        </div>
                      </details>
                    ))}
                    {matchingHistory.length === 0 && <div className="op-empty">No matching execution history.</div>}
                  </div>
                </div>
              )}
            </article>
          )
        })}
        {matchingDefinitions.length === 0 && <div className="op-empty">{definitions.length === 0 ? 'No schedules yet. Create one for a registered folder or worktree.' : 'No schedules match this search.'}</div>}
      </div>

      {confirmation && (
        <ModalDialog className="modal op-confirm" labelledBy="scheduled-run-confirm-title" onClose={() => setConfirmation(null)}>
          <span className="op-eyebrow">Confirm operation</span>
          <h3 id="scheduled-run-confirm-title" className="modal-title">{confirmation.kind === 'delete' ? `Delete “${confirmation.definition.name}”?` : 'Cancel this live execution?'}</h3>
          <p>{confirmation.kind === 'delete' ? 'The schedule and its bounded execution history will be removed. Running or unverifiable executions cannot be deleted.' : 'The daemon will be asked to stop the finite job. The UI will only report Cancelled after that request is acknowledged.'}</p>
          <div className="modal-actions">
            <button className="btn" onClick={() => setConfirmation(null)}>Keep</button>
            <button className="btn btn-danger" onClick={() => {
              const current = confirmation
              setConfirmation(null)
              if (current.kind === 'delete') void runAction(`delete:${current.definition.id}`, () => window.donwells.scheduledRunDelete(current.definition.id))
              else void runAction(`cancel:${current.execution.id}`, () => window.donwells.scheduledRunCancel(current.execution.id))
            }}>{confirmation.kind === 'delete' ? 'Delete schedule' : 'Cancel execution'}</button>
          </div>
        </ModalDialog>
      )}
    </div>
  )
}
