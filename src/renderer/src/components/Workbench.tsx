import { type ReactNode } from 'react'
import { useAppStore, type LayoutNode, type Pane } from '../store'
import { TerminalPane } from './TerminalPane'
import { PreviewPane } from './PreviewPane'
import { BrowserPane } from './BrowserPane'
import { Icon } from './Icon'

// Stable references for selectors: zustand v5 compares snapshots by identity, so a
// fresh `?? []` per call would re-render in an infinite loop (React error #185).
const EMPTY_PANES: Pane[] = []

/** Recursive split-tree renderer (upstream TabGroupLayoutNode shape). */
function LayoutTree({ node, render }: { node: LayoutNode; render: (paneKey: string) => ReactNode }) {
  if (node.kind === 'leaf') return <>{render(node.pane)}</>
  return (
    <div className={`split split-${node.dir}`}>
      <LayoutTree node={node.first} render={render} />
      <LayoutTree node={node.second} render={render} />
    </div>
  )
}

/**
 * Center workbench: the ACTIVE worktree's terminal/preview panes laid out by the
 * split tree (flat = single active pane; split = every leaf visible, Orca's
 * TabGroupSplitLayout).
 */
export function Workbench() {
  const activeWorktreePath = useAppStore((s) => s.activeWorktreePath)
  const paneRecord = useAppStore((s) => s.panes)
  const panes = activeWorktreePath ? paneRecord[activeWorktreePath] ?? EMPTY_PANES : EMPTY_PANES
  const layout = useAppStore((s) => (activeWorktreePath ? s.layouts[activeWorktreePath] : undefined))
  const activePaneKey = useAppStore((s) => (activeWorktreePath ? s.activePane[activeWorktreePath] ?? '' : ''))
  const terminals = useAppStore((s) => s.terminals)
  const runningAgents = useAppStore((s) => s.runningAgents)
  const stopAgent = useAppStore((s) => s.stopAgent)
  const dismissAgent = useAppStore((s) => s.dismissAgent)
  const setActivePane = useAppStore((s) => s.setActivePane)
  const closePane = useAppStore((s) => s.closePane)
  const splitTerminal = useAppStore((s) => s.splitTerminal)
  const openTerminal = useAppStore((s) => s.openTerminal)

  if (!activeWorktreePath) return null

  const labelOf = (pane: Pane): string => {
    if (pane.kind === 'preview') return pane.file?.split('/').pop() ?? 'file'
    const session = pane.sessionId ? terminals[pane.sessionId]?.session : null
    return session?.title?.split(':').pop() ?? 'terminal'
  }

  const renderPane = (paneKey: string): ReactNode => {
    const pane = panes.find((p) => p.key === paneKey)
    if (!pane) return null
    const isActive = pane.key === activePaneKey
    return (
      <div
        className={`pane${isActive ? ' pane-active' : ''}`}
        onMouseDown={() => setActivePane(activeWorktreePath, paneKey)}
      >
        <div className="pane-title-bar">
          <Icon name={pane.kind === 'preview' ? 'file' : 'terminal'} size={11} />
          <span className="pane-title">{labelOf(pane)}</span>
          {pane.kind === 'terminal' && (
            <button className="icon-btn" title="Split terminal" onClick={() => void splitTerminal(activeWorktreePath)}>
              <Icon name="split" size={11} />
            </button>
          )}
          {/* Agent lifecycle lives in the pane it runs in — no dedicated bar. */}
          {pane.kind === 'terminal' && pane.sessionId && runningAgents[pane.sessionId] && (() => {
            const agent = runningAgents[pane.sessionId]!
            return (
              <span
                className={`agent-chip agent-state-${agent.state}`}
                title={agent.detail ?? agent.state}
                onClick={(e) => e.stopPropagation()}
              >
                {agent.state === 'working' && <span className="spinner" />}
                {agent.state === 'permission' && <span className="state-icon state-permission" />}
                {agent.state === 'done' && <span className="state-icon state-done" />}
                {agent.state === 'note' && <span className="state-icon state-note" />}
                <span className="agent-cmd">{agent.agent}</span>
                {agent.state === 'permission' && (
                  <>
                    <button
                      className="chip-act allow"
                      title="Allow — sends y ⏎ to the agent terminal"
                      onClick={(e) => {
                        e.stopPropagation()
                        void useAppStore.getState().writeTerminal(agent.sessionId, 'y\r')
                        setActivePane(activeWorktreePath, pane.key)
                      }}
                    >
                      Allow
                    </button>
                    <button
                      className="chip-act deny"
                      title="Deny — sends Esc to the agent terminal"
                      onClick={(e) => {
                        e.stopPropagation()
                        void useAppStore.getState().writeTerminal(agent.sessionId, '\x1b')
                        setActivePane(activeWorktreePath, pane.key)
                      }}
                    >
                      Deny
                    </button>
                  </>
                )}
                <button
                  className="icon-btn"
                  title={agent.state === 'done' ? 'Dismiss' : 'Stop agent'}
                  onClick={(e) => {
                    e.stopPropagation()
                    agent.state === 'done' ? dismissAgent(agent.sessionId) : stopAgent(agent.sessionId)
                  }}
                >
                  {agent.state === 'done' ? <Icon name="check" size={10} /> : <Icon name="stop" size={10} />}
                </button>
              </span>
            )
          })()}
          <button
            className="icon-btn danger"
            title="Close pane"
            onClick={(e) => {
              e.stopPropagation()
              closePane(activeWorktreePath, paneKey)
            }}
          >
            <Icon name="x" size={11} />
          </button>
        </div>
        {pane.kind === 'browser' && pane.url ? (
          <BrowserPane url={pane.url} onClose={() => closePane(activeWorktreePath, pane.key)} />
        ) : (
          <div className={`pane-body-terminal${isActive || !!layout ? '' : ' terminal-hidden'}`}>
            {pane.kind === 'terminal' && pane.sessionId && terminals[pane.sessionId] ? (
              <TerminalPane
                sessionId={pane.sessionId}
                cols={terminals[pane.sessionId]!.cols}
                rows={terminals[pane.sessionId]!.rows}
                isActive={!!layout || isActive}
              />
            ) : pane.kind === 'preview' ? (
              <PreviewPane worktreePath={activeWorktreePath} isActive />
            ) : null}
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="workbench">
      {layout ? (
        <LayoutTree node={layout} render={renderPane} />
      ) : (
        panes
          .filter((p) => p.kind === 'terminal' || p.kind === 'preview' || p.kind === 'browser')
          .map((p) => <div key={p.key} className={p.key === activePaneKey ? '' : 'terminal-hidden'}>{renderPane(p.key)}</div>)
      )}
    </div>
  )
}
