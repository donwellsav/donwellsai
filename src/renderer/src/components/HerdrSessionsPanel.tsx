import { useEffect, useState } from 'react'
import type { HerdrAgentStatus, HerdrSnapshot } from '@shared/herdr-session'
import { useAppStore } from '../store'

const statusLabel = (status: HerdrAgentStatus): string => status[0].toUpperCase() + status.slice(1)

export function HerdrSessionsPanel() {
  const [snapshot, setSnapshot] = useState<HerdrSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const openPanes = useAppStore(state => state.panes)
  const refresh = async (): Promise<void> => {
    setLoading(true); setError(null)
    try { setSnapshot(await window.donwells.herdrSnapshot()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setLoading(false) }
  }
  useEffect(() => { void refresh() }, [])

  const open = async (workspaceId: string, paneId: string): Promise<void> => {
    const workspace = snapshot?.workspaces.find(item => item.workspaceId === workspaceId)
    const pane = snapshot?.panes.find(item => item.paneId === paneId)
    if (!workspace || !pane || opening) return
    setOpening(paneId); setError(null)
    try { await useAppStore.getState().openHerdrPane(workspace, pane) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setOpening(null) }
  }

  return <section className="herdr-sessions-panel" aria-label="Sessions" aria-busy={loading}>
    <div className="herdr-sessions-heading">
      <div><h2>Sessions</h2><small>Continue a running pane in Don</small></div>
      <button type="button" className="btn btn-secondary btn-sm herdr-action" onClick={() => void refresh()} disabled={loading} aria-label="Refresh sessions">{loading ? 'Refreshing…' : 'Refresh'}</button>
    </div>
    <p className="herdr-sessions-note">Open a live view here. The original session keeps running and owns the full scrollback; switch to control when you need to type.</p>
    {error && <div className="herdr-sessions-alert" role="alert"><strong>Couldn’t complete that action</strong><p>{error}</p></div>}
    {!snapshot && loading && <div className="herdr-sessions-empty" role="status"><strong>Checking for sessions…</strong></div>}
    {!snapshot && !loading && error && <div className="herdr-sessions-empty"><small>Make sure your session service is running, then refresh to try again.</small></div>}
    {snapshot && snapshot.workspaces.length === 0 && <div className="herdr-sessions-empty" role="status"><strong>No active sessions</strong><small>Start a session in your coding environment, then refresh to see its panes here.</small></div>}
    {snapshot?.workspaces.map(workspace => {
      const panes = snapshot.panes.filter(pane => pane.workspaceId === workspace.workspaceId)
      return <section className="herdr-session-workspace" key={workspace.workspaceId} aria-label={`${workspace.label} workspace`}>
        <header>
          <div className="herdr-workspace-title"><h3>{workspace.label}</h3><small>{panes.length} {panes.length === 1 ? 'pane' : 'panes'}</small></div>
          <span className="herdr-status" data-status={workspace.agentStatus}><i aria-hidden="true" />{statusLabel(workspace.agentStatus)}</span>
        </header>
        {panes.length === 0 && <small className="herdr-session-empty-line">No panes in this workspace yet.</small>}
        {panes.map(pane => {
          const alreadyOpen = Boolean(workspace.checkoutPath && openPanes[workspace.checkoutPath]?.some(item => item.herdrPaneId === pane.paneId))
          const canOpen = Boolean(workspace.checkoutPath)
          return <article className="herdr-session-pane" key={pane.paneId}>
            <div><strong>{pane.label}</strong><small>{pane.agent ?? 'Terminal'} · {statusLabel(pane.agentStatus)}{pane.focused ? ' · Currently active' : ''}</small></div>
            <button type="button" className="btn btn-primary btn-sm herdr-action" disabled={!canOpen || Boolean(opening)} aria-busy={opening === pane.paneId} title={!canOpen ? 'No workspace is attached to this pane' : alreadyOpen ? 'Bring this pane to the front in Don' : 'Open this persistent pane in the Don workspace'} onClick={() => void open(workspace.workspaceId, pane.paneId)}>{!canOpen ? 'No workspace' : opening === pane.paneId ? 'Opening…' : alreadyOpen ? 'Focus in Don' : 'Open in Don'}</button>
          </article>
        })}
      </section>
    })}
  </section>
}
