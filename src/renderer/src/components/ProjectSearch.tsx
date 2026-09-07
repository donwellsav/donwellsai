import { useEffect, useId, useRef, useState } from 'react'
import type { ProjectSearchHit } from '@shared/project-tools'
import { useAppStore } from '../store'
import './project-search.css'
import { ProjectGraph } from './ProjectGraph'
import { isObject } from '@shared/command-catalog'
import { openProjectMemoryEditor, useProjectMemoryEditor } from '../project-memory-editor'
import { focusRetainedAgentSession } from '../navigation-controller'
import type { AgentExecutable } from '@shared/agent-runtime'
import { ModalDialog } from './ModalDialog'
import { ProjectAnalytics } from './ProjectAnalytics'

const sources = { all: 'All', file: 'Files', code: 'Code', document: 'Documents', memory: 'Memory', session: 'Sessions' } as const
type SearchSource = keyof typeof sources
function documentValue(response: unknown): Record<string, unknown> {
  if (!isObject(response)) throw new Error('Invalid document response')
  const text = Array.isArray(response.content) ? response.content.filter(item => isObject(item) && item.type === 'text').map(item => item.text).join('\n') : ''
  if (response.isError) throw new Error(text || 'Document request failed')
  const value: unknown = response.structuredContent ?? JSON.parse(text)
  if (!isObject(value)) throw new Error('Invalid document result')
  return value
}

