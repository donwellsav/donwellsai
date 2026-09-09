import { guiDraftMap } from '../../gui-drafts'
import { useEffect, useState } from 'react'
import type { ProjectKitPreview, ProjectKitReport } from '@shared/project-export'
import { flushWorkspaceSession, useAppStore } from '../../store'

const drafts = guiDraftMap<{ includeLearned: boolean; artifacts: string }>('project-kits')

export function ProjectKitSettings() {
  const workspace = useAppStore(state => state.activeWorktreePath)
  const saved = drafts.get(workspace ?? '')
  const [includeLearned,setIncludeLearned]=useState(saved?.includeLearned ?? false)
  const [artifacts, setArtifacts] = useState(saved?.artifacts ?? '')
  const [archive, setArchive] = useState('')
  const [exportOpen, setExportOpen] = useState(false)
  const [candidates, setCandidates] = useState<string[]>([])
  useEffect(() => {
    if (!workspace || !exportOpen) return
    let live = true
    void Promise.allSettled(['', 'docs', 'backlog/tasks', '.backlog/tasks', '.github/workflows'].map(directory => window.donwells.listWorkspaceDirectory(workspace, { directory, showHidden: true, includeIgnored: false }))).then(results => {
      if (!live) return
      setCandidates([...new Set(results.flatMap(result => result.status === 'fulfilled' ? result.value.entries.filter(entry => entry.type === 'file' && /\.(md|txt|ya?ml)$/i.test(entry.path)).map(entry => entry.path) : []))].sort().slice(0, 100))
    })
    return () => { live = false }
  }, [workspace, exportOpen])
  const [preview, setPreview] = useState<ProjectKitPreview | null>(null)
  const [report, setReport] = useState<ProjectKitReport | null>(null)
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('')
  useEffect(() => { drafts.set(workspace ?? '', { includeLearned, artifacts }) }, [workspace, includeLearned, artifacts])
  useEffect(() => {
    let cancelled = false
    setReport(null)
    if (workspace) void window.donwells.projectKitReport(workspace).then(value => { if (!cancelled) setReport(value) }).catch(() => { if (!cancelled) setError('Could not read project restore report') })
    return () => { cancelled = true }
  }, [workspace])
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setMessage('')
    try { await action() } catch (error) { setError(String(error)) } finally { setBusy(false) }
  }
  return <section aria-label="Project backup and restore" className="project-tools-settings">
    <h3>Project backup and restore</h3>
    <p>Save project memory, handoffs and layout, with optional text files. Source code, agent sessions and credentials stay on this computer.</p>
    {report && <details open><summary>Restored project</summary><p>{report.sourceName} → {report.projectPath}</p>{report.warnings.map(text => <p key={text}>{text}</p>)}
      {report.identityMapping && <details><summary>Restored identity map · {report.identityMapping.length} records</summary>
        <p>Original source identities remain attached through subsequent exports. Showing the first 20 mappings; the complete map is retained in the project restore report.</p>
        {report.identityMapping.slice(0, 20).map(ref => <p className="memory-storage-path" key={ref.kind + ref.id}>{ref.kind}: {ref.originalProjectKey.slice(0, 12)} / {ref.originalId} → {ref.targetId}</p>)}
        {(report.learnedFacts??0)>0 && <><p>Reconnect restored learned facts after configuring Hindsight. This preserves extracted text and re-embeds it with the server's configured embedding model; it uses model compute and replaces the active learned bank only after successful import.</p><button className="btn btn-secondary btn-sm" disabled={busy||!workspace} onClick={()=>void run(async()=>{const result=await window.donwells.projectKitReconnectLearned(workspace!);setMessage(`Restored learned facts are connected to ${result.generation}. Open Learned knowledge to recall them.`)})}>Reconnect learned facts · re-embed</button></>}
    </details>}
    </details>}
    <fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
      <details onToggle={event => setExportOpen(event.currentTarget.open)}><summary>Export current project</summary>
        <p>{workspace ?? 'Select a project to export.'}</p>
        <details><summary>Include text files (optional)</summary><fieldset><legend>Project text files</legend>{candidates.length ? candidates.map(path => <label key={path} style={{ display: 'block' }}><input type="checkbox" checked={artifacts.split('\n').includes(path)} onChange={event => setArtifacts(current => event.target.checked ? [...new Set([...current.split('\n').filter(Boolean), path])].join('\n') : current.split('\n').filter(value => value !== path).join('\n'))} />{path}</label>) : <p>No suggested files found.</p>}</fieldset>
        <details><summary>Advanced: other text files</summary><label>Relative paths, one per line<textarea className="settings-input" style={{ width: '100%' }} value={artifacts} onChange={event => setArtifacts(event.target.value)} /></label></details>
        </details><label><input type="checkbox" checked={includeLearned} onChange={event=>setIncludeLearned(event.target.checked)} /> Include learned memories from your connected memory service</label>
        <p>Previously restored memories are included automatically. Add any text files you want to transfer above.</p>
        <button className="btn btn-secondary btn-sm" disabled={!workspace} onClick={() => void run(async () => {
          const selectedOutput = await window.donwells.pickProjectKitPath('export')
          if (!selectedOutput) return
          await flushWorkspaceSession()
          const result = await window.donwells.projectKitExport(workspace!, selectedOutput, artifacts.split('\n').filter(Boolean),{includeLearned})
          setMessage(`Saved ${result.memories} memories, ${result.revisions} prior revisions and ${result.artifacts.length} artifacts, ${result.learnedFacts??0} learned facts to ${result.path}`)
        })}>Export project kit…</button>
      </details>
      <details><summary>Restore into a new project</summary>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void run(async () => {
          const selectedArchive = await window.donwells.pickProjectKitPath('archive')
          if (!selectedArchive) return
          setArchive(selectedArchive); setPreview(null)
          setPreview(await window.donwells.projectKitPreview(selectedArchive))
        })}>Choose project kit…</button>
        {preview && <>
          <p>Kit version {preview.schemaVersion} · Source: {preview.sourceName} · {preview.erasedMemories} erasure records · {preview.memories} memories · {preview.revisions} prior revisions · {preview.handoffs} handoffs</p>
          <p>{preview.learnedFacts??0} historical learned facts · {preview.temporalSources??0} temporal rebuild sources. Restored learned documents: donwells-import/knowledge.json.</p>
          {preview.portableSettings && <details><summary>Portable integration settings</summary><pre>{JSON.stringify(preview.portableSettings,null,2)}</pre></details>}
          <p style={{ overflowWrap: 'anywhere' }}>Source identity: {preview.sourceProjectKey}</p>
          {preview.artifacts.length > 0 && <ul>{preview.artifacts.map(path => <li key={path}>{path}</li>)}</ul>}
          {preview.warnings.map(text => <p key={text}>{text}</p>)}
          <details><summary>Tool version manifest</summary><ul>{preview.tools.map(tool => <li key={tool.id}>{tool.id}: {tool.version} · {tool.configured ? 'requires local setup' : 'not configured in source'}</li>)}</ul></details>
          <p>Restore {preview.sourceName} into a new folder.</p>
          <button className="btn btn-secondary btn-sm" onClick={() => void run(async () => {
            const selectedDestination = await window.donwells.pickProjectKitPath('destination')
            if (!selectedDestination) return
            const result = await window.donwells.projectKitImport(archive, selectedDestination, preview.sha256, preview.sourceProjectKey)
            setPreview(null); setReport(result.report)
            await useAppStore.getState().openImportedProject(result.repo.id)
            setMessage(`Restored to ${result.repo.path}. Configure local tools and rebuild indexes when ready.`)
          })}>Restore reviewed kit…</button>
        </>}
      </details>
    </fieldset>
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </section>
}
