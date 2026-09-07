import { useEffect, useRef, useState } from 'react'
import downloads from '@shared/project-tool-downloads.json'
import { INTEGRATED_PROJECT_TOOLS, PROJECT_INTEGRATION_ROLES, PROJECT_TOOL_FIELDS, projectDoctorDiagnostics, projectToolSetupStatus, type ProjectDoctorReport, type ProjectToolConfiguration } from '@shared/project-doctor'
import { redactDesignCaptureSecrets } from '@shared/design-capture'
import { useAppStore } from '../../store'
import { ProjectMemoryConnection } from '../ProjectMemoryConnection'

export function ProjectToolsSettings({ onNavigate }: { onNavigate?: (route: 'memory' | 'search') => void } = {}) {
  const workspacePath = useAppStore(state => state.activeWorktreePath)
  const [role, setRole] = useState('')
  const [ownerStatus, setOwnerStatus] = useState('Not checked')
  const roleOperation = useRef(0)
  const [report, setReport] = useState<ProjectDoctorReport | null>(null)
  const [draft, setDraft] = useState<ProjectToolConfiguration | null>(null)
  const [backupSelection, setBackupSelection] = useState('')
  const [showConnection, setShowConnection] = useState(false)
  const preview = useRef<HTMLDetailsElement>(null)
  useEffect(() => { if (backupSelection) preview.current?.scrollIntoView({ block: 'nearest' }) }, [backupSelection])
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [statusError, setStatusError] = useState('')
  const dirty = Boolean(report && draft && JSON.stringify(report.configuration) !== JSON.stringify(draft))
  const accept = (value: ProjectDoctorReport) => { setReport(value); setDraft(value.configuration); setBackupSelection('') }
  useEffect(() => {
    let cancelled = false
    setReport(null); setDraft(null); setError(''); setStatusError(''); setBackupSelection(''); setShowConnection(false)
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
  const checkOwner = async (id: string) => {
    const generation = ++roleOperation.current
    setOwnerStatus('Checking…')
    try {
      let detail = 'Open its existing controls to inspect the current owner.'
      if (id === 'language') { const value = await window.donwells.projectLanguageStatus(workspacePath!); detail = `${value.state} · ${value.detail}${value.pid ? ` · PID ${value.pid}` : ''}` }
      if (id === 'learned') { const value = await window.donwells.projectKnowledgeStatus(workspacePath!); detail = `${value.enabled ? value.phase : 'disabled'} · ${value.error ?? (value.stale ? 'Sources changed; reconcile selected sources' : 'Source manifest inspected; external connection not checked')}` }
      if (id === 'temporal') { const value = await window.donwells.projectTemporalKnowledgeStatus(workspacePath!); detail = `${value.enabled ? (value.busy ? 'working' : 'idle') : 'disabled'} · ${value.error ?? 'Source manifest inspected; external connection not checked'}` }
      if (id === 'environments') {
        const [ssh, lume] = await Promise.allSettled([window.donwells.environmentList(workspacePath!), window.donwells.environmentLumeList(workspacePath!)])
        const states = [
          ssh.status === 'fulfilled' ? (ssh.value.map(value => `SSH ${value.id}: ${value.state}${value.detail ? ` · ${value.detail}` : ''}`).join('; ') || 'No SSH pairing') : `SSH status unavailable: ${String(ssh.reason)}`,
          lume.status === 'fulfilled' ? (lume.value.guests.map(value => `Lume ${value.id}: ${value.state}${value.pid ? ` · PID ${value.pid}` : ''}${value.detail ? ` · ${value.detail}` : ''}`).join('; ') || 'No registered Lume guest') : `Lume status unavailable: ${String(lume.reason)}`
        ]
        detail = redactDesignCaptureSecrets(states.join('. ') + '. Recorded state only; use environment controls to verify or reconnect the owner.')
      }
      if (id === 'facts') { const value = await window.donwells.projectMemoryList({ workspacePath: workspacePath! }); detail = `${value.total} canonical facts · local store readable · no background process to stop` }
      if (id === 'analytics') detail = report?.configuration.duckdbPython ? 'Python path configured; execute a report in Search → Sessions to verify DuckDB. Cancel remains beside that report.' : 'Set DuckDB Python under Native session history. Runtime has not been checked.'
      if (generation === roleOperation.current) setOwnerStatus(detail)
    } catch (failure) { if (generation === roleOperation.current) setOwnerStatus(redactDesignCaptureSecrets(String(failure))) }
  }
  useEffect(() => { roleOperation.current++; setRole(''); setOwnerStatus('Not checked') }, [workspacePath])
  const openRole = (route: string) => {
    if (route === 'environment') { document.querySelector('[aria-label="Project environments"]')?.scrollIntoView({ block: 'start' }); return }
    if (route === 'memory' || route === 'search') onNavigate?.(route)
  }
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
    <label>Integration <select aria-label="Integration" className="settings-input" value={role} onChange={event => { const id = event.target.value; setRole(id); if (id) void checkOwner(id) }}><option value="">Choose an integration</option>{PROJECT_INTEGRATION_ROLES.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    {role && (() => {
      const selected = PROJECT_INTEGRATION_ROLES.find(item => item.id === role)!
      if (selected.route === 'package') return <button className="btn btn-secondary btn-sm" onClick={() => { const item = document.getElementById('project-tool-' + role) as HTMLDetailsElement | null; if (item) { item.open = true; item.scrollIntoView({ block: 'nearest' }) } }}>Configure {selected.name}</button>
      return <div aria-label={selected.name + ' controls'}><p role="status">{ownerStatus}</p>
        <button className="btn btn-secondary btn-sm" onClick={() => void checkOwner(role)}>Refresh owner status</button>
        {selected.route !== 'language' && <button className="btn btn-secondary btn-sm" disabled={dirty} onClick={() => openRole(selected.route)}>{role === 'analytics' ? 'Open Search → Sessions' : 'Open configuration and controls'}</button>}
        {role === 'language' && <><p>Uses this checkout’s TypeScript installation. Install or repair its TypeScript dependency through your terminal, then start. Pausing prevents editor changes from restarting this owner; bundled open-file tools remain available.</p><button className="btn btn-secondary btn-sm" disabled={busy || dirty} onClick={() => void run(async () => { await window.donwells.projectLanguageRestart(workspacePath); await checkOwner(role) })}>Start / resume language tools</button><button className="btn btn-secondary btn-sm" onClick={() => void window.donwells.projectLanguageStop(workspacePath).then(() => checkOwner(role)).catch(failure => setOwnerStatus(String(failure)))}>Pause language tools</button></>}
        {(role === 'learned' || role === 'temporal') && <button className="btn btn-secondary btn-sm" onClick={() => void (role === 'learned' ? window.donwells.projectKnowledgeStop(workspacePath) : window.donwells.projectTemporalKnowledgeStop(workspacePath)).then(() => checkOwner(role)).catch(failure => setOwnerStatus(String(failure)))}>Stop project requests</button>}
      </div>
    })()}

    <p>Saved settings apply across this project’s worktrees. Source indexes remain checkout-specific. Applying changes stops the project’s tool services and preserves a configuration backup.</p>
    <p><strong>Shared facts and decisions</strong> use the existing project memory store. Document search retrieves source text; the code graph finds structural relationships. Native session history remains separate from confirmed facts.</p>
    <details><summary>Use these tools from a terminal agent</summary>
      <p>In the agent launcher, use <strong>Set up shared project memory</strong> for a supported harness, then start its session. For another harness, adapt the configuration below. The same project-bound connection exposes the configured document and code tools.</p>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowConnection(true)}>Show MCP connection</button>
      <p>Ask the connected agent to call <code>project_engines</code> to inspect saved availability without starting optional services. A connection must be working before those tools can be called; configuring packages alone does not connect an agent.</p>
    </details>
    {showConnection && <ProjectMemoryConnection workspacePath={workspacePath} onClose={() => setShowConnection(false)} />}
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
        return <details key={tool.id} id={'project-tool-' + tool.id}>
          <summary>{tool.name} · {projectToolSetupStatus(report, tool.id)}</summary>
          {draft.disabled.includes(tool.id) !== report.configuration.disabled.includes(tool.id) && <p role="status">{draft.disabled.includes(tool.id) ? 'Will be disabled' : 'Will be enabled'} when you apply configuration. The status above is the saved state.</p>}
          {!service && !report.configuration.disabled.includes(tool.id) && tool.id !== 'backlog' && <p>Complete the paths below and apply configuration before checking this service.</p>}
          {service?.owner && <p>Owner: {service.scope === 'project' ? 'project' : 'checkout'} <code>{service.scope === 'project' ? service.owner.projectPath : service.owner.checkoutPath}</code><br />{service.activeCalls ?? 0} active calls{service.pid ? ` · Process ${service.pid}` : ''}</p>}
          <p>Admitted version: {tool.version}. {tool.scope}.</p>
          <p>{tool.models}</p>
          {tool.id === 'documents' && <p>After checking the service, call <code>documents_index</code>, then <code>documents_status</code> to inspect progress. Use <code>documents_search</code> and <code>documents_get</code> to retrieve cited sources. A ready service does not mean its index is current.</p>}
          {tool.id === 'code-graph' && <p>Call <code>code_graph_index</code> for this checkout, then <code>code_graph_callers</code> to inspect a symbol’s callers. <code>code_graph_status</code> reports the service; it does not establish index freshness.</p>}
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
          {tool.id === 'history' && ([['historyOmpRoots', 'OMP'], ['historyDshRoots', 'DeepSeek'], ['historyHermesRoots', 'Hermes'], ['historyKimiRoots', 'Kimi']] as const).map(([key, label]) => <label key={key} style={{ display: 'block' }}>{label} session roots, one per line<textarea className="settings-input" disabled={busy} value={(draft[key] ?? []).join('\n')} onChange={event => setDraft({ ...draft, [key]: event.target.value.split('\n') })} /></label>)}
          {service?.detail && <p role="status">{service.detail}</p>}
          {tool.id !== 'backlog' && <button type="button" className="btn btn-secondary btn-sm" disabled={busy || dirty || !service || Boolean(report.problem)} onClick={() => void run(() => window.donwells.projectDoctorRetry(workspacePath, tool.id))}>{tool.id === 'history' ? 'Reindex sessions' : service?.status === 'ready' ? 'Restart and check service' : service?.status === 'failed' ? 'Retry service' : 'Start and check service'}</button>}
          {tool.id !== 'backlog' && <button type="button" className="btn btn-secondary btn-sm" disabled={!service || (service.status === 'stopped' && !busy) || service.status === 'stopping'} onClick={() => void window.donwells.projectToolStop(workspacePath, tool.id).then(async () => { const value = await window.donwells.projectDoctorInspect(workspacePath); if (useAppStore.getState().activeWorktreePath === workspacePath) setReport(current => current && ({ ...current, services: value.services })) }).catch(error => setError(redactDesignCaptureSecrets(String(error))))}>Stop service</button>}
        </details>
      })}
      {(dirty || (report.problem && report.revision)) && <>
        <details ref={preview} open><summary>Configuration changes</summary>{!report.configurationValid && <p>The previous file is unreadable. Its original bytes will be preserved in a new backup.</p>}<pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{Object.keys({ ...report.configuration, ...draft }).filter(key => JSON.stringify(report.configuration[key as keyof ProjectToolConfiguration]) !== JSON.stringify(draft[key as keyof ProjectToolConfiguration])).map(key => redactDesignCaptureSecrets(`${key}\n− ${report.configurationValid ? JSON.stringify(report.configuration[key as keyof ProjectToolConfiguration] ?? null) : '[unreadable configuration]'}\n+ ${JSON.stringify(draft[key as keyof ProjectToolConfiguration] ?? null)}`)).join('\n\n')}</pre></details>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || (Boolean(report.problem) && report.revision === null)} onClick={() => void run(() => window.donwells.projectDoctorConfigure(workspacePath, { ...draft, referenceRoots: draft.referenceRoots.filter(Boolean), historyOmpRoots: draft.historyOmpRoots?.filter(Boolean), historyDshRoots: draft.historyDshRoots?.filter(Boolean), historyHermesRoots: draft.historyHermesRoots?.filter(Boolean), historyKimiRoots: draft.historyKimiRoots?.filter(Boolean) }, report.revision))}>Apply configuration and stop services</button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { setDraft(report.configuration); setBackupSelection('') }}>Discard changes</button>
      </>}
    </>}
  </section>
}
