import { useEffect, useState } from 'react'
import type { ProjectMemoryStorageAction, ProjectMemoryStorageStatus } from '@shared/project-memory'

export function ProjectMemoryStorage({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<ProjectMemoryStorageStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    let cancelled = false
    void window.donwells.projectMemoryStorageStatus().then(value => { if (!cancelled) setStatus(value) }, error => { if (!cancelled) setMessage(String(error)) })
    return () => { cancelled = true }
  }, [])
  const check = async () => {
    setBusy(true)
    try { setStatus(await window.donwells.projectMemoryStorageStatus()); setMessage('') }
    catch (error) { setMessage(String(error)) }
    finally { setBusy(false) }
  }
  const act = async (action: ProjectMemoryStorageAction) => {
    setBusy(true); setMessage('')
    try {
      const result = await window.donwells.projectMemoryStorageAction(action)
      setStatus(result.status)
      setMessage(result.exportPath ? `Export saved: ${result.exportPath}` : action === 'migrate' ? 'Shared memory now uses SQLite.' : action === 'reverse' ? 'Current memory now uses JSON.' : 'Preserved JSON memory restored.')
    } catch (error) {
      setMessage(String(error))
      try { setStatus(await window.donwells.projectMemoryStorageStatus()) } catch { /* Keep the original action error visible. */ }
    } finally { setBusy(false); onChanged() }
  }
  return <details className="memory-storage">
    <summary>Memory storage · {status?.backend ?? 'checking'}</summary>
    <p>Applies to all project memories in this app profile. Terminal sessions keep running.</p>
    {status?.backend === 'json' && <p>Upgrade to SQLite with a verified backup of the current JSON store.</p>}
    {status?.backend === 'preparing' && <p>An upgrade is unfinished. Resume it or return to the preserved JSON source.</p>}
    {status?.backend === 'reversing' && <p>Return to JSON is unfinished. Resume to preserve all writes made after the upgrade.</p>}
    {status?.backend === 'sqlite' && <p>Return to JSON exports current records and revisions first. The SQLite database and original backup are retained.</p>}
    {status?.backend === 'aborting' && <p>Recovery is unfinished. Continue restoring the preserved JSON source.</p>}
    {status?.error && <p className="memory-error" role="alert">{status.error}</p>}
    {status?.backupPath && <p className="memory-storage-path">Backup · {status.backupBytes?.toLocaleString()} bytes<br />{status.backupPath}</p>}
    <div className="memory-storage-actions">
      <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void check()}>Check storage</button>
      {(status?.backend === 'json' || status?.backend === 'preparing') && <button className="btn btn-primary btn-sm" disabled={busy || status.backend === 'json' && !!status.error} onClick={() => void act('migrate')}>{status.backend === 'preparing' ? 'Resume upgrade' : 'Upgrade to SQLite'}</button>}
      {(status?.backend === 'preparing' || status?.backend === 'aborting') && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void act('abort')}>Return to preserved JSON</button>}
      {status?.backend === 'sqlite' && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void act('export')}>Export current memory</button>}
      {(status?.backend === 'sqlite' || status?.backend === 'reversing') && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void act('reverse')}>{status.backend === 'reversing' ? 'Resume return to JSON' : 'Return current memory to JSON'}</button>}
    </div>
    <p className="memory-storage-path" role="status">{busy ? 'Working…' : message}</p>
  </details>
}