export function ProjectSearch({ workspacePath, active = true }: { workspacePath: string; active?: boolean }) {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!active) return
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [active, workspacePath])
  const graphOpen = useAppStore(state => state.contentSearch.graphOpen ?? false)
  const { query, hidden, ignored } = useAppStore(state => state.contentSearch)
  const setSearch = (patch: Partial<{ query: string; hidden: boolean; ignored: boolean }>): void => {
    useAppStore.setState(state => ({ contentSearch: { ...state.contentSearch, ...patch } }))
  }
  const source = useAppStore(state => state.contentSearch.source ?? 'all')
  const setSource = (source: SearchSource) => useAppStore.setState(state => ({ contentSearch: { ...state.contentSearch, source } }))
  const [indexing, setIndexing] = useState(false)
  const [documentPaused, setDocumentPaused] = useState(false)
  const [documentStatus, setDocumentStatus] = useState('')
  const [historyIndexing, setHistoryIndexing] = useState(false)
  const settingsOpen = useAppStore(state => state.settingsOpen)
  const [historySetup, setHistorySetup] = useState<{ path: string; enabled: boolean } | null>(null)
  const historyAvailable = historySetup?.path === workspacePath ? historySetup.enabled : null
  useEffect(() => {
    if (!active || settingsOpen) return
    let cancelled = false
    setHistorySetup(null)
    void window.donwells.projectDoctorInspect(workspacePath).then(report => {
      if (!cancelled) setHistorySetup({ path: workspacePath, enabled: report.configurationValid && Boolean(report.configuration.historyBinary) && !report.configuration.disabled.includes('history') })
    }).catch(() => { if (!cancelled) setHistorySetup({ path: workspacePath, enabled: false }) })
    return () => { cancelled = true }
  }, [workspacePath, active, settingsOpen])
  const [visible, setVisible] = useState(25)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [historyCapabilities, setHistoryCapabilities] = useState<Record<string, string>>({})
  const [document, setDocument] = useState<{ title: string; content: string; detail: string; resume?: AgentExecutable | null; historyId?: string; previousOrdinal?: number | null; nextOrdinal?: number | null; sourceRef?: string } | null>(null)
  const documentQueue = useRef(Promise.resolve())
  const openGeneration = useRef(0)
  useEffect(() => { openGeneration.current++; return () => { openGeneration.current++ } }, [workspacePath, active])
  const resultsRef = useRef<HTMLOListElement>(null)
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
    setHits([]); setError(''); setNotes(source === 'all' || source === 'session' ? { session: 'Session history is read-only. Index only the selected native session roots.' } : {}); setVisible(25); setDocument(null); setHistoryCapabilities({})
    if (!active) { setRunning(false); return }
    if (!query.trim()) { setRunning(false); setStatus('Search the text in this checkout.'); return }
    setRunning(true); setStatus('Searching…')
    const id = crypto.randomUUID()
    current.current = { id, path: workspacePath }
    const timer = setTimeout(() => {
      if (current.current?.id !== id) return
      const live = () => current.current?.id === id
      const accept = (kind: ProjectSearchHit['source'], values: ProjectSearchHit[], note: string) => {
        if (!live()) return
        setHits(previous => [...previous.filter(hit => hit.source !== kind), ...values])
        setNotes(previous => ({ ...previous, [kind]: note }))
      }
      const tasks: Promise<void>[] = []
      const run = (kind: ProjectSearchHit['source'], action: () => Promise<void>) => {
        if (source !== 'all' && source !== kind) return
        tasks.push(action().catch(error => { if (live()) setNotes(previous => ({ ...previous, [kind]: String(error) })) }))
      }
      run('code', async () => {
        const result = await window.donwells.searchWorkspaceContent(workspacePath, id, { query, showHidden: hidden, includeIgnored: ignored })
        accept('code', result.hits, `${result.hits.length} text matches${result.truncated ? ' · limit reached; narrow your search' : ''}${result.skipped ? ` · ${result.skipped} unsupported matches skipped` : ''}`)
      })
      run('file', async () => {
        if (query.length > 256) throw new Error('File names: use at most 256 characters')
        const result = await window.donwells.searchWorkspaceFiles(workspacePath, { query, showHidden: hidden, includeIgnored: ignored, maxResults: 100 })
        accept('file', result.matches.map(({ entry }) => ({ source: 'file', id: `file:${entry.path}`, title: entry.name, excerpt: 'File name match', path: entry.path, line: null, revision: null, indexedAt: null, stale: false })), `${result.matches.length} file names${result.truncated ? ' · limit reached; narrow your search' : ''}`)
      })
      run('memory', async () => {
        if (query.length > 512) throw new Error('Memory: use at most 512 characters')
        const result = await window.donwells.projectMemoryList({ workspacePath, query, limit: 200 })
        accept('memory', result.entries.map(entry => ({ source: 'memory', id: entry.id, title: entry.title, excerpt: `${entry.kind} · ${entry.provenance.harness}\n${entry.content.slice(0, 300)}`, path: null, line: null, revision: String(entry.revision), indexedAt: entry.updatedAt, stale: false })), `${result.entries.length} of ${result.total} memories${result.hasMore ? ' · narrow your search' : ''}`)
      })
      run('session', async () => {
        if (!historyAvailable) { accept('session', [], historyAvailable === null ? 'Checking session history setup…' : 'Session history unavailable: configure and enable it in Project tools'); return }
        const result = await window.donwells.projectSessionHistorySearch(workspacePath, query, id)
        accept('session', result.hits, `${result.hits.length} session messages${result.truncated ? ' · limit reached; narrow your search' : ''}`)
        if (live()) setHistoryCapabilities(result.capabilities)
      })
      run('document', async () => {
        const tools = await window.donwells.projectToolsList(workspacePath)
        if (!live()) return
        const tool = tools.find(tool => tool.id === 'documents')
        if (!tool) { accept('document', [], 'Documents unavailable · configure the document engine'); return }
        if (tool.status !== 'ready') { accept('document', [], `Documents ${tool.status} · use Index documents to start`); return }
        // One search per panel in flight; obsolete queued queries never reach the shared model service.
        const pending = documentQueue.current.catch(() => {}).then(async () => {
          if (!live()) return
          const value = documentValue(await window.donwells.projectToolCall(workspacePath, 'documents', 'query', { query }))
          if (!Array.isArray(value.hits) || value.hits.some(hit => !isObject(hit) || hit.source !== 'document' || typeof hit.id !== 'string' || typeof hit.path !== 'string' || typeof hit.title !== 'string' || typeof hit.excerpt !== 'string' || !Number.isSafeInteger(hit.line) || Number(hit.line) < 1 || typeof hit.revision !== 'string' || typeof hit.indexedAt !== 'string' || typeof hit.stale !== 'boolean')) throw new Error('Invalid document matches')
          accept('document', value.hits as ProjectSearchHit[], `${value.hits.length} documents · ${String(value.mode)}${value.modelError ? ' · semantic model unavailable' : ''}`)
        })
        documentQueue.current = pending
        await pending
      })
      void Promise.all(tasks).then(() => { if (live()) { setRunning(false); setStatus('Search complete') } })
    }, 200)
    return () => {
      clearTimeout(timer)
      if (current.current?.id === id) current.current = null
      void window.donwells.cancelWorkspaceContentSearch(id).catch(() => {})
      if (historyAvailable) void window.donwells.projectSessionHistorySearchCancel(workspacePath, id).catch(() => {})
    }
  }, [workspacePath, query, hidden, ignored, refresh, active, source, historyAvailable])
  useEffect(() => {
    if (!active || (source !== 'all' && source !== 'document')) return
    setIndexing(false); setDocumentPaused(false); setDocumentStatus('')
    let lastFinishedJob: unknown
    let cancelled = false, timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const tools = await window.donwells.projectToolsList(workspacePath)
        if (cancelled) return
        if (tools.find(tool => tool.id === 'documents')?.status !== 'ready') { setIndexing(false); setDocumentPaused(false); timer = setTimeout(() => void poll(), 2000); return }
        const value = documentValue(await window.donwells.projectToolCall(workspacePath, 'documents', 'progress', {}))
        if (cancelled) return
        setIndexing(['reading', 'indexing', 'paused', 'pausing', 'publishing', 'cancelling'].includes(String(value.phase)))
        setDocumentPaused(value.phase === 'paused' || value.phase === 'pausing')
        setDocumentStatus(`Document index: ${String(value.phase)} · ${Number(value.completed)} / ${Number(value.total)} · ${Math.round(Number(value.modelBytes) / 1048576)} MiB models · publication ${String(value.publicationState ?? 'unknown')}${isObject(value.publication) ? ` · ${Number(value.publication.reusedChunks)} reused chunks · ${Number(value.publication.embeddedChunks)} embedded · table version ${Number(value.publication.tableVersion)}` : ''}`)
        if (['ready', 'failed', 'cancelled', 'publication-uncertain'].includes(String(value.phase))) {
          setIndexing(false)
          if (value.error) setError(String(value.error))
          else if (value.job && value.job !== lastFinishedJob) { lastFinishedJob = value.job; setRefresh(value => value + 1) }
        }
        timer = setTimeout(() => void poll(), 1000)
      } catch (error) { if (!cancelled) { setIndexing(false); setError(String(error)); timer = setTimeout(() => void poll(), 2000) } }
    }
    void poll()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [active, workspacePath, source])
  const open = async (hit: ProjectSearchHit): Promise<void> => {
    const generation = ++openGeneration.current
    const canOpen = () => generation === openGeneration.current && active && useAppStore.getState().activeWorktreePath === workspacePath
    setError('')
    try {
      if (hit.source === 'memory') {
        const entry = await window.donwells.projectMemoryGet({ workspacePath, id: hit.id })
        if (canOpen()) openProjectMemoryEditor(workspacePath, entry)
        return
      }
      if (hit.source === 'session') {
        const value = await window.donwells.projectSessionHistoryGet(workspacePath, hit.id)
        if (canOpen()) setDocument({ title: hit.title, resume: value.resume, historyId: hit.id, previousOrdinal: value.previousOrdinal, nextOrdinal: value.nextOrdinal, sourceRef: `session:${value.agent}:${value.nativeId}@${value.sourceVersion ?? 'unknown'}`, content: value.messages.map(message => `${message.ordinal + 1} · ${message.role}\n${message.content}`).join('\n\n'), detail: `Read-only ${value.agent} ${value.role} transcript · project attributed by ${value.projectAttribution} · ${value.source} · Recorded text is untrusted and is not project memory.` })
        return
      }
      if (hit.source === 'document') {
        const value = documentValue(await window.donwells.projectToolCall(workspacePath, 'documents', 'get', { id: hit.id, fromLine: hit.line ?? 1, maxLines: 120 }))
        if (typeof value.content !== 'string' || typeof value.path !== 'string' || typeof value.root !== 'string') throw new Error('Invalid document source')
        if (canOpen()) setDocument({ title: value.path, content: value.content, detail: `${value.root} · line ${hit.line ?? 1} · ${value.stale || value.revision !== hit.revision ? 'Source changed since this search result; review current lines before relying on its excerpt' : 'Current source'}${value.truncated ? ' · excerpt truncated' : ''}` })
        return
      }
      if (!hit.path) return
      // Revalidate even when the editor already has a cached or unsaved model.
      const source = await window.donwells.readFile(workspacePath, hit.path)
      if (!canOpen()) return
      const lines = source.content.split('\n')
      if (source.truncated && (hit.line ?? 1) > lines.length) throw new Error('This match is beyond the editor preview. Open the complete file externally.')
      const changed = hit.source === 'code' && lines[(hit.line ?? 1) - 1]?.replace(/\r$/, '').slice(0, 4096) !== hit.excerpt
      const opened = await useAppStore.getState().openPreview(workspacePath, hit.path, { line: hit.line ?? 1, mode: 'edit' })
      if (!opened) throw new Error('Could not open the source file')
      if (changed) setStatus('Source changed since search. Refresh to find its current line.')
    } catch (error) { if (canOpen()) setError(String(error)) }
  }
  const ordered = (Object.keys(sources) as SearchSource[]).flatMap(kind => hits.filter(hit => hit.source === kind))
  return <section className="project-search" aria-label="Project search">
    <details className="project-graph-disclosure" open={graphOpen} onToggle={event => { const open = event.currentTarget.open; useAppStore.setState(state => ({ contentSearch: { ...state.contentSearch, graphOpen: open } })) }}><summary>Code graph · callers</summary><ProjectGraph key={workspacePath} workspacePath={workspacePath} active={active && graphOpen} /></details>
    <form onSubmit={event => { event.preventDefault(); stop(); setRefresh(value => value + 1) }}>
      <div className="project-search-sources" role="group" aria-label="Search sources">{(Object.entries(sources) as [SearchSource, string][]).map(([kind, label]) => <button key={kind} type="button" aria-pressed={source === kind} onClick={() => { if (source !== kind) { stop(); setSource(kind) } }}>{label}</button>)}</div>
      <label htmlFor={inputId}>Search text</label>
      <div className="project-search-input"><input ref={inputRef} id={inputId} type="search" value={query} maxLength={1000} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); resultsRef.current?.querySelector<HTMLButtonElement>('button')?.focus() } }} placeholder="A phrase, function or setting" onChange={event => { stop(); setSearch({ query: event.target.value }) }} /><button type="submit" disabled={!query.trim()}>Search</button></div>
      {(source === 'all' || source === 'file' || source === 'code') && <div className="project-search-options"><label><input type="checkbox" checked={hidden} onChange={event => { stop(); setSearch({ hidden: event.target.checked }) }} />Hidden files</label><label><input type="checkbox" checked={ignored} onChange={event => { stop(); setSearch({ ignored: event.target.checked }) }} />Ignored files</label></div>}
    </form>
    <div className="project-search-status"><span role="status">{status}</span>{running && <button onClick={() => { stop(); setStatus('Stopped · results received so far') }}>Stop</button>}</div>
    <div className="project-search-notes">{Object.entries(notes).map(([kind, note]) => <p key={kind}>{note}</p>)}</div>
    {documentStatus && (source === 'all' || source === 'document') && <p role="status">{documentStatus}</p>}
    {(source === 'all' || source === 'document') && <button className="btn btn-secondary btn-sm" type="button" disabled={indexing} onClick={() => {
      const path = workspacePath
      void window.donwells.projectToolCall(path, 'documents', 'index', {}).then(response => {
        const value = documentValue(response)
        if (useAppStore.getState().activeWorktreePath === path) { setDocumentStatus(`Document index: ${String(value.phase)}`); setIndexing(true) }
      }).catch(error => { if (useAppStore.getState().activeWorktreePath === path) setError(String(error)) })
    }}>{hits.some(hit => hit.source === 'document' && hit.stale) ? 'Reindex changed document sources' : 'Index documents'}</button>}
    {indexing && <button className="btn btn-secondary btn-sm" type="button" onClick={() => {
      const path = workspacePath
      void window.donwells.projectToolCall(path, 'documents', 'cancel', {}).then(response => {
        if (useAppStore.getState().activeWorktreePath !== path) return
        const value = documentValue(response)
        setDocumentStatus(`Document index: ${String(value.phase)} · previous snapshot remains available`)
      }).catch(error => setError(String(error)))
    }}>Cancel rebuild</button>}
    {indexing && <button className="btn btn-secondary btn-sm" type="button" onClick={() => {
      const path = workspacePath
      void window.donwells.projectToolCall(path, 'documents', documentPaused ? 'resume' : 'pause', {}).then(response => {
        if (useAppStore.getState().activeWorktreePath !== path) return
        const value = documentValue(response)
        setDocumentPaused(value.phase === 'paused' || value.phase === 'pausing')
        setDocumentStatus(`Document index: ${String(value.phase)} · models remain loaded`)
      }).catch(error => setError(String(error)))
    }}>{documentPaused ? 'Resume document indexing' : 'Pause document indexing'}</button>}
    {(source === 'all' || source === 'document') && <button className="btn btn-secondary btn-sm" type="button" onClick={() => {
      const path = workspacePath
      void window.donwells.projectToolStop(path, 'documents').then(() => {
        if (useAppStore.getState().activeWorktreePath !== path) return
        setIndexing(false); setDocumentPaused(false); setDocumentStatus('Document service stopped · models released · reopen to inspect the last committed snapshot')
      }).catch(error => setError(String(error)))
    }}>Stop document service</button>}
    {Object.keys(historyCapabilities).length > 0 && <details><summary>Native history support</summary>{Object.entries(historyCapabilities).map(([agent, detail]) => <p key={agent}>{agent}: {detail}</p>)}</details>}
    {(source === 'all' || source === 'session') && !historyAvailable && <button type="button" disabled={historyAvailable === null} onClick={() => useAppStore.getState().openSettings('agents')}>Configure session history</button>}
    {(source === 'all' || source === 'session') && historyAvailable && <button type="button" disabled={historyIndexing} onClick={() => {
      const generation = openGeneration.current
      setHistoryIndexing(true)
      void window.donwells.projectSessionHistoryIndex(workspacePath).then(() => {
        if (generation === openGeneration.current) setRefresh(value => value + 1)
      }).catch(error => { if (generation === openGeneration.current) setError(String(error)) }).finally(() => setHistoryIndexing(false))
    }}>{historyIndexing ? 'Indexing selected sessions…' : 'Index sessions'}</button>}
    {active && source === 'session' && historyAvailable && <ProjectAnalytics key={workspacePath} workspacePath={workspacePath} />}
    {error && <p className="project-search-error" role="alert">{error}</p>}
    <ol ref={resultsRef} className="project-search-results" aria-label="Content matches" onKeyDown={event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
      const index = buttons.indexOf(event.target as HTMLButtonElement)
      if (index < 0) return
      event.preventDefault()
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
    }}>{ordered.slice(0, visible).map(hit => <li key={`${hit.source}:${hit.id}`}><button onClick={() => void open(hit)} title={`${hit.path ?? hit.title}${hit.line ? `:${hit.line}` : ''}`}><span className="project-search-path">{hit.path ?? hit.title}{hit.line && <b>:{hit.line}</b>}</span><span className="project-search-kind">{sources[hit.source]}{hit.revision ? ` · revision ${hit.revision.slice(0, 12)}` : ''}{hit.stale ? ' · source changed' : ''}{hit.indexedAt ? ` · ${new Date(hit.indexedAt).toLocaleString()}` : ''}</span><code>{hit.excerpt}</code></button></li>)}</ol>
    {ordered.length > visible && <button onClick={() => setVisible(value => value + 25)}>Show more · {visible} of {ordered.length}</button>}
    {document && <ModalDialog labelledBy={`${inputId}-source`} onClose={() => setDocument(null)}><h2 id={`${inputId}-source`}>{document.title}</h2><p>{document.detail}</p><pre className="project-search-document">{document.content}</pre>{document.historyId && document.previousOrdinal !== undefined && <>{document.previousOrdinal !== null && <button type="button" onClick={() => {
      const selected = document, generation = openGeneration.current
      void window.donwells.projectSessionHistoryGet(workspacePath, selected.historyId!, { fromOrdinal: selected.previousOrdinal!, limit: 5 }).then(value => {
        if (generation !== openGeneration.current || useAppStore.getState().activeWorktreePath !== workspacePath) return
        setDocument({ ...selected, previousOrdinal: value.previousOrdinal, nextOrdinal: value.nextOrdinal, content: value.messages.map(message => `${message.ordinal + 1} · ${message.role}\n${message.content}`).join('\n\n') })
      }).catch(error => setError(String(error)))
    }}>Earlier messages</button>}{document.nextOrdinal !== null && <button type="button" onClick={() => {
      const selected = document, generation = openGeneration.current
      void window.donwells.projectSessionHistoryGet(workspacePath, selected.historyId!, { fromOrdinal: selected.nextOrdinal!, limit: 5 }).then(value => {
        if (generation !== openGeneration.current || useAppStore.getState().activeWorktreePath !== workspacePath) return
        setDocument({ ...selected, previousOrdinal: value.previousOrdinal, nextOrdinal: value.nextOrdinal, content: value.messages.map(message => `${message.ordinal + 1} · ${message.role}\n${message.content}`).join('\n\n') })
      }).catch(error => setError(String(error)))
    }}>Later messages</button>}<button type="button" onClick={() => {
      const selected = document
      if (useProjectMemoryEditor.getState().editor) { setError('Save or discard the open project memory draft before reviewing this transcript.'); return }
      openProjectMemoryEditor(workspacePath)
      useProjectMemoryEditor.getState().change({ title: selected.title.slice(0, 200), content: selected.content, sourceRef: selected.sourceRef ?? '' })
      setDocument(null)
    }}>Review as project memory</button></>}{document.resume && <button type="button" onClick={() => {
      const id = document.historyId!
      setDocument(null)
      void window.donwells.projectSessionHistoryGet(workspacePath, id).then(async current => {
        if (!current.resume || useAppStore.getState().activeWorktreePath !== workspacePath) return
        const result = await window.donwells.agentStart(workspacePath, current.resume)
        if (useAppStore.getState().activeWorktreePath === workspacePath) await focusRetainedAgentSession(result.run.sessionId)
      }).catch(error => setError(String(error)))
    }}>Open native conversation</button>}<button onClick={() => setDocument(null)}>Close source</button></ModalDialog>}
  </section>
}
