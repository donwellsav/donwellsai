import { useEffect, useState } from 'react'
import type { ProjectKitPreview, ProjectKitReport } from '@shared/project-export'
import { flushWorkspaceSession, useAppStore } from '../../store'

export function ProjectKitSettings() {
  const workspace = useAppStore(state => state.activeWorktreePath)
  const [includeLearned,setIncludeLearned]=useState(false)
  const [output, setOutput] = useState(''), [artifacts, setArtifacts] = useState('')
  const [archive, setArchive] = useState(''), [destination, setDestination] = useState('')
  const [preview, setPreview] = useState<ProjectKitPreview | null>(null)
  const [report, setReport] = useState<ProjectKitReport | null>(null)
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('')
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
    <p>Save shared memory, retained revisions and erasure records, handoffs with linked fact identities, panel arrangement and selected text artifacts. Agent sessions, credentials, source checkouts and derived indexes are not copied.</p>
    {report && <details open><summary>Restored project</summary><p>{report.sourceName} → {report.projectPath}</p>{report.warnings.map(text => <p key={text}>{text}</p>)}
      {report.identityMapping && <details><summary>Restored identity map · {report.identityMapping.length} records</summary>
        <p>Original source identities remain attached through subsequent exports. Showing the first 20 mappings; the complete map is retained in the project restore report.</p>
        {report.identityMapping.slice(0, 20).map(ref => <p className="memory-storage-path" key={ref.kind + ref.id}>{ref.kind}: {ref.originalProjectKey.slice(0, 12)} / {ref.originalId} → {ref.targetId}</p>)}
        {(report.learnedFacts??0)>0 && <><p>Reconnect restored learned facts after configuring Hindsight. This preserves extracted text and re-embeds it with the server's configured embedding model; it uses model compute and replaces the active learned bank only after successful import.</p><button className="btn btn-secondary btn-sm" disabled={busy||!workspace} onClick={()=>void run(async()=>{const result=await window.donwells.projectKitReconnectLearned(workspace!);setMessage(`Restored learned facts are connected to ${result.generation}. Open Learned knowledge to recall them.`)})}>Reconnect learned facts · re-embed</button></>}
    </details>}
    </details>}
    <fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
      <details><summary>Export current project</summary>
        <p>{workspace ?? 'Select a project to export.'}</p>
        <label style={{ display: 'block' }}>New kit file<input className="settings-input" style={{ width: '100%' }} value={output} placeholder="/absolute/path/project.donwells-kit.json" onChange={event => setOutput(event.target.value)} /></label>
        <label style={{ display: 'block' }}>Native task files, workflow files and text artifacts (one relative path per line)<textarea className="settings-input" style={{ width: '100%' }} value={artifacts} placeholder={"backlog/tasks/task-1.md\n.github/workflows/build.yml\ndocs/plan.md"} onChange={event => setArtifacts(event.target.value)} /></label>
        <label><input type="checkbox" checked={includeLearned} onChange={event=>setIncludeLearned(event.target.checked)} /> Export current Hindsight learned facts (existing service and configured Python required; no model extraction)</label>
        <p>Already restored historical learned documents remain included. Temporal indexes rebuild from their selected canonical revisions. Select every authoritative task/workflow file you want moved.</p>
        <button className="btn btn-secondary btn-sm" disabled={!workspace || !output} onClick={() => void run(async () => {
          await flushWorkspaceSession()
          const result = await window.donwells.projectKitExport(workspace!, output, artifacts.split('\n').filter(Boolean),{includeLearned})
          setMessage(`Saved ${result.memories} memories, ${result.revisions} prior revisions and ${result.artifacts.length} artifacts, ${result.learnedFacts??0} learned facts to ${result.path}`)
        })}>Export project kit</button>
      </details>
      <details><summary>Restore into a new project</summary>
        <label style={{ display: 'block' }}>Kit file to restore<input className="settings-input" style={{ width: '100%' }} value={archive} onChange={event => { setArchive(event.target.value); setPreview(null) }} /></label>
        <button className="btn btn-secondary btn-sm" disabled={!archive} onClick={() => void run(async () => setPreview(await window.donwells.projectKitPreview(archive)))}>Review project kit</button>
        {preview && <>
          <p>Kit version {preview.schemaVersion} · Source: {preview.sourceName} · {preview.erasedMemories} erasure records · {preview.memories} memories · {preview.revisions} prior revisions · {preview.handoffs} handoffs</p>
          <p>{preview.learnedFacts??0} historical learned facts · {preview.temporalSources??0} temporal rebuild sources. Restored learned documents: donwells-import/knowledge.json.</p>
          {preview.portableSettings && <details><summary>Portable integration settings</summary><pre>{JSON.stringify(preview.portableSettings,null,2)}</pre></details>}
          <p style={{ overflowWrap: 'anywhere' }}>Source identity: {preview.sourceProjectKey}</p>
          {preview.artifacts.length > 0 && <ul>{preview.artifacts.map(path => <li key={path}>{path}</li>)}</ul>}
          {preview.warnings.map(text => <p key={text}>{text}</p>)}
          <details><summary>Tool version manifest</summary><ul>{preview.tools.map(tool => <li key={tool.id}>{tool.id}: {tool.version} · {tool.configured ? 'requires local setup' : 'not configured in source'}</li>)}</ul></details>
          <label style={{ display: 'block' }}>New destination folder<input className="settings-input" style={{ width: '100%' }} value={destination} placeholder="/absolute/path/new-project" onChange={event => setDestination(event.target.value)} /></label>
          <p>{preview.sourceName} → {destination || 'Choose a new destination'}</p>
          <button className="btn btn-secondary btn-sm" disabled={!destination} onClick={() => void run(async () => {
            const result = await window.donwells.projectKitImport(archive, destination, preview.sha256, preview.sourceProjectKey)
            setPreview(null); setReport(result.report)
            await useAppStore.getState().openImportedProject(result.repo.id)
            setMessage(`Restored to ${result.repo.path}. Configure local tools and rebuild indexes when ready.`)
          })}>Restore reviewed kit</button>
        </>}
      </details>
    </fieldset>
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </section>
}
