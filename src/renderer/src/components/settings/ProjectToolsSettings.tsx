import { useEffect, useState } from 'react'
import { INTEGRATED_PROJECT_TOOLS, PROJECT_TOOL_FIELDS, type ProjectDoctorReport, type ProjectToolConfiguration } from '@shared/project-doctor'
import { redactDesignCaptureSecrets } from '@shared/design-capture'
import { useAppStore } from '../../store'

export function ProjectToolsSettings() {
  const workspacePath = useAppStore(state => state.activeWorktreePath)
  const [report, setReport] = useState<ProjectDoctorReport | null>(null)
  const [draft, setDraft] = useState<ProjectToolConfiguration | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const dirty = Boolean(report && draft && JSON.stringify(report.configuration) !== JSON.stringify(draft))
  const accept = (value: ProjectDoctorReport) => { setReport(value); setDraft(value.configuration) }
  useEffect(() => {
    let cancelled = false
    setReport(null); setDraft(null); setError('')
    if (workspacePath) void window.donwells.projectDoctorInspect(workspacePath).then(value => { if (!cancelled) accept(value) }).catch(error => { if (!cancelled) setError(redactDesignCaptureSecrets(String(error))) })
    return () => { cancelled = true }
  }, [workspacePath])
  const run = async (action: () => Promise<unknown>) => {
    if (busy || !workspacePath) return
    setBusy(true); setError('')
    try {
      await action()
      const value = await window.donwells.projectDoctorInspect(workspacePath)
      if (useAppStore.getState().activeWorktreePath === workspacePath) accept(value)
    } catch (error) { setError(redactDesignCaptureSecrets(String(error))) }
    finally { setBusy(false) }
  }
  if (!workspacePath) return <p>Select a project to configure its tools.</p>
  return <section className="project-tool-settings" aria-busy={busy} aria-label="Project tools" data-settings-dirty={dirty ? 'true' : undefined}>
    <h3>Project tools</h3>
    <p>Use installed, admitted tools. Changing configuration stops this project’s tool services and preserves a backup. Native agent authentication stays with each CLI.</p>
    {error && <p role="alert">{error}</p>}
    <button type="button" className="btn btn-secondary btn-sm" disabled={busy || dirty} onClick={() => void run(async () => {})}>Recheck setup</button>
    {report?.problem && <p role="alert">{report.problem} {report.configurationPath}</p>}
    {report && draft && <>
      <p>{report.workspacePath}</p>
      <p>Available cache disk: {report.availableDiskBytes === null ? 'unknown' : `${(report.availableDiskBytes / 1073741824).toFixed(1)} GiB`}. Provider usage: unavailable; consult the native CLI.</p>
      {INTEGRATED_PROJECT_TOOLS.map(tool => {
        const service = report.services.find(value => value.id === tool.id)
        return <details key={tool.id}>
          <summary>{tool.name} · {draft.disabled.includes(tool.id) ? 'disabled' : service?.status ?? (tool.id === 'backlog' && report.configuration.backlogBinary ? 'configured' : 'not configured')}</summary>
          <p>Admitted version: {tool.version}. {tool.scope}.</p>
          <p>{tool.models}</p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void window.donwells.openExternal(tool.source)}>Source</button>
          <label><input type="checkbox" disabled={busy} checked={!draft.disabled.includes(tool.id)} onChange={event => setDraft({ ...draft, disabled: event.target.checked ? draft.disabled.filter(id => id !== tool.id) : [...draft.disabled, tool.id] })} />Enabled for this project</label>
          {tool.fields.map(field => {
            const resource = report.resources.find(value => value.field === field)
            return <label key={field} style={{ display: 'block', marginBlock: 8 }}>{PROJECT_TOOL_FIELDS[field]}
              <input className="settings-input" style={{ width: '100%' }} disabled={busy} value={draft[field] ?? ''} placeholder="Absolute local path" onChange={event => setDraft({ ...draft, [field]: event.target.value })} />
              {resource && draft[field] === report.configuration[field] && <small>{resource.problem ?? (resource.bytes === null ? 'Directory size not measured; dependency size unknown' : `${resource.bytes.toLocaleString()} bytes in selected file`)}</small>}
            </label>
          })}
          {tool.id === 'documents' && <label>Shared reference folders, one per line<textarea className="settings-input" style={{ width: '100%' }} disabled={busy} value={draft.referenceRoots.join('\n')} onChange={event => setDraft({ ...draft, referenceRoots: event.target.value.split('\n') })} /></label>}
          {tool.id === 'history' && (['historyOmpRoots', 'historyDshRoots'] as const).map(key => <label key={key} style={{ display: 'block' }}>{key === 'historyOmpRoots' ? 'OMP session roots' : 'DeepSeek session roots'}, one per line<textarea className="settings-input" disabled={busy} value={(draft[key] ?? []).join('\n')} onChange={event => setDraft({ ...draft, [key]: event.target.value.split('\n') })} /></label>)}
          {service?.detail && <p role="status">{service.detail}</p>}
          {tool.id !== 'backlog' && <button type="button" className="btn btn-secondary btn-sm" disabled={busy || dirty || !service} onClick={() => void run(() => window.donwells.projectDoctorRetry(workspacePath, tool.id))}>{tool.id === 'history' ? 'Reindex sessions' : 'Retry readiness'}</button>}
          {tool.id !== 'backlog' && <button type="button" className="btn btn-secondary btn-sm" disabled={dirty || !service} onClick={() => void window.donwells.projectToolStop(workspacePath, tool.id).then(async () => { const value = await window.donwells.projectDoctorInspect(workspacePath); if (useAppStore.getState().activeWorktreePath === workspacePath) accept(value) }).catch(error => setError(redactDesignCaptureSecrets(String(error))))}>Stop service</button>}
        </details>
      })}
      {(dirty || (report.problem && report.revision)) && <>
        <details open><summary>Configuration changes</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{Object.keys({ ...report.configuration, ...draft }).filter(key => JSON.stringify(report.configuration[key as keyof ProjectToolConfiguration]) !== JSON.stringify(draft[key as keyof ProjectToolConfiguration])).map(key => redactDesignCaptureSecrets(`${key}\n− ${JSON.stringify(report.configuration[key as keyof ProjectToolConfiguration] ?? null)}\n+ ${JSON.stringify(draft[key as keyof ProjectToolConfiguration] ?? null)}`)).join('\n\n')}</pre></details>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || (Boolean(report.problem) && report.revision === null)} onClick={() => void run(() => window.donwells.projectDoctorConfigure(workspacePath, { ...draft, referenceRoots: draft.referenceRoots.filter(Boolean), historyOmpRoots: draft.historyOmpRoots?.filter(Boolean), historyDshRoots: draft.historyDshRoots?.filter(Boolean) }, report.revision))}>Apply configuration and stop services</button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setDraft(report.configuration)}>Discard changes</button>
      </>}
    </>}
  </section>
}
