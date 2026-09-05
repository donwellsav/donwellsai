import { useEffect, useState } from 'react'
import type { AppMeta } from '@shared/types'
import { ModalDialog } from './ModalDialog'

export function ProjectMemoryConnection({ workspacePath, onClose }: { workspacePath: string; onClose(): void }) {
  const [meta, setMeta] = useState<AppMeta | null>(null)
  const [harness, setHarness] = useState('codex')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let cancelled = false
    void window.donwells.meta().then((value) => { if (!cancelled) setMeta(value) }, (cause) => { if (!cancelled) setError(String(cause)) })
    return () => { cancelled = true }
  }, [])
  const validHarness = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(harness)
  const definition = meta?.memoryMcp && validHarness ? {
    command: meta.memoryMcp.command,
    args: [...meta.memoryMcp.args, 'memory-mcp', '--workspace', workspacePath, '--harness', harness, '--user-data', meta.userDataDir],
    env: meta.memoryMcp.env
  } : null
  const configuration = definition ? JSON.stringify({ mcpServers: { donwells_project_memory: definition } }, null, 2) : ''
  const copy = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(configuration); setCopied(true); setError(null) }
    catch (cause) { setError('Clipboard access failed. Select and copy the configuration manually. ' + String(cause)) }
  }
  return (
    <ModalDialog className="modal memory-connection" labelledBy="memory-connect-title" onClose={onClose}>
      <h2 id="memory-connect-title">Connect a coding harness</h2>
      <p className="memory-guidance">This local MCP server is pinned to the selected project. Multiple harnesses read and update the same revision-checked memory; they never write separate note files.</p>
      <p className="memory-connection-path" title={workspacePath}>{workspacePath}</p>
      <label>Harness attribution<input className="input" value={harness} maxLength={128} onChange={(event) => { setHarness(event.target.value); setCopied(false) }} placeholder="codex, claude, omp, opencode…" /></label>
      {!validHarness && <p className="memory-error">Use a short identifier with letters, numbers, periods, underscores, slashes, or hyphens.</p>}
      {error && <p className="memory-error" role="alert">{error}</p>}
      {!meta && !error && <p role="status">Loading the installed CLI location…</p>}
      {meta && !meta.memoryMcp && <p className="memory-error">This runtime does not advertise a memory MCP launcher. Update the app before connecting a harness.</p>}
      {definition && <label>Standard JSON configuration example<textarea className="input memory-config" readOnly value={configuration} aria-label="Project memory MCP configuration" /></label>}
      <p className="memory-guidance">Adapt this server definition to your harness's MCP configuration format. Nothing is installed automatically. Keep donwells.ai running; the authenticated local runtime owns access. Attribution is self-reported, not a separate security identity.</p>
      <p className="memory-guidance">Available operations: search, read, record, replace, revision history, and archive/restore. No transcripts, repository files, or credentials are imported automatically.</p>
      <footer className="modal-footer"><button className="btn btn-secondary btn-sm" onClick={onClose}>Close</button><button className="btn btn-primary btn-sm" disabled={!definition} onClick={() => void copy()}>{copied ? 'Copied' : 'Copy configuration'}</button></footer>
    </ModalDialog>
  )
}
