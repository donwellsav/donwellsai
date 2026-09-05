import { useAppStore } from '../store'
import { Icon } from './Icon'
import { AgentsSection } from './runs/AgentsSection'
import { ParallelRunsSection } from './runs/ParallelRunsSection'
import { ScheduledRunsSection } from './runs/ScheduledRunsSection'
import './runs/runs.css'

export function RunsPanel() {
  const section = useAppStore((state) => state.runsSection)
  const openRuns = useAppStore((state) => state.openRuns)
  const setRunsOpen = useAppStore((state) => state.setRunsOpen)

  return (
    <section className="runs-panel operational-runs" aria-label="Agent supervision and operational runs">
      <header className="runs-header op-runs-header">
        <div>
          <span className="op-eyebrow">Supervision</span>
          <h2>Runs</h2>
        </div>
        <div className="rs-tabs" role="tablist" aria-label="Run views">
          <button
            className={`rs-tab${section === 'agents' ? ' active' : ''}`}
            role="tab"
            aria-selected={section === 'agents'}
            onClick={() => openRuns('agents')}
          >
            Agents
          </button>
          <button
            className={`rs-tab${section === 'orchestration' ? ' active' : ''}`}
            role="tab"
            aria-selected={section === 'orchestration'}
            onClick={() => openRuns('orchestration')}
          >
            Parallel shells
          </button>
          <button
            className={`rs-tab${section === 'automations' ? ' active' : ''}`}
            role="tab"
            aria-selected={section === 'automations'}
            onClick={() => openRuns('automations')}
          >
            Scheduled shells
          </button>
        </div>
        <button className="icon-btn" aria-label="Close runs" onClick={() => setRunsOpen(false)}>
          <Icon name="x" size={14} />
        </button>
      </header>
      <div className="runs-body op-runs-body">
        {section === 'agents' ? (
          <AgentsSection />
        ) : section === 'orchestration' ? (
          <ParallelRunsSection />
        ) : (
          <ScheduledRunsSection />
        )}
      </div>
    </section>
  )
}
