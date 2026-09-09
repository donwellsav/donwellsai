import { useEffect, useState } from 'react'
import type { AgentPreset, AgentMemorySetupResult, AppMeta } from '@shared/types'
import { ModalDialog } from './ModalDialog'
import { useAppStore } from '../store'

export function ProjectMemoryConnection({ workspacePath, onClose }: { workspacePath: string; onClose(): void }) {
  const [providers, setProviders] = useState<AgentPreset[]>([])
  const [setup, setSetup] = useState<AgentMemorySetupResult | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [connected, setConnected] = useState(false)
  useEffect(() => { let live = true; void window.donwells.listAgents().then(value => { if (live) { setProviders(value); setHarness(current => current || value.find(item => item.available && ['codex', 'claude', 'omp', 'kimi', 'deepseek-harness', 'hermes'].includes(item.id))?.id || 'codex') } }, cause => { if (live) setError(String(cause)) }); return () => { live = false } }, [])
  const [meta, setMeta] = useState<AppMeta | null>(null)
  const [harness, setHarness] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [copying, setCopying] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    setMeta(null)
    setError(null)
    void window.donwells.meta().then((value) => { if (!cancelled) setMeta(value) }, (cause) => { if (!cancelled) setError(String(cause)) })
    return () => { cancelled = true }
  }, [loadAttempt])
  const validHarness = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(harness)
  const definition = meta?.memoryMcp && validHarness ? {
    command: meta.memoryMcp.command,
    args: [...meta.memoryMcp.args, 'memory-mcp', '--workspace', workspacePath, '--harness', harness, '--user-data', meta.userDataDir],
    env: meta.memoryMcp.env
  } : null
  const configuration = definition ? JSON.stringify({ mcpServers: { donwells_project_memory: definition } }, null, 2) : ''
  const copy = async (): Promise<void> => {
    if (!definition || copying) return
    setCopying(true)
    try {
      await navigator.clipboard.writeText(configuration)
      setCopied(true)
      setError(null)
    } catch (cause) {
      setError('Clipboard access failed. Select and copy the configuration manually. ' + String(cause))
    } finally {
      setCopying(false)
    }
  }
  const provider = providers.find(item => item.id === harness)
  const launch = async (args: string[]): Promise<void> => {
    if (!provider?.available) throw new Error('Install this harness before starting its native setup.')
    const result = await useAppStore.getState().runAgent(workspacePath, { executable: provider.executablePath ?? provider.command, args })
    if (!result.ok) throw new Error(result.error)
    useAppStore.getState().setSettingsOpen(false)
    onClose()
  }
  const connect = async (revision?: string): Promise<void> => {
    setConnecting(true); setError(null)
    try {
      const result = await window.donwells.agentConfigureMemory(workspacePath, harness, [], revision ? { action: 'apply', revision } : { action: 'preview' })
      setSetup(result); setConnected(!result.replacement && !result.launchArgs && !result.setupArgs)
      if (result.setupArgs) await launch(result.setupArgs)
      else if (result.launchArgs && ['codex', 'claude'].includes(harness)) await launch(result.launchArgs)
    } catch (cause) { setError(String(cause)) }
    finally { setConnecting(false) }
  }
  return (
    <ModalDialog className="modal memory-connection" labelledBy="memory-connect-title" onClose={onClose}>
      <h2 id="memory-connect-title" className="modal-title">Connect a coding harness</h2>
      <p className="memory-guidance">Connect agents to this project’s shared facts and decisions.</p>
      <p className="memory-connection-path" title={workspacePath}>{workspacePath}</p>
      <label>Harness<select className="input" value={harness} disabled={connecting} onChange={event => { setHarness(event.target.value); setSetup(null); setConnected(false); setCopied(false) }}>
        {!harness && <option value="">Discovering harnesses…</option>}
        {[...new Set(['codex', 'claude', ...providers.map(provider => provider.id), 'omp', 'kimi'])].map(provider => <option key={provider} value={provider}>{providers.find(item => item.id === provider)?.name ?? provider}</option>)}
      </select></label>
      {['codex', 'claude', 'omp', 'kimi', 'deepseek-harness', 'hermes'].includes(harness) && !connected && !setup?.launchArgs && !setup?.replacement && <button className="btn btn-primary" disabled={connecting || (['codex', 'claude', 'hermes'].includes(harness) && !provider?.available)} onClick={() => void connect()}>{connecting ? 'Connecting…' : ['codex', 'claude'].includes(harness) ? 'Start with project memory' : harness === 'hermes' ? 'Open Hermes memory setup' : 'Connect project memory'}</button>}
      {harness && ['codex', 'claude', 'hermes'].includes(harness) && !provider?.available && <p role="status">Install {provider?.name ?? harness} to use its native setup.</p>}
      {setup?.launchArgs && !setup.replacement && <button className="btn btn-primary" disabled={connecting || !provider?.available} onClick={async () => { setConnecting(true); try { await launch(setup.launchArgs!) } catch (cause) { setError(String(cause)) } finally { setConnecting(false) } }}>Start session with project memory</button>}
      {connected && <p role="status">Configuration saved. New sessions will load it.</p>}
      {setup?.replacement && <details open><summary>Review existing connection before replacing</summary><pre>{JSON.stringify({ current: setup.replacement.current, proposed: setup.replacement.proposed }, null, 2)}</pre><button className="btn btn-secondary" disabled={connecting} onClick={() => void connect(setup.replacement!.revision)}>Replace reviewed connection</button></details>}
      {error && <div className="memory-error" role="alert"><span>{error}</span>{!meta && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Retry runtime details</button>}</div>}
      {!meta && !error && <p role="status">Loading the installed CLI location…</p>}
      {meta && !meta.memoryMcp && <p className="memory-error">This runtime does not advertise a memory MCP launcher. Update the app before connecting a harness.</p>}
      {definition && <details><summary>Advanced: export connection</summary>
        <p className="memory-connection-summary">Configuration for <strong>{harness}</strong> · local project memory only</p>
        <label>Standard JSON configuration example<textarea className="input memory-config" readOnly value={configuration} aria-label="Project memory MCP configuration" /></label>
        <button type="button" className="btn btn-secondary" disabled={!definition || copying} onClick={() => void copy()}>{copying ? 'Copying…' : copied ? 'Copy again' : 'Copy configuration'}</button>
        <p className="memory-guidance">Use this definition for harnesses without native setup. Keep donwells.ai running while using project memory.</p>
      </details>}
      <footer className="modal-footer">
        <span className="memory-copy-status" role="status" aria-live="polite">{copied ? 'Configuration copied.' : ''}</span>
        <button type="button" className="btn btn-secondary" disabled={copying} onClick={onClose}>Close</button>
      </footer>
    </ModalDialog>
  )
}
