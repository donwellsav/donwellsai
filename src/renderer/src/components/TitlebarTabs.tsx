import { useAppStore, type Pane } from '../store'
import { Icon } from './Icon'

// Stable references: zustand v5 compares snapshots by identity — an inline `?? []`
// creates a fresh array per call and re-renders forever (React error #185).
const EMPTY_PANES: Pane[] = []

/**
 * Titlebar tab strip mirroring Orca's TopActivityStrip: 36px icon buttons,
 * active tab = 2px bottom bar inset 25%, agent dot top-right, tooltips.
 */
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
  const openBrowser = useAppStore((s) => s.openBrowser)

  if (!activeWorktreePath) return null
  const tabs = panes.filter((p) => p.kind === 'terminal' || p.kind === 'preview' || p.kind === 'browser')
  return (
    <>
      {tabs.map((p) => {
        const session = p.sessionId ? terminals[p.sessionId]?.session : null
        const label =
          p.kind === 'preview'
            ? (p.file?.split('/').pop() ?? 'file')
            : p.kind === 'browser'
              ? (p.url?.replace(/^https?:\/\//, '').split('/')[0] ?? 'browser')
              : (session?.title?.split(':').pop() ?? 'terminal')
        const agent = p.sessionId ? runningAgents[p.sessionId] : undefined
        const icon: Parameters<typeof Icon>[0]['name'] =
          p.kind === 'browser' ? 'globe' : p.kind === 'preview' ? 'file' : 'terminal'
        return (
          <button
            key={p.key}
            className={`strip-tab${p.key === activePane ? ' active' : ''}`}
            onClick={() => setActivePane(activeWorktreePath, p.key)}
            aria-label={label}
            title={label}
          >
            <Icon name={icon} size={16} />
            {agent && (
              <span
                className={`strip-dot ${agent.state === 'done' ? 'strip-dot-done' : agent.state === 'permission' ? 'strip-dot-permission' : 'strip-dot-working'}`}
              />
            )}
            {p.key === activePane && <span className="strip-active-bar" />}
          </button>
        )
      })}
      <button className="strip-button" title="New terminal" aria-label="New terminal" onClick={() => void openTerminal(activeWorktreePath)}>
        <Icon name="plus" size={16} />
      </button>
      <button
        className="strip-button"
        title="Open browser tab"
        onClick={() => {
          const url = prompt('Open URL:')
          if (url) openBrowser(activeWorktreePath, url)
        }}
      >
        <Icon name="globe" size={16} />
      </button>
      <button className="strip-button" title="Split terminal" onClick={() => void splitTerminal(activeWorktreePath)}>
        <Icon name="split" size={16} />
      </button>
    </>
  )
}