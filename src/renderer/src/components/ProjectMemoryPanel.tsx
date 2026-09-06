import { useEffect, useState } from 'react'
import { PROJECT_MEMORY_KINDS, PROJECT_MEMORY_MAX_QUERY_LENGTH } from '@shared/project-memory'
import type { ProjectMemoryListResult } from '@shared/project-memory'
import { openProjectMemoryEditor, useProjectMemoryEditor } from '../project-memory-editor'
import { pathBasename } from '../workspace-navigation'
import { ProjectMemoryConnection } from './ProjectMemoryConnection'
import { ProjectMemoryStorage } from './ProjectMemoryStorage'
import { Icon } from './Icon'
import './project-memory.css'

export function ProjectMemoryPanel({ workspacePath }: { workspacePath: string }) {
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
      void window.donwells.projectMemoryList({ workspacePath, ...(query.trim() ? { query: query.trim() } : {}), includeArchived, limit: 100, ...(selectedKind ? { kinds: [selectedKind] } : {}) }).then((value) => {
        if (!cancelled) { setResult(value); setLoading(false) }
      }, (cause) => { if (!cancelled) { setError(String(cause)); setLoading(false) } })
    }, query ? 120 : 0)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [workspacePath, query, kind, includeArchived, generation])

  return (
    <section className="project-memory-panel" aria-label="Project memory">
      <header className="pane-header memory-panel-heading">
        <div><strong>Project memory</strong><span title={result?.project.projectPath ?? workspacePath}>{pathBasename(result?.project.projectPath ?? workspacePath)}</span></div>
        <button type="button" className="icon-btn" title="Refresh project memory" aria-label="Refresh project memory" disabled={loading} onClick={refresh}><Icon name="refresh" size={13} /></button>
      </header>
      <p className="memory-guidance">One project knowledge store, shared across its worktrees and coding harnesses.</p>
      <div className="memory-panel-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => openProjectMemoryEditor(workspacePath)}>New memory</button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConnecting(true)}>Connect harness</button>
      </div>
      <label className="memory-search"><span className="sr-only">Search project memory</span><input className="input" aria-label="Search project memory" value={query} maxLength={PROJECT_MEMORY_MAX_QUERY_LENGTH} onChange={(event) => setQuery(event.target.value)} placeholder="Search decisions, conventions, tags…" /></label>
      <div className="memory-panel-filters">
        <select className="input" aria-label="Filter memory kind" value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">All kinds</option>{PROJECT_MEMORY_KINDS.map((value) => <option key={value} value={value}>{value}</option>)}</select>
        <label><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} /> Archived</label>
      </div>
      <div className="memory-list-caption" role="status">{loading ? 'Searching…' : result ? `${result.entries.length} of ${result.total} matching entries` : ''}</div>
      {error && <div className="memory-error" role="alert">{error}<button className="btn btn-secondary btn-sm" onClick={refresh}>Retry</button></div>}
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
            : <button type="button" className="btn btn-primary btn-sm" onClick={() => openProjectMemoryEditor(workspacePath)}>New memory</button>}
        </div>}
        {result?.hasMore && <p className="memory-guidance">Showing the first 100 matches. Narrow the search to find older entries.</p>}
      </div>
      {connecting && <ProjectMemoryConnection workspacePath={workspacePath} onClose={() => setConnecting(false)} />}
      <ProjectMemoryStorage onChanged={refresh} />
    </section>
  )
}
