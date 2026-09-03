import { useAppStore, type Pane } from '../store'
import { Icon } from './Icon'

// Stable references: zustand v5 compares snapshots by identity — an inline `?? []`
// creates a fresh array per call and re-renders forever (React error #185).
const EMPTY_PANES: Pane[] = []

export function TitlebarTabs() {
  const activeWorktreePath = useAppStore((s) => s.activeWorktreePath)
  const panes = useAppStore((s) => (activeWorktreePath ? s.panes[activeWorktreePath] ?? EMPTY_PANES : EMPTY_PANES))
  const activePane = useAppStore((s) => (activeWorktreePath ? s.activePane[activeWorktreePath] ?? '' : ''))
  const terminals = useAppStore((s) => s.terminals)
  const runningAgents = useAppStore((s) => s.runningAgents)
  const setActivePane = useAppStore((s) => s.setActivePane)
  const closePane = useAppStore((s) => s.closePane)
  const openTerminal = useAppStore((s) => s.openTerminal)
  const splitTerminal = useAppStore((s) => s.splitTerminal)

  if (!activeWorktreePath) return null
  const tabs = panes.filter((p) => p.kind === 'terminal' || p.kind === 'preview')

  return (
    <>
      {tabs.map((p) => {
        const session = p.sessionId ? terminals[p.sessionId]?.session : null
        const label =
          p.kind === 'preview'
            ? (p.file?.split('/').pop() ?? 'file')
            : (session?.title?.split(':').pop() ?? 'terminal')
        const running = p.sessionId ? !!runningAgents[p.sessionId] : false
        return (
          <button
            key={p.key}
            className={`tab${p.key === activePane ? ' active' : ''}`}
            onClick={() => setActivePane(activeWorktreePath, p.key)}
            title={p.kind === 'preview' ? p.file : label}
          >
            {running && <span className="spinner" />}
            <Icon name={p.kind === 'preview' ? 'file' : 'terminal'} size={12} className="tab-icon" />
            <span className="tab-label">{label}</span>
            <span
              className="tab-close"
              role="button"
              onClick={(e) => {
                e.stopPropagation()
                closePane(activeWorktreePath, p.key)
              }}
            >
              <Icon name="x" size={10} />
            </span>
          </button>
        )
      })}
      <button
        className="tab-new-button"
        title="New terminal"
        onClick={() => void openTerminal(activeWorktreePath)}
      >
        <Icon name="plus" size={14} />
      </button>
      <button
        className="tab-new-button"
        title="Split terminal"
        onClick={() => void splitTerminal(activeWorktreePath)}
      >
        <Icon name="split" size={13} />
      </button>
    </>
  )
}
