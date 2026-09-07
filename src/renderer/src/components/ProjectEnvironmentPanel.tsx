import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { parseDiffFromFile } from '@pierre/diffs'
import { FileDiff } from '@pierre/diffs/react'
import type { ProjectEnvironment, LumeEnvironment, LumeEnvironmentConfig, SshEnvironmentConfig, EnvironmentResultReview, EnvironmentMemoryState, ProjectRemoteMethod } from '@shared/project-environment'
import type { TerminalSession } from '@shared/types'
import { useAppStore } from '../store'
import { terminalThemeOf } from '../terminal-themes'

function EnvironmentTerminal({ workspacePath, environment, sessionId, onError }: { workspacePath: string; environment: ProjectEnvironment; sessionId: string; onError: (message: string) => void }) {
  const host = useRef<HTMLDivElement>(null), error = useRef(onError); error.current = onError
  useEffect(() => {
    if (!host.current) return
    const settings = useAppStore.getState().settings
    const terminal = new Terminal({ theme: terminalThemeOf(settings.terminalTheme), fontSize: settings.terminalFontSize || 13, fontFamily: settings.terminalFontFamily || 'Menlo, monospace', scrollback: settings.scrollback ?? 10000, disableStdin: true })
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current); fit.fit()
    let disposed = false, observing = false, writing = false, input = '', sequence: number | null = null, previous = '', blocked = false
    const request = (method: ProjectRemoteMethod, params: Record<string, unknown>, requestId = crypto.randomUUID()) => window.donwells.environmentRequest(workspacePath, environment.id, environment.generation, method, params, requestId)
    const observe = async () => {
      if (disposed || observing || document.visibilityState !== 'visible') return
      observing = true
      try {
        const state = await request('terminal.observe', { sessionId }) as { scrollback: string; nextInputSequence: number; session: TerminalSession }
        if (disposed) return
        if (state.scrollback.startsWith(previous)) terminal.write(state.scrollback.slice(previous.length))
        else { terminal.reset(); terminal.write(state.scrollback) }
        previous = state.scrollback
        if (sequence === null) sequence = state.nextInputSequence
        terminal.options.disableStdin = blocked || state.session.exited || environment.state !== 'ready'
      } catch (failure) { if (!disposed) { blocked = true; terminal.options.disableStdin = true; error.current(String(failure)) } }
      finally { observing = false }
    }
    const flush = async () => {
      if (writing || blocked || sequence === null || !input || disposed) return
      const data = input; input = ''; writing = true
      const requestId = crypto.randomUUID()
      try {
        const result = await request('terminal.write', { sessionId, sequence, data }, requestId) as { state: string; error?: string }
        if (result.state !== 'completed') throw new Error(result.error ?? 'Input outcome is uncertain')
        sequence++; await observe()
      } catch (failure) { if (disposed) return; blocked = true; terminal.options.disableStdin = true; error.current(`Input stopped. Operation ${requestId}: ${String(failure)}. Reconnect to inspect; input was not retried.`) }
      finally { writing = false }
    }
    const data = terminal.onData(value => { if (blocked) return; if (new TextEncoder().encode(input + value).length > 65536) { error.current('Terminal input queue reached 64 KiB. The new paste was not queued.'); return } input += value })
    const inputTimer = setInterval(() => void flush(), 75), poll = setInterval(() => void observe(), 1000)
    const resize = new ResizeObserver(() => { if (disposed) return; fit.fit(); void request('terminal.resize', { sessionId, cols: terminal.cols, rows: terminal.rows }).catch(failure => error.current(String(failure))) })
    resize.observe(host.current); void observe()
    return () => { disposed = true; clearInterval(inputTimer); clearInterval(poll); resize.disconnect(); data.dispose(); terminal.dispose() }
  }, [workspacePath, environment.id, environment.generation, environment.state, sessionId])
  return <div ref={host} style={{ height: 340, minWidth: 0, background: '#16161d' }} aria-label="Remote project terminal" />
}

