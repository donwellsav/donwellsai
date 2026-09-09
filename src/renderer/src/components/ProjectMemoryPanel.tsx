import { ProjectTemporalKnowledgePanel } from './ProjectTemporalKnowledgePanel'
import { ProjectKnowledgePanel } from './ProjectKnowledgePanel'
import { ProjectHandoffPanel } from './ProjectHandoffPanel'
import { useEffect, useState } from 'react'
import { PROJECT_MEMORY_KINDS, PROJECT_MEMORY_MAX_QUERY_LENGTH } from '@shared/project-memory'
import type { ProjectMemoryListResult } from '@shared/project-memory'
import { openProjectMemoryEditor, useProjectMemoryEditor } from '../project-memory-editor'
import { ProjectMemoryConnection } from './ProjectMemoryConnection'
import { Icon } from './Icon'
import './project-memory.css'

export function ProjectMemoryPanel({ workspacePath }: { workspacePath: string }) {
  const [offset, setOffset] = useState(0)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [result, setResult] = useState<ProjectMemoryListResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const generation = useProjectMemoryEditor((state) => state.generation)
  const refresh = useProjectMemoryEditor((state) => state.refresh)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setResult(null)
    const timer = window.setTimeout(() => {
      const selectedKind = PROJECT_MEMORY_KINDS.find((value) => value === kind)
      void window.donwells.projectMemoryList({ workspacePath, ...(query.trim() ? { query: query.trim() } : {}), includeArchived, limit: 100, offset, ...(selectedKind ? { kinds: [selectedKind] } : {}) }).then((value) => {
        if (!cancelled) { if (offset > 0 && offset >= value.total) { setOffset(Math.max(0, Math.floor((value.total - 1) / 100) * 100)); return }; setResult(value); setLoading(false) }
      }, (cause) => { if (!cancelled) { setError(String(cause)); setLoading(false) } })
    }, query ? 120 : 0)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [workspacePath, query, kind, includeArchived, generation, offset])

  return (
    <section className="project-memory-panel" aria-label="Project memory">
      <div className="memory-panel-actions">
        <label className="memory-search"><span className="sr-only">Search project memory</span><input className="input" aria-label="Search project memory" value={query} maxLength={PROJECT_MEMORY_MAX_QUERY_LENGTH} onChange={(event) => { setOffset(0); setQuery(event.target.value) }} placeholder="Search memories…" /></label>
        <button type="button" className="icon-btn" aria-label="New memory" title="Add a project note, decision, or convention for future agent sessions" onClick={() => openProjectMemoryEditor(workspacePath)}><Icon name="plus" size={14} /></button>
      </div>
      <details className="memory-filter-options"><summary title="Filter by memory kind, include archived entries, or refresh the list">Filters{kind !== 'all' || includeArchived ? ` · ${kind !== 'all' ? kind : 'all kinds'}${includeArchived ? ', archived' : ''}` : ''}</summary><div className="memory-panel-filters">
        <select className="input" aria-label="Filter memory kind" title="Show only the selected kind of project memory" value={kind} onChange={(event) => { setOffset(0); setKind(event.target.value) }}><option value="all">All kinds</option>{PROJECT_MEMORY_KINDS.map((value) => <option key={value} value={value}>{value}</option>)}</select>
        <label><input type="checkbox" checked={includeArchived} onChange={(event) => { setOffset(0); setIncludeArchived(event.target.checked) }} /> Archived</label>
        <button type="button" className="icon-btn" title="Refresh project memory" aria-label="Refresh project memory" disabled={loading} onClick={() => { setOffset(0); refresh() }}><Icon name="refresh" size={13} /></button>
      </div></details>
      {(loading || !!result?.total) && <div className="memory-list-caption" role="status">{loading ? 'Searching…' : result ? `${offset + 1}–${offset + result.entries.length} of ${result.total} matching entries` : ''}</div>}
      {error && <div className="memory-error" role="alert">{error}<button className="btn btn-secondary btn-sm" onClick={() => { setOffset(0); refresh() }}>Retry</button></div>}
      {(offset > 0 || result?.hasMore) && <nav aria-label="Memory pages"><button className="btn btn-secondary btn-sm" disabled={loading || offset === 0} onClick={() => setOffset(value => Math.max(0, value - 100))}>Previous</button><button className="btn btn-secondary btn-sm" disabled={loading || !result?.hasMore} onClick={() => setOffset(value => value + 100)}>Next</button></nav>}
      <div className="memory-entry-list" aria-busy={loading}>
        {result?.entries.map((entry) => <button type="button" className={`memory-entry-row${entry.archivedAt ? ' archived' : ''}`} key={entry.id} onClick={() => openProjectMemoryEditor(workspacePath, entry)}>
          <span className="memory-entry-meta"><span>{entry.kind}</span><span>r{entry.revision}{entry.archivedAt ? ' · archived' : ''}</span></span>
          <strong>{entry.title}</strong>
          <span className="memory-entry-excerpt">{entry.content.slice(0, 220)}</span>
          <span className="memory-entry-source">{entry.provenance.harness}{entry.tags.length ? ` · ${entry.tags.join(' · ')}` : ''}</span>
        </button>)}
        {!loading && !error && result?.total === 0 && <div className="memory-empty">
          <strong>{query || kind !== 'all' || includeArchived ? 'No matching project knowledge' : 'Leave context for the next coding session'}</strong>
          <p>{query || kind !== 'all' || includeArchived ? 'Try clearing the current search and filters.' : 'Keep build commands, architectural decisions, verified constraints, and recurring gotchas here.'}</p>
          {query || kind !== 'all' || includeArchived
            ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setQuery(''); setKind('all'); setIncludeArchived(false) }}>Clear filters</button>
            : null}
        </div>}
      </div>
      {connecting && <ProjectMemoryConnection workspacePath={workspacePath} onClose={() => setConnecting(false)} />}
      <ProjectHandoffPanel key={workspacePath} workspacePath={workspacePath} />
      <details className="memory-tools"><summary title="Connect agents and manage knowledge integrations">Memory integrations</summary>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConnecting(true)}>Connect agent</button>
      <ProjectKnowledgePanel key={workspacePath + ":knowledge"} workspacePath={workspacePath} />
      <ProjectTemporalKnowledgePanel key={workspacePath + ":temporal"} workspacePath={workspacePath} />
      </details>
    </section>
  )
}
