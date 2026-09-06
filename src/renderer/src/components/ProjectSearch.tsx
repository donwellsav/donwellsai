import { useEffect, useId, useRef, useState } from 'react'
import type { ProjectSearchHit } from '@shared/project-tools'
import { useAppStore } from '../store'
import './project-search.css'
import { ProjectGraph } from './ProjectGraph'

export function ProjectSearch({ workspacePath, active = true }: { workspacePath: string; active?: boolean }) {
  const inputId = useId()
  const graphOpen = useAppStore(state => state.contentSearch.graphOpen ?? false)
  const { query, hidden, ignored } = useAppStore(state => state.contentSearch)
  const setSearch = (patch: Partial<{ query: string; hidden: boolean; ignored: boolean }>): void => {
    useAppStore.setState(state => ({ contentSearch: { ...state.contentSearch, ...patch } }))
  }
  const [hits, setHits] = useState<ProjectSearchHit[]>([])
  const [status, setStatus] = useState('Search the text in this checkout.')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const current = useRef<{ id: string; path: string } | null>(null)
  const stop = (): void => {
    const request = current.current
    current.current = null
    if (request) void window.donwells.cancelWorkspaceContentSearch(request.id).catch(() => {})
    setRunning(false)
  }
  useEffect(() => window.donwells.on('project-search:hit', event => {
    if (current.current?.id === event.requestId && current.current.path === event.workspacePath) setHits(previous => [...previous, event.hit])
  }), [])
  useEffect(() => {
    setHits([]); setError('')
    if (!active) { setRunning(false); return }
    if (!query.trim()) { setRunning(false); setStatus('Search the text in this checkout.'); return }
    setRunning(true); setStatus('Searching…')
    const id = crypto.randomUUID()
    current.current = { id, path: workspacePath }
    const timer = setTimeout(() => {
      if (current.current?.id !== id) return
      void window.donwells.searchWorkspaceContent(workspacePath, id, { query, showHidden: hidden, includeIgnored: ignored }).then(result => {
        if (current.current?.id !== id) return
        setHits(result.hits); setRunning(false)
        setStatus(`${result.hits.length} ${result.hits.length === 1 ? 'match' : 'matches'}${result.truncated ? ' · limit reached; narrow your search' : ''}${result.skipped ? ` · ${result.skipped} unsupported or unsafe matches skipped` : ''}`)
      }).catch(error => {
        if (current.current?.id !== id) return
        setRunning(false); setError(String(error)); setStatus('Search failed')
      })
    }, 200)
    return () => {
      clearTimeout(timer)
      if (current.current?.id === id) current.current = null
      void window.donwells.cancelWorkspaceContentSearch(id).catch(() => {})
    }
  }, [workspacePath, query, hidden, ignored, refresh, active])
  const open = async (hit: ProjectSearchHit): Promise<void> => {
    if (!hit.path || !hit.line) return
    setError('')
    try {
      // Revalidate even when the editor already has a cached or unsaved model.
      const source = await window.donwells.readFile(workspacePath, hit.path)
      if (useAppStore.getState().activeWorktreePath !== workspacePath) return
      const lines = source.content.split('\n')
      if (source.truncated && hit.line > lines.length) throw new Error('This match is beyond the editor preview. Open the complete file externally.')
      const changed = lines[hit.line - 1]?.replace(/\r$/, '').slice(0, 4096) !== hit.excerpt
      const opened = await useAppStore.getState().openPreview(workspacePath, hit.path, { line: hit.line, mode: 'edit' })
      if (!opened) throw new Error('Could not open the source file')
      if (changed) setStatus('Source changed since search. Refresh to find its current line.')
    } catch (error) { setError(String(error)) }
  }
  return <section className="project-search" aria-label="Search file contents">
    <details className="project-graph-disclosure" open={graphOpen} onToggle={event => { const open = event.currentTarget.open; useAppStore.setState(state => ({ contentSearch: { ...state.contentSearch, graphOpen: open } })) }}><summary>Code graph · callers</summary><ProjectGraph key={workspacePath} workspacePath={workspacePath} active={active && graphOpen} /></details>
    <form onSubmit={event => { event.preventDefault(); stop(); setRefresh(value => value + 1) }}>
      <label htmlFor={inputId}>Search text</label>
      <div className="project-search-input"><input id={inputId} type="search" value={query} maxLength={1000} placeholder="A phrase, function or setting" onChange={event => { stop(); setSearch({ query: event.target.value }) }} /><button type="submit" disabled={!query.trim()}>Search</button></div>
      <div className="project-search-options"><label><input type="checkbox" checked={hidden} onChange={event => { stop(); setSearch({ hidden: event.target.checked }) }} />Hidden files</label><label><input type="checkbox" checked={ignored} onChange={event => { stop(); setSearch({ ignored: event.target.checked }) }} />Ignored files</label></div>
    </form>
    <div className="project-search-status"><span role="status">{status}</span>{running && <button onClick={() => { stop(); setStatus('Stopped · results received so far') }}>Stop</button>}</div>
    {error && <p className="project-search-error" role="alert">{error}</p>}
    <ol className="project-search-results" aria-label="Content matches">{hits.map(hit => <li key={hit.id}><button onClick={() => void open(hit)} title={`${hit.path}:${hit.line}`}><span className="project-search-path">{hit.path}<b>:{hit.line}</b></span><code>{hit.excerpt}</code></button></li>)}</ol>
  </section>
}
