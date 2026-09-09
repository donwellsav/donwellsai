import { guiDraftMap } from '../../gui-drafts'
import { PopupMenu } from 'flexlayout-react'
import { Icon } from '../Icon'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
let pendingSave: Promise<boolean> | null = null
const scheduleDrafts = guiDraftMap<ScheduleDraft>('scheduled-composer')
const scheduleVisibility = guiDraftMap<boolean>('scheduled-composer-visibility')
type OperationError = { key: string; message: string }
type Confirmation =
  | { kind: 'delete'; definition: ScheduledRunDefinition }
  | { kind: 'cancel'; execution: ScheduledExecution; definition: ScheduledRunDefinition }

const TIME_ZONES = [...new Set(['UTC', Intl.DateTimeFormat().resolvedOptions().timeZone, ...Intl.supportedValuesOf('timeZone')])]

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
  const listRequest = useRef(0)
  const [definitions, setDefinitions] = useState<ScheduledRunDefinition[]>([])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [openedExecutionId, setOpenedExecutionId] = useState<string | null>(null)
  useEffect(() => { if (openedExecutionId) document.querySelector<HTMLButtonElement>('.op-run-card.selected .op-run-main')?.focus() }, [openedExecutionId])
  const historyRequest = useRef(0)
  const selectedRef = useRef(selectedId)
  selectedRef.current = selectedId
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyOwner, setHistoryOwner] = useState<string | null>(null)
  const [history, setHistory] = useState<ScheduledExecution[]>([])
  const [setupOpen, setSetupOpen] = useState(scheduleVisibility.get('open') ?? true)
  useEffect(() => { scheduleVisibility.set('open', setupOpen) }, [setupOpen])
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<ScheduleDraft | null>(scheduleDrafts.get('draft') ?? null)
  useEffect(() => { if (draft && setupOpen) document.querySelector<HTMLTextAreaElement>('#schedule-run-composer textarea')?.focus() }, [Boolean(draft), setupOpen])
  const [busy, setBusy] = useState<string | null>(pendingSave ? 'save' : null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<OperationError | null>(null)
  const [menu, setMenu] = useState<{ anchor: HTMLButtonElement; definition: ScheduledRunDefinition } | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)

  useEffect(() => {
    let live = true
    if (pendingSave) void pendingSave.then(ok => {
      if (!live) return
      setBusy(null)
      if (ok) { setDraft(scheduleDrafts.get('draft') ?? null); void refreshDefinitions() }
      else setOperationError({ key: 'save', message: 'Save failed; your schedule draft is retained.' })
    })
    return () => { live = false }
  }, [])
  useEffect(() => { draft ? scheduleDrafts.set('draft', draft) : scheduleDrafts.delete('draft') }, [draft])

  const refreshDefinitions = useCallback(async () => {
    const request = ++listRequest.current
    try {
      const result = await window.donwells.scheduledRunsList()
      if (request !== listRequest.current) return
      setDefinitions(result)
      setLoadError(null)
    } catch (error) {
      if (request === listRequest.current) setLoadError(errorMessage(error))
    }
  }, [])

  const refreshHistory = useCallback(async (id: string) => {
    const request = ++historyRequest.current
    const current = () => request === historyRequest.current && selectedRef.current === id
    setHistoryLoading(true)
    try {
      const result = await window.donwells.scheduledRunHistory(id)
      if (!current()) return
      setHistoryOwner(id)
      setHistory(result)
      setHistoryError(null)
    } catch (error) {
      if (current()) { setHistoryOwner(id); setHistoryError(errorMessage(error)) }
    } finally {
      if (current()) setHistoryLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshDefinitions()
    return () => { listRequest.current++ }
  }, [refreshDefinitions])

  useEffect(() => {
    setHistory([])
    setHistoryError(null)
    setHistoryLoading(Boolean(selectedId))
    if (selectedId) void refreshHistory(selectedId)
    return () => { historyRequest.current++ }
  }, [refreshHistory, selectedId])

  const visibleHistory = historyOwner === selectedId ? history : []
  const hasLiveHistory = visibleHistory.some(executionMayBeLive)
  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshDefinitions()
      if (selectedId) void refreshHistory(selectedId)
    }, hasLiveHistory ? 1_500 : 5_000)
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

  const saveDraft = async (): Promise<void> => {
    if (!draft || pendingSave) return
    pendingSave = runAction('save', () => window.donwells.scheduledRunSave({ ...draft, name: draft.name.trim() || draft.command.trim().split('\n')[0]!.slice(0, 256) }), (saved) => {
      setDefinitions((current) => [saved, ...current.filter((definition) => definition.id !== saved.id)])
      setDraft(null); scheduleDrafts.delete('draft')
      setSelectedId(saved.id)
    }).finally(() => { pendingSave = null })
    await pendingSave
  }

  const confirmOperation = async (): Promise<void> => {
    if (!confirmation) return
    const current = confirmation
    const succeeded = current.kind === 'delete'
      ? await runAction(`delete:${current.definition.id}`, () => window.donwells.scheduledRunDelete(current.definition.id), () => {
          setDefinitions((definitionsNow) => definitionsNow.filter((definition) => definition.id !== current.definition.id))
          if (selectedRef.current === current.definition.id) setSelectedId(null)
        })
      : await runAction(`cancel:${current.execution.id}`, () => window.donwells.scheduledRunCancel(current.execution.id), (updated) => {
          if (selectedRef.current !== current.definition.id) return
          historyRequest.current++
          setHistoryLoading(false)
          setHistory((historyNow) => historyNow.map((execution) => execution.id === updated.id ? updated : execution))
        })
    if (succeeded) setConfirmation(null)
  }

  const targetChoices = useMemo(() => {
    if (!draft) return targets
    const key = operationalTargetKey(draft.target)
    return targets.some((target) => operationalTargetKey(target) === key) ? targets : [draft.target, ...targets]
  }, [draft, targets])

  const visibleDefinitions = definitions.filter(definition => `${definition.name} ${definition.command} ${definition.target.root}`.toLowerCase().includes(query.trim().toLowerCase()))


  return (
    <div className="op-section">
      <div className="op-section-heading">
        <div>
          <p>{definitions.length ? `${definitions.length} schedule${definitions.length === 1 ? '' : 's'}` : "Repeat a project command automatically."}</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => { if (!draft) setDraft(emptyDraft(targets.find(target => target.root === useAppStore.getState().activeWorktreePath) ?? targets[0])); setSetupOpen(true) }} disabled={targets.length === 0 && !draft} title={targets.length === 0 && !draft ? 'Open a project before creating a schedule' : undefined}>
          <Icon name="plus" size={14} />{draft ? 'Resume setup' : 'New schedule'}
        </button>
      </div>

      {loadError && (
        <div className="op-inline-error" role="alert">
          <span>Could not load schedules: {loadError}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void refreshDefinitions()}>Retry</button>
        </div>
      )}

      {draft && setupOpen && (
        <ModalDialog className="modal op-setup-dialog" labelledBy="schedule-setup-title" onClose={() => { if (busy !== 'save') setSetupOpen(false) }}>
        <form onSubmit={event => { event.preventDefault(); void saveDraft() }}>
        <fieldset id="schedule-run-composer" disabled={busy === 'save'} className="op-composer" aria-label={draft.id ? 'Edit scheduled shell' : 'Create scheduled shell'}>
          <div className="op-composer-title">
            <h3 id="schedule-setup-title" className="modal-title">{draft.id ? 'Edit schedule' : 'New schedule'}</h3><button type="button" className="icon-btn" aria-label="Close schedule setup" title="Close setup and keep your draft" onClick={() => setSetupOpen(false)}><Icon name="x" size={14} /></button>
          </div>
          <div className="op-form-grid">
            <label className="modal-field op-command-field">Project
              <select
                className="input"
                title={draft.target.root}
                value={operationalTargetKey(draft.target)}
                onChange={(event) => {
                  const target = targetChoices.find((candidate) => operationalTargetKey(candidate) === event.target.value)
                  if (target) setDraft({ ...draft, target })
                }}
              >
                {targetChoices.map((target) => <option key={operationalTargetKey(target)} value={operationalTargetKey(target)}>{target.label} · {target.root}</option>)}
              </select>
            </label>
            <label className="modal-field op-command-field">Command
              <textarea autoFocus className="input op-command-input" rows={3} value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} />
            </label>
            <label className="modal-field">Repeat
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
                <option value="interval">Every few minutes</option>
                <option value="daily">Daily</option>
              </select>
            </label>
            {draft.schedule.kind === 'interval' ? (
              <label className="modal-field">Minutes
                <input className="input" type="number" required min={1} max={525600} value={draft.schedule.minutes} onChange={(event) => setDraft({ ...draft, schedule: { ...draft.schedule, minutes: Number(event.target.value) } })} />
              </label>
            ) : (
              <>
                <label className="modal-field">Local time
                  <input className="input" type="time" required value={draft.schedule.time} onChange={(event) => setDraft({ ...draft, schedule: { ...draft.schedule, time: event.target.value } })} />
                </label>
                <label className="modal-field">Time zone
                  <select className="input" value={draft.schedule.timeZone} onChange={event => setDraft({ ...draft, schedule: { ...draft.schedule, timeZone: event.target.value } })}>{[...new Set([draft.schedule.timeZone, ...TIME_ZONES])].map(zone => <option key={zone} value={zone}>{zone.replaceAll('_', ' ')}</option>)}</select>
                </label>
              </>
            )}
          </div>
          <details><summary>Schedule options</summary>            <label className="modal-field">Name (optional)
              <input className="input" placeholder="Use the command as its name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </label>
          </details>
          {operationError?.key === 'save' && <div className="op-inline-error" role="alert">Save failed: {operationError.message}</div>}
          <div className="op-composer-footer">
            <label className="op-switch"><input type="checkbox" checked={draft.enabled ?? true} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> Enable after saving</label>
            <button type="button" className="btn btn-secondary" disabled={busy === 'save'} onClick={() => { setDraft(null); scheduleDrafts.delete('draft') }}>Discard</button>
            <button type="submit" className="btn btn-primary" disabled={!draft.command.trim() || busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save schedule'}</button>
          </div>
        </fieldset>
        </form>
        </ModalDialog>
      )}

      {(definitions.length > 5 || query) && <input className="input" type="search" aria-label="Search schedules" placeholder="Search schedules or projects" value={query} onChange={event => setQuery(event.target.value)} />}
      {query && visibleDefinitions.length === 0 && <p className="op-empty" role="status">No schedules match your search.</p>}
      <div className="op-list">
        {visibleDefinitions.map((definition) => {
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
                  <button type="button" className="btn btn-secondary btn-sm" disabled={Boolean(busy)} onClick={() => void runAction(`run:${definition.id}`, () => window.donwells.scheduledRunRunNow(definition.id), execution => {
                    setOpenedExecutionId(execution.id)
                    setSelectedId(definition.id)
                    void refreshDefinitions()
                    if (selectedRef.current === definition.id) void refreshHistory(definition.id)
                  })}>{busy === `run:${definition.id}` ? 'Starting…' : 'Run now'}</button>
                  <button type="button" className="icon-btn" aria-label={`More actions for ${definition.name}`} title="Pause, edit, duplicate, or delete this schedule" aria-haspopup="menu" aria-expanded={menu?.definition.id === definition.id} disabled={Boolean(busy)} onClick={event => setMenu({ anchor: event.currentTarget, definition })}><Icon name="more" /></button>
                </div>
              </div>
              {definitionError && <div className="op-inline-error" role="alert">Operation failed: {definitionError}</div>}
              {selected && (
                <div className="op-run-detail">
                  <div className="op-detail-meta">
                    <span title={definition.target.root}><b>Project</b>{targetDescription(definition.target.kind, definition.target.root, definition.target.kind === 'remote' ? definition.target.connectionId : undefined)}</span>
                  </div>
                  {definition.name !== definition.command.trim() && <pre className="op-command">{definition.command}</pre>}
                  <div className="op-history-head"><h4>Execution history</h4></div>
                  {historyOwner === selectedId && historyError && <div className="op-inline-error" role="alert"><span>Could not load history: {historyError}</span><button type="button" className="btn btn-secondary btn-sm" onClick={() => void refreshHistory(definition.id)}>Retry</button></div>}
                  <div className="op-history">
                    {visibleHistory.map((execution) => (
                      <details key={execution.id} className="op-history-row" open={execution.id === openedExecutionId}>
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
                    {(historyLoading || historyOwner !== selectedId) && <div role="status">Loading history…</div>}
                    {!historyLoading && historyOwner === selectedId && !historyError && visibleHistory.length === 0 && <div className="op-empty">No execution history yet.</div>}
                  </div>
                </div>
              )}
            </article>
          )
        })}
      </div>

      {menu && <PopupMenu anchor={menu.anchor} title={`Actions for ${menu.definition.name}`} onClose={() => setMenu(null)} items={[
        { key: 'enabled', label: menu.definition.enabled ? 'Pause schedule' : 'Enable schedule', disabled: Boolean(busy), onSelect: () => void runAction(`enable:${menu.definition.id}`, () => window.donwells.scheduledRunSetEnabled(menu.definition.id, !menu.definition.enabled), updated => setDefinitions(current => current.map(entry => entry.id === updated.id ? updated : entry))) },
        { key: 'edit', label: 'Edit schedule', disabled: Boolean(busy) || Boolean(draft), onSelect: () => { setSetupOpen(true); setDraft({ id: menu.definition.id, name: menu.definition.name, target: menu.definition.target, command: menu.definition.command, schedule: menu.definition.schedule, enabled: menu.definition.enabled }) } },
        { key: 'duplicate', label: 'Duplicate paused', disabled: Boolean(busy), onSelect: () => void runAction(`duplicate:${menu.definition.id}`, () => window.donwells.scheduledRunDuplicate(menu.definition.id), copy => setDefinitions(current => [copy, ...current])) },
        { type: 'divider', key: 'divider' },
        { key: 'delete', label: 'Delete schedule…', disabled: Boolean(busy), onSelect: () => setConfirmation({ kind: 'delete', definition: menu.definition }) }
      ]} />}

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
