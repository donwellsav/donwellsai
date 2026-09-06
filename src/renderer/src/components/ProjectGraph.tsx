import { useEffect, useId, useRef, useState } from 'react'
import type { ToolServiceState } from '@shared/project-tools'
import { graphResult } from '../project-graph'
import { useAppStore } from '../store'

export function ProjectGraph({ workspacePath, active }: { workspacePath: string; active: boolean }) {
  const inputId = useId()
  const query = useAppStore(state => state.contentSearch.graphQuery ?? '')
  const [service, setService] = useState<ToolServiceState | null>(null)
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState<ReturnType<typeof graphResult> | null>(null)
  const generation = useRef(0)
  useEffect(() => {
    const token = ++generation.current
    setService(null); setChecked(false); setResult(null); setError(''); setBusy('')
    if (active) void window.donwells.projectToolsList(workspacePath).then(tools => {
      if (generation.current !== token) return
      setService(tools.find(tool => tool.id === 'code-graph') ?? null); setChecked(true)
    }).catch(error => { if (generation.current === token) { setError(String(error)); setChecked(true) } })
    return () => { generation.current++ }
  }, [workspacePath, active])
  const run = async (operation: 'index' | 'callers' | 'stop'): Promise<void> => {
    if (!active || (busy && operation !== 'stop')) return
    const token = ++generation.current
    setBusy(operation); setError(''); setResult(null)
    try {
      if (operation === 'stop') await window.donwells.projectToolStop(workspacePath, 'code-graph')
      else {
        const response = await window.donwells.projectToolCall(workspacePath, 'code-graph', operation, operation === 'callers' ? { function_name: query.trim() } : {})
        if (generation.current === token) setResult(graphResult(response))
      }
    } catch (error) { if (generation.current === token) setError(String(error)) }
    finally {
      if (generation.current === token) {
        setBusy('')
        try {
          const tools = await window.donwells.projectToolsList(workspacePath)
          if (generation.current === token) setService(tools.find(tool => tool.id === 'code-graph') ?? null)
        } catch (error) { if (generation.current === token) setError(String(error)) }
      }
    }
  }
  return <div className="project-graph" aria-label="Code graph">
    <p className="project-graph-help">Find direct callers using this checkout’s code index. Dynamic calls may be unresolved.</p>
    {!checked ? <p role="status">Checking graph tool…</p> : !service ? <p role="status">Code graph is not enabled for this app. Text search remains available.</p> : <>
      <div className="project-search-status"><span>Graph service: {service.status}</span><button disabled={busy === 'stop' || (!busy && service.status === 'stopped')} onClick={() => void run('stop')} title="Stops graph requests for this checkout">Stop graph</button></div>
      <div className="project-graph-actions"><button disabled={!!busy} onClick={() => void run('index')}>Rebuild code index</button></div>
      <form onSubmit={event => { event.preventDefault(); void run('callers') }}>
        <label htmlFor={inputId}>Function name</label>
        <div className="project-search-input"><input id={inputId} value={query} maxLength={128} disabled={!!busy} onChange={event => { const graphQuery = event.target.value; setResult(null); useAppStore.setState(state => ({ contentSearch: { ...state.contentSearch, graphQuery } })) }} placeholder="Function to inspect" /><button disabled={!!busy || !query.trim()}>Find callers</button></div>
      </form>
      {busy && <p role="status">{busy === 'index' ? 'Building code index…' : busy === 'stop' ? 'Stopping graph…' : 'Finding callers…'}</p>}
      {result && <>
        <p role="status">{result.indexed ? `Indexed${result.nodes === null ? '' : ` · ${result.nodes} nodes`}${result.partial ? ` · ${result.partial} partial parses` : ''}` : `${result.total} direct ${result.total === 1 ? 'caller' : 'callers'}`}{' · '}{result.freshness === 'current' ? 'Current when checked' : result.freshness === 'stale' ? 'Source changed — rebuild index' : 'Freshness unverified'}</p>
        <p className="project-graph-help">{result.indexedAt ? `Indexed ${new Date(result.indexedAt).toLocaleString()}. ` : ''}Freshness covers Git-visible files. Ignored files and external dependencies are not verified.</p>
        {result.callers.length > 0 && <ul aria-label="Caller matches">{result.callers.map((caller, index) => <li key={index}><code>{caller.name}</code><span>{caller.strategy === 'lsp' ? 'Language server' : caller.strategy}{caller.confidence === null ? '' : ` · ${Math.round(caller.confidence * 100)}% confidence`}</span><button onClick={() => useAppStore.setState(state => ({ contentSearch: { ...state.contentSearch, query: caller.name } }))}>Find in text</button></li>)}</ul>}
        {result.total > result.callers.length && !result.indexed && <p>Showing the first {result.callers.length} callers.</p>}
      </>}
      {service.detail && <p className="project-graph-help">{service.detail}</p>}
    </>}
    {error && <p role="alert" className="project-search-error">{error}</p>}
  </div>
}
