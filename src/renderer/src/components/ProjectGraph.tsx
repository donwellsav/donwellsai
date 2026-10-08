import { useEffect, useId, useRef, useState } from 'react'
import type { ToolServiceState } from '@shared/project-tools'
import { graphDefinitions, graphImports, graphResult, graphSource } from '../project-graph'
import { useAppStore } from '../store'

export function ProjectGraph({ workspacePath, active }: { workspacePath: string; active: boolean }) {
  const inputId = useId()
  const query = useAppStore(state => state.contentSearch.graphQuery ?? '')
  const [service, setService] = useState<ToolServiceState | null>(null)
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState<ReturnType<typeof graphResult> | null>(null)
  const [definitions, setDefinitions] = useState<ReturnType<typeof graphDefinitions> | null>(null)
  const [imports, setImports] = useState<ReturnType<typeof graphImports> | null>(null)
  const [selectedSymbol, setSelectedSymbol] = useState('')
  const generation = useRef(0)
  useEffect(() => {
    const token = ++generation.current
    setService(null); setChecked(false); setResult(null); setDefinitions(null); setImports(null); setSelectedSymbol(''); setError(''); setBusy('')
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
    if (operation !== 'callers') { setDefinitions(null); setImports(null); setSelectedSymbol('') }
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
  const findDefinitions = async (): Promise<void> => {
    if (!active || busy || !query.trim()) return
    const token = ++generation.current
    setBusy('definitions'); setError(''); setResult(null); setDefinitions(null); setImports(null); setSelectedSymbol('')
    try { const found = graphDefinitions(await window.donwells.projectToolCall(workspacePath, 'code-graph', 'definitions', { symbol: query.trim() })); if (generation.current === token) setDefinitions(found) }
    catch (error) { if (generation.current === token) setError(String(error)) }
    finally { if (generation.current === token) setBusy('') }
  }
  const findImports = async (qualifiedName: string): Promise<void> => {
    if (!active || busy) return
    const token = ++generation.current
    setBusy('imports'); setError(''); setImports(null); setSelectedSymbol(qualifiedName)
    try { const found = graphImports(await window.donwells.projectToolCall(workspacePath, 'code-graph', 'imports', { qualified_name: qualifiedName })); if (generation.current === token) setImports(found) }
    catch (error) { if (generation.current === token) setError(String(error)) }
    finally { if (generation.current === token) setBusy('') }
  }
  const openSource = async (qualifiedName: string): Promise<void> => {
    if (!active || busy) return
    const token = ++generation.current
    const current = () => generation.current === token && useAppStore.getState().activeWorktreePath === workspacePath
    setBusy('source'); setError('')
    try {
      const source = graphSource(await window.donwells.projectToolCall(workspacePath, 'code-graph', 'source', { qualified_name: qualifiedName }))
      const file = await window.donwells.readFile(workspacePath, source.path)
      if (!current()) return
      if (file.content.split('\n')[source.line - 1]?.replace(/\r$/, '') !== source.firstLine) throw new Error('Source changed before opening. Rebuild the code index and find this caller again.')
      if (!await useAppStore.getState().openPreview(workspacePath, source.path, { line: source.line, mode: 'edit' })) throw new Error('Could not open the caller source')
    } catch (error) { if (current()) setError(String(error)) }
    finally { if (current()) setBusy('') }
  }
  return <div className="project-graph" aria-label="Code graph">
    <p className="project-graph-help">Find definitions, direct callers, and imports of a definition’s file in this checkout. Parser coverage varies by language; dynamic calls may be unresolved. Syntax search supports other structural patterns.</p>
    {!checked ? <p role="status">Checking graph tool…</p> : !service ? <p role="status">Code graph is not enabled for this app. Text search remains available.</p> : <>
      <div className="project-search-status"><span>Graph service: {service.status}</span><button className="btn btn-secondary btn-sm" disabled={busy === 'stop' || (!busy && service.status === 'stopped')} onClick={() => void run('stop')} title="Stops graph requests for this checkout">Stop graph</button></div>
      <div><button className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => void run('index')}>Rebuild code index</button><button className="btn btn-secondary btn-sm" disabled={!!busy || !query.trim()} onClick={() => void findDefinitions()}>Find definitions</button></div>
      <form onSubmit={event => { event.preventDefault(); void run('callers') }}>
        <label htmlFor={inputId}>Function name</label>
        <div className="project-search-input"><input id={inputId} value={query} maxLength={128} disabled={!!busy} onChange={event => { const graphQuery = event.target.value; setResult(null); setDefinitions(null); setImports(null); setSelectedSymbol(''); useAppStore.setState(state => ({ contentSearch: { ...state.contentSearch, graphQuery } })) }} placeholder="Function to inspect" /><button className="btn btn-secondary btn-sm" disabled={!!busy || !query.trim()}>Find callers</button></div>
      </form>
      {busy && <p role="status">{busy === 'index' ? 'Building code index…' : busy === 'stop' ? 'Stopping graph…' : busy === 'source' ? 'Opening source…' : busy === 'definitions' ? 'Finding definitions…' : busy === 'imports' ? 'Finding imports…' : 'Finding callers…'}</p>}
      {result && <>
        <p role="status">{result.indexed ? `Indexed${result.nodes === null ? '' : ` · ${result.nodes} nodes`}${result.partial ? ` · ${result.partial} partial parses` : ''}` : `${result.total} direct ${result.total === 1 ? 'caller' : 'callers'}`}{' · '}{result.freshness === 'current' ? 'Current when checked' : result.freshness === 'stale' ? 'Source changed — rebuild index' : 'Freshness unverified'}</p>
        <p className="project-graph-help">{result.indexedAt ? `Indexed ${new Date(result.indexedAt).toLocaleString()}. ` : ''}Freshness covers Git-visible files. Ignored files and external dependencies are not verified.</p>
        {result.callers.length > 0 && <ul aria-label="Caller matches">{result.callers.map((caller, index) => <li key={index}><code title={caller.qualifiedName ?? caller.name}>{caller.name}</code><span>{caller.strategy === 'lsp' ? 'Language server' : caller.strategy}{caller.confidence === null ? '' : ` · ${Math.round(caller.confidence * 100)}% confidence`}</span>{caller.qualifiedName && <button className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => void openSource(caller.qualifiedName!)}>Open source</button>}<button className="btn btn-secondary btn-sm" onClick={() => useAppStore.setState(state => ({ contentSearch: { ...state.contentSearch, query: caller.name } }))}>Find in text</button></li>)}</ul>}
        {result.total > result.callers.length && !result.indexed && <p>Showing the first {result.callers.length} callers.</p>}
      </>}
      {definitions && <><p role="status">{definitions.definitions.length} exact {definitions.definitions.length === 1 ? 'definition' : 'definitions'} · {definitions.freshness === 'current' ? 'Current when checked' : definitions.freshness === 'stale' ? 'Source changed — rebuild index' : 'Freshness unverified'}</p>{definitions.definitions.length > 1 && <p className="project-graph-help">Choose the exact qualified definition before inspecting imports.</p>}<ul aria-label="Definition matches">{definitions.definitions.map(definition => <li key={definition.qualifiedName}><code title={definition.qualifiedName}>{definition.name}</code><span>{definition.label} · {definition.path}:{definition.line}</span><button className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => void openSource(definition.qualifiedName)}>Open source</button><button className="btn btn-secondary btn-sm" disabled={!!busy} aria-pressed={selectedSymbol === definition.qualifiedName} onClick={() => void findImports(definition.qualifiedName)}>Find imports</button></li>)}</ul></>}
      {imports && <><p role="status">{imports.imports.length} static {imports.imports.length === 1 ? 'import' : 'imports'} · {imports.freshness === 'current' ? 'Current when checked' : imports.freshness === 'stale' ? 'Source changed — rebuild index' : 'Freshness unverified'}</p><ul aria-label="Import matches">{imports.imports.map(name => <li key={name}><code title={name}>{name.split('.').at(-1)}</code><button className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => void openSource(name)}>Open source</button></li>)}</ul></>}
      {service.detail && <p className="project-graph-help">{service.detail}</p>}
    </>}
    {error && <p role="alert" className="project-search-error">{error}</p>}
  </div>
}
