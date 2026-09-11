import { useState } from 'react'
import { useAppStore } from '../store'
import { Icon } from './Icon'
import { CollaborationPanel } from './CollaborationPanel'
import { SessionReplay } from './SessionReplay'
import { AgentsSection } from './runs/AgentsSection'
import { ParallelRunsSection } from './runs/ParallelRunsSection'
import { ScheduledRunsSection } from './runs/ScheduledRunsSection'
import './runs/runs.css'

export function RunsPanel() {
  const [replaySessionId, setReplaySessionId] = useState<string | null>(null)
  const draftKey = useAppStore(state => state.activeWorktreePath ?? state.activeRepoId ?? '')
  const section = useAppStore((state) => state.runsSection)
  const openRuns = useAppStore((state) => state.openRuns)
  const setRunsOpen = useAppStore((state) => state.setRunsOpen)

  return (
    <section className="runs-panel operational-runs" aria-label={section === 'agents' ? 'Agents' : 'Automations'}>
      <header className="runs-header op-runs-header">
        {section === 'agents' ? <h2 className="workspace-tool-title">Agents</h2> : <div className="rs-tabs" role="tablist" aria-label="Automation views" onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const next = event.key === 'Home' ? 'orchestration' : event.key === 'End' ? 'automations' : section === 'orchestration' ? 'automations' : 'orchestration'
          openRuns(next)
          event.currentTarget.querySelector<HTMLButtonElement>(`#runs-tab-${next}`)?.focus()
        }}>
          {([['orchestration', 'Commands', 'Run a shell command across selected project checkouts'], ['automations', 'Schedules', 'Run shell commands automatically on a schedule']] as const).map(([id, label, title]) => <button key={id} className={`rs-tab${section === id ? ' active' : ''}`} role="tab" aria-selected={section === id} id={`runs-tab-${id}`} title={title} aria-controls="runs-content" tabIndex={section === id ? 0 : -1} onClick={() => openRuns(id)}>{label}</button>)}
        </div>}
        <button className="icon-btn" aria-label={section === 'agents' ? 'Close agents' : 'Close automations'} title="Return to your open terminals and files" onClick={() => setRunsOpen(false)}>
          <Icon name="x" size={14} />
        </button>
      </header>
      <div id="runs-content" role={section === 'agents' ? 'region' : 'tabpanel'} aria-label={section === 'agents' ? 'Agent sessions' : undefined} aria-labelledby={section === 'agents' ? undefined : `runs-tab-${section}`} tabIndex={0} className="runs-body op-runs-body">
        {section === 'agents' ? (
          <AgentsSection key={draftKey} />
        ) : section === 'orchestration' ? (
          <ParallelRunsSection />
        ) : (
          <ScheduledRunsSection />
        )}
      </div>
      <CollaborationPanel />
      {/* Session Replay */}
      {replaySessionId && (
        <SessionReplay
          events={[]}
          sessionId={replaySessionId}
          onClose={() => setReplaySessionId(null)}
        />
      )}
    </section>
  )
}