export function ProjectEnvironmentPanel() {
  const workspacePath = useAppStore(state => state.activeWorktreePath)
  const [environments, setEnvironments] = useState<ProjectEnvironment[]>([]), [selectedId, setSelectedId] = useState('')
  const [sessions, setSessions] = useState<TerminalSession[]>([]), [sessionId, setSessionId] = useState(''), [terminalGeneration, setTerminalGeneration] = useState(0)
  const [memory, setMemory] = useState<EnvironmentMemoryState>({ state: 'disconnected' })
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [paths, setPaths] = useState(''), [reviews, setReviews] = useState<EnvironmentResultReview[]>([]), [reviewId, setReviewId] = useState(''), [selectedFiles, setSelectedFiles] = useState<string[]>([])
  const environment = environments.find(item => item.id === selectedId), review = reviews.find(item => item.id === reviewId)
  const activeWorkspace = useRef(workspacePath); activeWorkspace.current = workspacePath
  const refresh = async () => { if (!workspacePath) return; const values = await window.donwells.environmentList(workspacePath); if (activeWorkspace.current === workspacePath) { setEnvironments(values); setSelectedId(current => values.some(item => item.id === current) ? current : values[0]?.id ?? '') } }
  useEffect(() => { setEnvironments([]); setSelectedId(''); setSessions([]); setSessionId(''); setReviews([]); setReviewId(''); setSelectedFiles([]); setError(''); void refresh().catch(failure => setError(String(failure))) }, [workspacePath])
  useEffect(() => {
    setSessions([]); setSessionId(''); setReviews([]); setReviewId(''); setSelectedFiles([]); setMemory({ state: 'disconnected' })
    if (!workspacePath || !environment) return
    let cancelled = false
    void Promise.all([window.donwells.environmentResultsList(workspacePath, environment.id, environment.generation), window.donwells.environmentMemory(workspacePath, environment.id, environment.generation, 'status')]).then(([values, state]) => { if (!cancelled) { setReviews(values); setReviewId(values[0]?.id ?? ''); setMemory(state) } }).catch(failure => { if (!cancelled) setError(String(failure)) })
    return () => { cancelled = true }
  }, [workspacePath, selectedId])
  const run = async (action: () => Promise<unknown>) => { if (busy) return; setBusy(true); setError(''); try { await action(); await refresh() } catch (failure) { if (activeWorkspace.current === workspacePath) setError(String(failure)) } finally { setBusy(false) } }
  const request = (method: ProjectRemoteMethod, params: Record<string, unknown> = {}) => window.donwells.environmentRequest(workspacePath!, environment!.id, environment!.generation, method, params, crypto.randomUUID())
  const loadSessions = async () => { const values = await request('terminal.list') as TerminalSession[]; if (activeWorkspace.current !== workspacePath) return; setSessions(values); setSessionId(current => values.some(item => item.id === current) ? current : values[0]?.id ?? '') }
  const acceptReview = (value: EnvironmentResultReview) => { if (activeWorkspace.current !== value.workspacePath) return; setReviews(current => [value, ...current.filter(item => item.id !== value.id)]); setReviewId(value.id); setSelectedFiles([]) }
  const configure = async (form: HTMLFormElement) => {
    const data = new FormData(form), field = (name: string) => String(data.get(name) ?? '').trim()
    const config: SshEnvironmentConfig = { kind: 'ssh', hostname: field('hostname'), port: Number(field('port')), username: field('username'), identityFile: field('identityFile'), hostKey: field('hostKey'), hostFingerprint: field('hostFingerprint'), remoteProjectId: field('remoteProjectId'), remoteRoot: field('remoteRoot') }
    const created = await window.donwells.environmentConfigure(workspacePath!, field('id'), config); setSelectedId(created.id)
  }
  const diff = useMemo(() => review?.files.map(file => ({ file, metadata: file.received === undefined || file.baseContent === null && file.received === null ? null : parseDiffFromFile(file.baseContent === null ? null : { name: file.path, contents: file.baseContent }, file.received === null ? null : { name: file.path, contents: file.received!.content }, undefined, true) })) ?? [], [review])
  if (!workspacePath) return <p>Select a project to configure an environment.</p>
  return <section className="project-tool-settings" aria-label="Project environments" aria-busy={busy}>
    <h3>Project environments</h3>
    <LumeEnvironmentSection key={workspacePath} workspacePath={workspacePath} />
    <p>Run terminal agents in a paired macOS guest. Closing this panel leaves remote work running.</p>
    <details><summary>Pair an SSH environment</summary>
      <form onSubmit={event => { event.preventDefault(); const form = event.currentTarget; void run(() => configure(form)) }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
          {([['id','Environment ID'], ['hostname','Host'], ['port','SSH port'], ['username','Dedicated account'], ['identityFile','Private SSH key path'], ['remoteProjectId','Remote project ID'], ['remoteRoot','Remote project folder'], ['hostKey','Host public key (ssh-ed25519 …)'], ['hostFingerprint','Fingerprint verified outside this connection']] as const).map(([name,label]) => <label key={name}>{label}<input name={name} required defaultValue={name === 'port' ? '22' : undefined} style={{ width: '100%' }} /></label>)}
        </div><p>The server needs the restricted project endpoint and administrator-owned mapping. Pairing does not install software or change SSH configuration.</p><button disabled={busy}>Save pairing</button>
      </form>
    </details>
    {environments.length > 0 && <label>Environment <select disabled={busy} value={selectedId} onChange={event => setSelectedId(event.target.value)}>{environments.map(item => <option key={item.id} value={item.id}>{item.id} · {item.state}</option>)}</select></label>}
    {environment && <>
      <p>{environment.config.username}@{environment.config.hostname}:{environment.config.port} · {environment.config.remoteRoot}</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button disabled={busy} onClick={() => void run(async () => { await window.donwells.environmentConnect(workspacePath, environment.id, environment.generation); await loadSessions() })}>Connect / resume</button>
        <button disabled={busy} onClick={() => void run(() => window.donwells.environmentPause(workspacePath, environment.id, environment.generation))}>Pause new work</button>
        <button disabled={busy || environment.state !== 'ready'} onClick={() => void run(async () => setMemory(await window.donwells.environmentMemory(workspacePath, environment.id, environment.generation, 'start')))}>Connect shared memory</button>
        <button onClick={() => void window.donwells.environmentMemory(workspacePath, environment.id, environment.generation, 'stop').then(setMemory).catch(failure => setError(String(failure)))}>Disconnect memory</button>
      </div><p>Shared memory: {memory.state}{memory.detail ? ' · ' + memory.detail : ''}</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button disabled={busy || environment.state !== 'ready'} onClick={() => void run(async () => { const result = await request('agent.start') as { state: string; result?: { session: TerminalSession }; error?: string }; if (result.state !== 'completed') throw new Error(result.error ?? 'Agent start is uncertain'); await loadSessions(); setSessionId(result.result!.session.id) })}>OpenCode terminal</button>
        <button disabled={busy || environment.state !== 'ready'} onClick={() => void run(async () => { const result = await request('terminal.open', { cols: 100, rows: 30 }) as { state: string; result?: TerminalSession; error?: string }; if (result.state !== 'completed') throw new Error(result.error ?? 'Terminal start is uncertain'); await loadSessions(); setSessionId(result.result!.id) })}>New shell</button>
        <button disabled={busy} onClick={() => void run(async () => { await loadSessions(); setTerminalGeneration(value => value + 1) })}>Reconnect terminals</button>
        {sessionId && <button onClick={() => void request('terminal.stop', { sessionId }).then(loadSessions).catch(failure => setError(String(failure)))}>Stop selected terminal</button>}
      </div>
      {sessions.length > 0 && <select aria-label="Remote terminal" value={sessionId} onChange={event => setSessionId(event.target.value)}>{sessions.map(item => <option key={item.id} value={item.id}>{item.title || item.id}{item.exited ? ' · stopped' : ''}</option>)}</select>}
      {sessionId && <EnvironmentTerminal key={terminalGeneration} workspacePath={workspacePath} environment={environment} sessionId={sessionId} onError={setError} />}
      <details><summary>Source snapshot and reviewed results</summary>
        <label>Relative text file paths, one per line<textarea value={paths} onChange={event => setPaths(event.target.value)} rows={4} style={{ width: '100%' }} /></label>
        <p>Capture records the current local bytes, including uncommitted edits. Sending creates selected files in the remote project and refuses existing destinations. New result paths may be listed before they exist.</p>
        <button disabled={busy || !paths.trim()} onClick={() => void run(async () => acceptReview(await window.donwells.environmentResultsCapture(workspacePath, environment.id, environment.generation, paths.split('\n').map(value => value.trim()).filter(Boolean))))}>Capture selected source</button>
        {reviews.length > 0 && <select aria-label="Result review" value={reviewId} onChange={event => { setReviewId(event.target.value); setSelectedFiles([]) }}>{reviews.map(item => <option key={item.id} value={item.id}>{item.id.slice(0,8)} · {item.files.length} files</option>)}</select>}
        {review && <>
          <div><button disabled={busy} onClick={() => void run(async () => acceptReview(await window.donwells.environmentResultsSend(workspacePath, review.id)))}>Send source snapshot</button> <button disabled={busy} onClick={() => void run(async () => acceptReview(await window.donwells.environmentResultsStage(workspacePath, review.id)))}>Fetch results for review</button></div>
          {diff.map(({ file, metadata }) => <details key={file.path}><summary><input aria-label={'Select result ' + file.path} type="checkbox" disabled={file.received === undefined || file.state === 'applied'} checked={selectedFiles.includes(file.path)} onClick={event => event.stopPropagation()} onChange={event => setSelectedFiles(current => event.target.checked ? [...current, file.path] : current.filter(path => path !== file.path))} /> {file.path} · {file.state}</summary>{file.error && <p role="alert">{file.error}</p>}{file.state === 'conflict' && <details><summary>Current local content</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{file.currentContent ?? '(File absent)'}</pre></details>}{metadata && <FileDiff fileDiff={metadata} disableWorkerPool options={{ theme: 'github-dark', themeType: 'dark', diffStyle: 'split', disableFileHeader: true }} />}</details>)}
          <button disabled={busy || !selectedFiles.length} onClick={() => void run(async () => acceptReview(await window.donwells.environmentResultsApply(workspacePath, review.id, selectedFiles)))}>Apply selected reviewed changes</button>
        </>}
      </details>
    </>}
    {error && <p role="alert" style={{ whiteSpace: 'pre-wrap' }}>{error}</p>}
  </section>
}


function LumeEnvironmentSection({ workspacePath }: { workspacePath: string }) {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof window.donwells.environmentLumeList>> | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const active = useRef(true)
  useEffect(() => { active.current = true; void window.donwells.environmentLumeList(workspacePath).then(value => { if (active.current) setInfo(value) }).catch(failure => { if (active.current) setError(String(failure)) }); return () => { active.current = false } }, [workspacePath])
  const perform = async (action: () => Promise<unknown>) => { if (busy) return; setBusy(true); setError(''); try { await action(); const value = await window.donwells.environmentLumeList(workspacePath); if (active.current) setInfo(value) } catch (failure) { if (active.current) setError(String(failure)) } finally { if (active.current) setBusy(false) } }
  const guestAction = (guest: LumeEnvironment, action: 'start' | 'stop' | 'status') => perform(() => window.donwells.environmentLumeAction(workspacePath, guest.id, action))
  return <details aria-label="Prepared Lume desktops"><summary>Lume desktops · prepared guests</summary>
    <p>4 CPUs · 8 GiB RAM · NAT · clipboard and VNC disabled. Start requires an admitted patched build. Closing this view does not stop its guest.</p>
    {error && <p role="alert">{error}</p>}
    {info && <>
      {info.guests.map(guest => <div key={guest.id}><strong>{guest.id} · {guest.state}</strong><p>{guest.pid ? `Owner PID ${guest.pid}. ` : ''}{guest.ipAddress ? `Guest address ${guest.ipAddress}. Pair this address through SSH below for terminals and shared memory.` : 'Use Refresh owner to inspect boot and connection state.'}</p>{guest.detail && <p role="status">{guest.detail}</p>}<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><button className="btn btn-secondary btn-sm" disabled={busy || guest.state !== 'stopped'} onClick={() => void guestAction(guest, 'start')}>Start desktop</button><button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void guestAction(guest, 'status')}>Refresh / reconnect owner</button><button className="btn btn-secondary btn-sm" disabled={busy || !['running', 'starting'].includes(guest.state)} onClick={() => void guestAction(guest, 'stop')}>Stop desktop</button></div></div>)}
      <details><summary>Register a newly prepared guest</summary><p>Prepared machines must be inside <code>{info.storageDirectory}</code>. Existing user VMs cannot be selected. Admission receipt: <code>{info.admissionPath}</code>.</p>
        <form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget), field = (name: string) => String(data.get(name) ?? '').trim(); const config: LumeEnvironmentConfig = { storageDirectory: info.storageDirectory, name: field('machine'), machineIdentifierSha256: field('identity'), mounts: [{ path: field('source'), mode: 'ro', purpose: 'source' }, { path: field('results'), mode: 'rw', purpose: 'results' }] }; void perform(() => window.donwells.environmentLumeRegister(workspacePath, field('id'), config)) }}>
          {([['id', 'Environment ID', ''], ['machine', 'Prepared machine name', ''], ['identity', 'Machine identifier SHA-256', ''], ['source', 'Read-only project folder', workspacePath], ['results', 'Writable return folder', info.returnDirectory]] as const).map(([name, label, value]) => <label key={name} style={{ display: 'grid', gap: 4, marginBlock: 10 }}>{label}<input name={name} required defaultValue={value} disabled={busy} /></label>)}
          <button className="btn btn-secondary btn-sm" disabled={busy}>Register prepared guest</button>
        </form>
      </details>
    </>}
  </details>
}
