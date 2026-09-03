import { type ReactNode } from 'react'
import { useAppStore, type LayoutNode, type Pane } from '../store'
import { TerminalPane } from './TerminalPane'
import { PreviewPane } from './PreviewPane'
import { AgentRunBar } from './AgentRunBar'
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
        className="pane"
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
          {pane.kind === 'terminal' && (
            <button className="icon-btn" title="New terminal" onClick={() => void openTerminal(activeWorktreePath)}>
              <Icon name="plus" size={12} />
            </button>
          )}
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
      <AgentRunBar worktreePath={activeWorktreePath} />
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
