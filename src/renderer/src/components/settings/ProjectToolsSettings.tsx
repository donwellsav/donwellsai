import { guiDraftMap } from '../../gui-drafts'
import { useEffect, useRef, useState } from 'react'
import downloads from '@shared/project-tool-downloads.json'
import { PROJECT_AUTOMATIC_TOOL_FILES, INTEGRATED_PROJECT_TOOLS, PROJECT_INTEGRATION_ROLES, PROJECT_TOOL_FIELDS, projectDoctorDiagnostics, projectToolSetupStatus, type ProjectDoctorReport, type ProjectToolConfiguration } from '@shared/project-doctor'
import { redactDesignCaptureSecrets } from '@shared/design-capture'
import { useAppStore } from '../../store'
import { ProjectMemoryConnection } from '../ProjectMemoryConnection'

const toolDrafts = guiDraftMap<{ report: ProjectDoctorReport; draft: ProjectToolConfiguration }>('project-tools')

export function ProjectToolsSettings({ onNavigate }: { onNavigate?: (route: 'memory' | 'search') => void } = {}) {
  const workspacePath = useAppStore(state => state.activeWorktreePath)
  const recovered = workspacePath ? toolDrafts.get(workspacePath) : undefined
  const operation = useRef(false)
  const [loadedWorkspace, setLoadedWorkspace] = useState(recovered ? workspacePath : null)
  const [role, setRole] = useState('')
  const [ownerStatus, setOwnerStatus] = useState('Not checked')
  const roleOperation = useRef(0)
  const [report, setReport] = useState<ProjectDoctorReport | null>(recovered?.report ?? null)
  const [draft, setDraft] = useState<ProjectToolConfiguration | null>(recovered?.draft ?? null)
  const [backupSelection, setBackupSelection] = useState('')
  const [showConnection, setShowConnection] = useState(false)
  const preview = useRef<HTMLDetailsElement>(null)
  useEffect(() => { if (backupSelection) preview.current?.scrollIntoView({ block: 'nearest' }) }, [backupSelection])
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [statusError, setStatusError] = useState('')
  const dirty = Boolean(report && draft && JSON.stringify(report.configuration) !== JSON.stringify(draft))
  const accept = (value: ProjectDoctorReport) => { setLoadedWorkspace(workspacePath); setReport(value); setDraft(value.configuration); setBackupSelection('') }
  useEffect(() => {
    let cancelled = false
    const saved = workspacePath ? toolDrafts.get(workspacePath) : undefined
    setLoadedWorkspace(saved ? workspacePath : null); setReport(saved?.report ?? null); setDraft(saved?.draft ?? null); setError(''); setStatusError(''); setBackupSelection(''); setShowConnection(false)
    if (workspacePath) void window.donwells.projectDoctorInspect(workspacePath).then(value => { if (!cancelled && !saved) accept(value) }).catch(error => { if (!cancelled) setError(redactDesignCaptureSecrets(String(error))) })
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
  useEffect(() => {
    if (!workspacePath || !report || !draft || loadedWorkspace !== workspacePath) return
    if (dirty) toolDrafts.set(workspacePath, { report, draft })
    else toolDrafts.delete(workspacePath)
  }, [workspacePath, loadedWorkspace, report, draft, dirty])
  const checkOwner = async (id: string) => {
    const generation = ++roleOperation.current
    setOwnerStatus('Checking…')
    try {
      let detail = 'Open its existing controls to inspect the current owner.'
      if (id === 'language') { const value = await window.donwells.projectLanguageStatus(workspacePath!); detail = `${value.state} · ${value.detail}${value.pid ? ` · PID ${value.pid}` : ''}` }
      if (id === 'learned') { const value = await window.donwells.projectKnowledgeStatus(workspacePath!); detail = `${value.enabled ? value.phase : 'disabled'} · ${value.error ?? (value.stale ? 'Sources changed; reconcile selected sources' : 'Source manifest inspected; external connection not checked')}` }
      if (id === 'temporal') { const value = await window.donwells.projectTemporalKnowledgeStatus(workspacePath!); detail = `${value.enabled ? (value.busy ? 'working' : 'idle') : 'disabled'} · ${value.error ?? 'Source manifest inspected; external connection not checked'}` }
      if (id === 'facts') { const value = await window.donwells.projectMemoryList({ workspacePath: workspacePath! }); detail = `${value.total} canonical facts · local store readable · no background process to stop` }
      if (id === 'analytics') detail = report?.configuration.duckdbPython ? 'Python path configured; execute a report in Search → Sessions to verify DuckDB. Cancel remains beside that report.' : 'Set DuckDB Python under Native session history. Runtime has not been checked.'
      if (generation === roleOperation.current) setOwnerStatus(detail)
    } catch (failure) { if (generation === roleOperation.current) setOwnerStatus(redactDesignCaptureSecrets(String(failure))) }
  }
  useEffect(() => { roleOperation.current++; setRole(''); setOwnerStatus('Not checked') }, [workspacePath])
  const openRole = (route: string) => {
    if (route === 'memory' || route === 'search') onNavigate?.(route)
  }
  const run = async (action: () => Promise<unknown>) => {
    if (operation.current || !workspacePath) return
    operation.current = true
    setBusy(true); setError('')
    try {
      const result = await action()
      const value = result && typeof result === 'object' && 'configurationPath' in result
        ? result as ProjectDoctorReport : await window.donwells.projectDoctorInspect(workspacePath)
      if (useAppStore.getState().activeWorktreePath === workspacePath) accept(value)
    } catch (error) { if (useAppStore.getState().activeWorktreePath === workspacePath) setError(redactDesignCaptureSecrets(String(error))) }
    finally { operation.current = false; setBusy(false) }
  }
  const save = (next: ProjectToolConfiguration) => {
    if (operation.current || !report) return
    setDraft(next)
    void run(() => window.donwells.projectDoctorConfigure(workspacePath!, next, report.revision))
  }
  const addFolder = async (field: 'referenceRoots' | 'historyOmpRoots' | 'historyDshRoots' | 'historyHermesRoots' | 'historyKimiRoots') => {
    if (operation.current || !workspacePath || !draft || !report) return
    void run(async () => {
      const folder = await window.donwells.pickDirectory()
      if (!folder || useAppStore.getState().activeWorktreePath !== workspacePath || draft[field]?.includes(folder)) return
      const selected = draft[field] ?? (field === 'referenceRoots' ? [] : report.discoveredHistoryRoots?.[field] ?? [])
      if (selected.includes(folder)) return
      const next = { ...draft, [field]: [...selected, folder] }
      setDraft(next)
      return window.donwells.projectDoctorConfigure(workspacePath, next, report.revision)
    })
  }
  if (!workspacePath) return <p>Select a project to configure its tools.</p>
  return <section className="project-tool-settings" aria-busy={busy} aria-label="Project tools" data-settings-dirty={dirty ? 'true' : undefined}>
    <p>Files, terminals and shared project memory work without setup. Available tool services start when you use them.</p>


    {error && <p role="alert">{error}</p>}
    {statusError && <p role="status">{statusError}</p>}
    {report?.problem && <p role="alert">{report.problem} {report.configurationPath}</p>}
    {!report && !error && <p role="status">Checking project settings…</p>}
    {report && draft && <>
      <details className="project-settings-group"><summary>Optional tools</summary>
      <p>Add capabilities when you need them. Installed command-line tools are detected when the app starts.</p>
      {INTEGRATED_PROJECT_TOOLS.map(tool => {
        const service = report.services.find(value => value.id === tool.id)
        const required = tool.fields.filter(field => !['embeddingModel', 'rerankingModel', 'duckdbPython'].includes(field))
        const missing = required.filter(field => !draft[field] && Object.hasOwn(PROJECT_AUTOMATIC_TOOL_FILES, field))
        const installable = missing.length > 0 && required.every(field => draft[field] || Object.hasOwn(PROJECT_AUTOMATIC_TOOL_FILES, field))
        const setupStatus = projectToolSetupStatus(report, tool.id)
        const status = setupStatus === 'not configured' ? 'Not installed' : setupStatus === 'stopped' ? 'Starts when needed' : setupStatus
        return <details key={tool.id} id={'project-tool-' + tool.id}>
          <summary>{tool.name} · {status}</summary>
          <p>{({ history: 'Search previous agent conversations.', backlog: 'Track tasks in your project files.', 'code-graph': 'Find code relationships and callers.', documents: 'Search project documents and selected reference folders.', 'browser-testing': 'Let connected agents test your local preview.', 'computer-control': 'Let connected agents interact with an attached app window.' })[tool.id]}</p>
          {installable && <button title="Download and configure the required components. Optional AI models are separate." type="button" className="btn btn-primary btn-sm" disabled={busy || dirty} onClick={() => void run(async () => {
            let current = report
            for (const field of missing) {
              current = await window.donwells.projectDoctorSetup(workspacePath, field, current.revision)
              if (useAppStore.getState().activeWorktreePath === workspacePath) accept(current)
            }
          })}>{busy ? 'Setting up…' : `Install ${tool.name}`}</button>}
          {!service && !installable && !draft[tool.fields[0]] && <p>This optional integration does not have an automatic installer yet.</p>}
          {(service || draft[tool.fields[0]]) && <label><input type="checkbox" disabled={busy || dirty} checked={!draft.disabled.includes(tool.id)} onChange={event => save({ ...draft, disabled: event.target.checked ? draft.disabled.filter(id => id !== tool.id) : [...draft.disabled, tool.id] })} />Use {tool.name} in this project</label>}
          {tool.id === 'history' && <p>Session history uses this project’s and checkout’s agent folders plus the agents’ default locations automatically. Only conversations belonging to this project are included.</p>}
          <details><summary>Advanced settings and troubleshooting</summary>
          {service?.owner && <p>Owner: {service.scope === 'project' ? 'project' : 'checkout'} <code>{service.scope === 'project' ? service.owner.projectPath : service.owner.checkoutPath}</code><br />{service.activeCalls ?? 0} active calls{service.pid ? ` · Process ${service.pid}` : ''}</p>}
          <p>Admitted version: {tool.version}. {tool.scope}.</p>
          <p>{tool.models}</p>
          {tool.id === 'documents' && <label>Retrieval mode<select className="settings-input" disabled={busy || dirty} value={draft.documentRetrievalMode ?? 'auto'} onChange={event => save({ ...draft, documentRetrievalMode: event.target.value as 'auto' | 'lexical' | 'hybrid' })}>
            <option value="auto">Automatic — hybrid when models are ready</option>
            <option value="lexical">Lexical — no model loading</option>
            <option value="hybrid">Require hybrid — report unavailable instead of falling back</option>
          </select><small>Applies to this project’s app and native-agent document searches. Changing it stops document workers; retained indexes and model paths are preserved.</small></label>}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void window.donwells.openExternal(tool.source)}>Source</button>
          {tool.fields.map(field => {
            const resource = report.resources.find(value => value.field === field)
            const download = downloads[field as keyof typeof downloads]
            const automatic = Object.hasOwn(PROJECT_AUTOMATIC_TOOL_FILES, field)
            return <div key={field}>
              <strong>{PROJECT_TOOL_FIELDS[field]}</strong>
              {resource && <p role="status">{resource.problem ?? 'Local component found; service validation runs when started.'}</p>}
              {download && automatic && !draft[field] && <button className="btn btn-primary btn-sm" disabled={busy || dirty} onClick={() => void run(() => window.donwells.projectDoctorSetup(workspacePath, field, report.revision))}>{busy ? 'Setting up…' : `Download and set up (${(download.bytes / 1048576).toFixed(0)} MB)`}</button>}
              {!automatic && !draft[field] && <p>{field === 'historyBinary' ? 'Automatic setup is unavailable: history needs the Donwells cwd3 patched build. The upstream download will not work.' : 'This integration still requires a separately installed package and its dependencies.'}</p>}
              <details><summary>Advanced: local path override</summary><label style={{ display: 'block', marginBlock: 8 }}>{PROJECT_TOOL_FIELDS[field]}
                <input className="settings-input" style={{ width: '100%' }} disabled={busy} value={draft[field] ?? ''} placeholder="Absolute local path" onChange={event => setDraft({ ...draft, [field]: event.target.value })} />
              </label></details>
              {download && <details><summary>Distribution details</summary><p>{download.instructions}</p><p>{download.file} · {download.bytes.toLocaleString()} bytes</p><p style={{overflowWrap:'anywhere'}}>SHA-256: {download.sha256}</p>{field !== 'historyBinary' && <button type="button" className="btn btn-secondary btn-sm" onClick={() => void window.donwells.openExternal(download.url)}>Download separately</button>}</details>}
            </div>
          })}
          {(tool.id === 'documents' ? [['referenceRoots', 'Reference folders']] as const : tool.id === 'history' ? [['historyOmpRoots', 'OMP session folders'], ['historyDshRoots', 'DeepSeek session folders'], ['historyHermesRoots', 'Hermes session folders'], ['historyKimiRoots', 'Kimi session folders']] as const : []).map(([field, label]) => <section key={field} className="project-folder-setting" aria-label={label}>
            <h4>{label}</h4>
            {field !== 'referenceRoots' && <label><input type="checkbox" disabled={busy || dirty} checked={draft[field] !== undefined} onChange={event => save({ ...draft, [field]: event.target.checked ? report.discoveredHistoryRoots?.[field] ?? [] : undefined })} />Use custom locations instead of automatic discovery</label>}
            {(field === 'referenceRoots' || draft[field] !== undefined) && <>
            {(draft[field] ?? []).map(folder => <div className="project-folder-row" key={folder}><span title={folder}>{folder}</span><button type="button" className="btn btn-sm" disabled={busy || dirty} aria-label={`Remove ${folder} from ${label}`} title="Remove this folder from the configured search roots; files stay on disk" onClick={() => save({ ...draft, [field]: (draft[field] ?? (field === 'referenceRoots' ? [] : report.discoveredHistoryRoots?.[field] ?? [])).filter(value => value !== folder) })}>Remove</button></div>)}
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy || dirty || (draft[field]?.length ?? 0) >= (field === 'referenceRoots' ? 15 : 16)} onClick={() => void addFolder(field)}>Add folder…</button>
            </>}
          </section>)}
          {service?.detail && <p role="status">{service.detail}</p>}
          {tool.id !== 'backlog' && <button type="button" className="btn btn-secondary btn-sm" disabled={busy || dirty || !service || Boolean(report.problem)} onClick={() => void run(() => window.donwells.projectDoctorRetry(workspacePath, tool.id))}>{tool.id === 'history' ? 'Reindex sessions' : service?.status === 'ready' ? 'Restart and check service' : service?.status === 'failed' ? 'Retry service' : 'Start and check service'}</button>}
          {tool.id !== 'backlog' && <button type="button" className="btn btn-secondary btn-sm" disabled={!service || (service.status === 'stopped' && !busy) || service.status === 'stopping'} onClick={() => void window.donwells.projectToolStop(workspacePath, tool.id).then(async () => { const value = await window.donwells.projectDoctorInspect(workspacePath); if (useAppStore.getState().activeWorktreePath === workspacePath) setReport(current => current && ({ ...current, services: value.services })) }).catch(error => setError(redactDesignCaptureSecrets(String(error))))}>Stop service</button>}
          </details>
        </details>
      })}
      </details>
      <details className="project-settings-group"><summary>Memory and language services</summary>
    <label>Integration <select aria-label="Integration" className="settings-input" value={role} onChange={event => { const id = event.target.value; setRole(id); if (id) void checkOwner(id) }}><option value="">Choose an integration</option>{PROJECT_INTEGRATION_ROLES.filter(item => item.route !== 'package').map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    {role && (() => {
      const selected = PROJECT_INTEGRATION_ROLES.find(item => item.id === role)!
      return <div aria-label={selected.name + ' controls'}><p role="status">{ownerStatus}</p>
        <button className="btn btn-secondary btn-sm" onClick={() => void checkOwner(role)}>Refresh owner status</button>
        {selected.route !== 'language' && <button className="btn btn-secondary btn-sm" disabled={dirty} onClick={() => openRole(selected.route)}>{role === 'analytics' ? 'Open Search → Sessions' : 'Open configuration and controls'}</button>}
        {role === 'language' && <><p>Uses this checkout’s TypeScript installation. Install or repair its TypeScript dependency through your terminal, then start. Pausing prevents editor changes from restarting this owner; bundled open-file tools remain available.</p><button className="btn btn-secondary btn-sm" disabled={busy || dirty} onClick={() => void run(async () => { await window.donwells.projectLanguageRestart(workspacePath); await checkOwner(role) })}>Start / resume language tools</button><button className="btn btn-secondary btn-sm" onClick={() => void window.donwells.projectLanguageStop(workspacePath).then(() => checkOwner(role)).catch(failure => setOwnerStatus(String(failure)))}>Pause language tools</button></>}
        {(role === 'learned' || role === 'temporal') && <button className="btn btn-secondary btn-sm" onClick={() => void (role === 'learned' ? window.donwells.projectKnowledgeStop(workspacePath) : window.donwells.projectTemporalKnowledgeStop(workspacePath)).then(() => checkOwner(role)).catch(failure => setOwnerStatus(String(failure)))}>Stop project requests</button>}
      </div>
    })()}
      </details>
      <details className="project-settings-group"><summary>Diagnostics and configuration backups</summary>
      <button type="button" className="btn btn-secondary btn-sm" disabled={busy || dirty} onClick={() => void run(async () => {})}>Refresh status</button>
      <p>{report.workspacePath}</p>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => void navigator.clipboard.writeText(projectDoctorDiagnostics(report)).catch(() => setError('Could not copy setup diagnosis'))}>Copy setup diagnosis</button>
      <p>Available cache disk: {report.availableDiskBytes === null ? 'unknown' : `${(report.availableDiskBytes / 1073741824).toFixed(1)} GiB`}. Provider usage: unavailable; consult the native CLI.</p>
      {report.backups.length > 0 && <label>Review saved configuration<select className="settings-input" value={backupSelection} disabled={busy || dirty} onChange={event => {
        const name = event.target.value
        if (name) void window.donwells.projectDoctorPreviewBackup(workspacePath, name).then(config => { if (useAppStore.getState().activeWorktreePath === workspacePath) { setDraft(config); setBackupSelection(name) } }).catch(error => setError(redactDesignCaptureSecrets(String(error))))
      }}><option value="">Choose a backup to review</option>{report.backups.map(backup => <option key={backup.name} value={backup.name}>{new Date(backup.createdAt).toLocaleString()}</option>)}</select></label>}
    <p>Saved settings apply across this project’s worktrees. Source indexes remain checkout-specific. Applying changes stops the project’s tool services and preserves a configuration backup.</p>
    <p><strong>Shared facts and decisions</strong> use the existing project memory store. Document search retrieves source text; the code graph finds structural relationships. Native session history remains separate from confirmed facts.</p>
    <details><summary>Use these tools from a terminal agent</summary>
      <p>In the agent launcher, use <strong>Set up shared project memory</strong> for a supported harness, then start its session. For another harness, adapt the configuration below. The same project-bound connection exposes the configured document and code tools.</p>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowConnection(true)}>Show MCP connection</button>
      <p>Ask the connected agent to call <code>project_engines</code> to inspect saved availability without starting optional services. A connection must be working before those tools can be called; configuring packages alone does not connect an agent.</p>
    </details>
    <p>Optional tools are installed separately. Downloads require a connection; installed tools and local models can work offline. Without them, terminals, files and shared project memory remain available.</p>

      </details>
      {(dirty || (report.problem && report.revision)) && <>
        <p role="status">Unsaved changes. Saving restarts affected project services when they are next used.</p><details ref={preview} open={Boolean(backupSelection)}><summary>Review changes</summary>{!report.configurationValid && <p>The previous file is unreadable. Its original bytes will be preserved in a new backup.</p>}<pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{Object.keys({ ...report.configuration, ...draft }).filter(key => JSON.stringify(report.configuration[key as keyof ProjectToolConfiguration]) !== JSON.stringify(draft[key as keyof ProjectToolConfiguration])).map(key => redactDesignCaptureSecrets(`${key}\n− ${report.configurationValid ? JSON.stringify(report.configuration[key as keyof ProjectToolConfiguration] ?? null) : '[unreadable configuration]'}\n+ ${JSON.stringify(draft[key as keyof ProjectToolConfiguration] ?? null)}`)).join('\n\n')}</pre></details>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || (Boolean(report.problem) && report.revision === null)} onClick={() => void run(() => window.donwells.projectDoctorConfigure(workspacePath, { ...draft, referenceRoots: draft.referenceRoots.filter(Boolean), historyOmpRoots: draft.historyOmpRoots?.filter(Boolean), historyDshRoots: draft.historyDshRoots?.filter(Boolean), historyHermesRoots: draft.historyHermesRoots?.filter(Boolean), historyKimiRoots: draft.historyKimiRoots?.filter(Boolean) }, report.revision))}>Save changes</button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { setDraft(report.configuration); setBackupSelection('') }}>Discard changes</button>
      </>}
    </>}
    {showConnection && <ProjectMemoryConnection workspacePath={workspacePath} onClose={() => setShowConnection(false)} />}
  </section>
}
