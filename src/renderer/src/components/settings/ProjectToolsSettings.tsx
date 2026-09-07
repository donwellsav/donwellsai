import { useEffect, useRef, useState } from 'react'
import downloads from '@shared/project-tool-downloads.json'
import { INTEGRATED_PROJECT_TOOLS, PROJECT_TOOL_FIELDS, projectDoctorDiagnostics, type ProjectDoctorReport, type ProjectToolConfiguration } from '@shared/project-doctor'
import { redactDesignCaptureSecrets } from '@shared/design-capture'
import { useAppStore } from '../../store'

export function ProjectToolsSettings() {
  const workspacePath = useAppStore(state => state.activeWorktreePath)
  const [report, setReport] = useState<ProjectDoctorReport | null>(null)
  const [draft, setDraft] = useState<ProjectToolConfiguration | null>(null)
  const [backupSelection, setBackupSelection] = useState('')
  const preview = useRef<HTMLDetailsElement>(null)
  useEffect(() => { if (backupSelection) preview.current?.scrollIntoView({ block: 'nearest' }) }, [backupSelection])
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [statusError, setStatusError] = useState('')
  const dirty = Boolean(report && draft && JSON.stringify(report.configuration) !== JSON.stringify(draft))
  const accept = (value: ProjectDoctorReport) => { setReport(value); setDraft(value.configuration); setBackupSelection('') }
  useEffect(() => {
    let cancelled = false
    setReport(null); setDraft(null); setError(''); setStatusError(''); setBackupSelection('')
    if (workspacePath) void window.donwells.projectDoctorInspect(workspacePath).then(value => { if (!cancelled) accept(value) }).catch(error => { if (!cancelled) setError(redactDesignCaptureSecrets(String(error))) })
    return () => { cancelled = true }
  }, [workspacePath])
  useEffect(() => {
    if (!workspacePath || !report) return
    let cancelled = false, pending = false
    const refresh = async () => {
      if (pending || document.visibilityState !== 'visible') return
      pending = true
      try {
        const services = await window.donwells.projectToolsList(workspacePath)
        if (!cancelled) {
          setReport(current => current && ({ ...current, services: [...services, ...current.services.filter(service => service.id === 'history')] }))
          setStatusError('')
        }
      } catch (error) { if (!cancelled) setStatusError(`Live service status unavailable: ${redactDesignCaptureSecrets(String(error))}`) }
      finally { pending = false }
    }
    const timer = setInterval(() => void refresh(), 2000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [workspacePath, Boolean(report)])
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
    <p>Optional tools are installed separately. Downloads require a connection; installed tools and local models can work offline. Without them, terminals, files and shared project memory remain available.</p>
    {error && <p role="alert">{error}</p>}
    {statusError && <p role="status">{statusError}</p>}
    <button type="button" className="btn btn-secondary btn-sm" disabled={busy || dirty} onClick={() => void run(async () => {})}>Recheck setup</button>
    {report?.problem && <p role="alert">{report.problem} {report.configurationPath}</p>}
    {report && draft && <>
      <p>{report.workspacePath}</p>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => void navigator.clipboard.writeText(projectDoctorDiagnostics(report)).catch(() => setError('Could not copy setup diagnosis'))}>Copy setup diagnosis</button>
      <p>Available cache disk: {report.availableDiskBytes === null ? 'unknown' : `${(report.availableDiskBytes / 1073741824).toFixed(1)} GiB`}. Provider usage: unavailable; consult the native CLI.</p>
      {report.backups.length > 0 && <label>Review saved configuration<select className="settings-input" value={backupSelection} disabled={busy || dirty} onChange={event => {
        const name = event.target.value
        if (name) void window.donwells.projectDoctorPreviewBackup(workspacePath, name).then(config => { if (useAppStore.getState().activeWorktreePath === workspacePath) { setDraft(config); setBackupSelection(name) } }).catch(error => setError(redactDesignCaptureSecrets(String(error))))
      }}><option value="">Choose a backup to review</option>{report.backups.map(backup => <option key={backup.name} value={backup.name}>{new Date(backup.createdAt).toLocaleString()}</option>)}</select></label>}
      {INTEGRATED_PROJECT_TOOLS.map(tool => {
        const service = report.services.find(value => value.id === tool.id)
        return <details key={tool.id}>
          <summary>{tool.name} · {draft.disabled.includes(tool.id) ? 'disabled' : service?.status ?? (tool.id === 'backlog' && report.configuration.backlogBinary ? 'configured' : 'not configured')}</summary>
          {service?.owner && <p>Owner: {service.scope === 'project' ? 'project' : 'checkout'} <code>{service.scope === 'project' ? service.owner.projectPath : service.owner.checkoutPath}</code><br />{service.activeCalls ?? 0} active calls{service.pid ? ` · Process ${service.pid}` : ''}</p>}
          <p>Admitted version: {tool.version}. {tool.scope}.</p>
          <p>{tool.models}</p>
          {tool.id === 'documents' && <label>Retrieval mode<select className="settings-input" disabled={busy} value={draft.documentRetrievalMode ?? 'auto'} onChange={event => setDraft({ ...draft, documentRetrievalMode: event.target.value as 'auto' | 'lexical' | 'hybrid' })}>
            <option value="auto">Automatic — hybrid when models are ready</option>
            <option value="lexical">Lexical — no model loading</option>
            <option value="hybrid">Require hybrid — report unavailable instead of falling back</option>
          </select><small>Applies to this project’s app and native-agent document searches. Changing it stops document workers; retained indexes and model paths are preserved.</small></label>}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void window.donwells.openExternal(tool.source)}>Source</button>
          <label><input type="checkbox" disabled={busy} checked={!draft.disabled.includes(tool.id)} onChange={event => setDraft({ ...draft, disabled: event.target.checked ? draft.disabled.filter(id => id !== tool.id) : [...draft.disabled, tool.id] })} />Enabled for this project</label>
          {tool.fields.map(field => {
            const resource = report.resources.find(value => value.field === field)
            const download = downloads[field as keyof typeof downloads]
            return <div key={field}><label style={{ display: 'block', marginBlock: 8 }}>{PROJECT_TOOL_FIELDS[field]}
              <input className="settings-input" style={{ width: '100%' }} disabled={busy} value={draft[field] ?? ''} placeholder="Absolute local path" onChange={event => setDraft({ ...draft, [field]: event.target.value })} />
              {resource && draft[field] === report.configuration[field] && <small>{resource.problem ?? (resource.bytes === null ? 'Size unavailable' : `${resource.bytes.toLocaleString()} bytes in selected ${resource.sizeKind ?? 'file'}${resource.sizeKind === 'directory' ? '; linked/shared dependencies excluded' : ''}`)}</small>}
            </label>
              {download && <details><summary>Download and checksum</summary><p>{download.instructions}</p><p>{download.file} · {download.bytes.toLocaleString()} bytes</p><p style={{overflowWrap:'anywhere'}}>SHA-256: {download.sha256}</p><button type="button" className="btn btn-secondary btn-sm" onClick={() => void window.donwells.openExternal(download.url)}>Open pinned download</button><p>Package archives exclude dependencies; installed size is shown after configuration. Check with shasum -a 256 before installing. To remove: stop the service, clear its paths, then remove only that separate installation.</p></details>}
            </div>
          })}
          {tool.id === 'documents' && <label>Shared reference folders, one per line<textarea className="settings-input" style={{ width: '100%' }} disabled={busy} value={draft.referenceRoots.join('\n')} onChange={event => setDraft({ ...draft, referenceRoots: event.target.value.split('\n') })} /></label>}
          {tool.id === 'history' && (['historyOmpRoots', 'historyDshRoots'] as const).map(key => <label key={key} style={{ display: 'block' }}>{key === 'historyOmpRoots' ? 'OMP session roots' : 'DeepSeek session roots'}, one per line<textarea className="settings-input" disabled={busy} value={(draft[key] ?? []).join('\n')} onChange={event => setDraft({ ...draft, [key]: event.target.value.split('\n') })} /></label>)}
          {service?.detail && <p role="status">{service.detail}</p>}
          {tool.id !== 'backlog' && <button type="button" className="btn btn-secondary btn-sm" disabled={busy || dirty || !service || Boolean(report.problem)} onClick={() => void run(() => window.donwells.projectDoctorRetry(workspacePath, tool.id))}>{tool.id === 'history' ? 'Reindex sessions' : 'Retry readiness'}</button>}
          {tool.id !== 'backlog' && <button type="button" className="btn btn-secondary btn-sm" disabled={dirty || !service} onClick={() => void window.donwells.projectToolStop(workspacePath, tool.id).then(async () => { const value = await window.donwells.projectDoctorInspect(workspacePath); if (useAppStore.getState().activeWorktreePath === workspacePath) accept(value) }).catch(error => setError(redactDesignCaptureSecrets(String(error))))}>Stop service</button>}
        </details>
      })}
      {(dirty || (report.problem && report.revision)) && <>
        <details ref={preview} open><summary>Configuration changes</summary>{!report.configurationValid && <p>The previous file is unreadable. Its original bytes will be preserved in a new backup.</p>}<pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{Object.keys({ ...report.configuration, ...draft }).filter(key => JSON.stringify(report.configuration[key as keyof ProjectToolConfiguration]) !== JSON.stringify(draft[key as keyof ProjectToolConfiguration])).map(key => redactDesignCaptureSecrets(`${key}\n− ${report.configurationValid ? JSON.stringify(report.configuration[key as keyof ProjectToolConfiguration] ?? null) : '[unreadable configuration]'}\n+ ${JSON.stringify(draft[key as keyof ProjectToolConfiguration] ?? null)}`)).join('\n\n')}</pre></details>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || (Boolean(report.problem) && report.revision === null)} onClick={() => void run(() => window.donwells.projectDoctorConfigure(workspacePath, { ...draft, referenceRoots: draft.referenceRoots.filter(Boolean), historyOmpRoots: draft.historyOmpRoots?.filter(Boolean), historyDshRoots: draft.historyDshRoots?.filter(Boolean) }, report.revision))}>Apply configuration and stop services</button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { setDraft(report.configuration); setBackupSelection('') }}>Discard changes</button>
      </>}
    </>}
  </section>
}
