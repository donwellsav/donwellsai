import { useEffect, type ReactNode } from 'react'
import type { Worktree } from '@shared/types'
import { useAppStore, type LayoutNode, type Pane } from '../store'
import { TerminalPane } from './TerminalPane'
import { ExplorerPane } from './ExplorerPane'
import { GitStatusPane } from './GitStatusPane'
import { PreviewPane } from './PreviewPane'
import { Icon } from './Icon'
const branchShort = (b: string): string => b.replace(/^refs\/heads\//, '')
// Stable references for selectors: zustand v5 compares snapshots by identity, so a
// fresh `?? []` per call would re-render in an infinite loop (React error #185).
const EMPTY_PANES: Pane[] = []
const EMPTY_ORDER: string[] = []

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
export function WorktreeCard({ worktree }: { worktree: Worktree }) {
  const paneRecord = useAppStore((s) => s.panes)
  const panes = paneRecord[worktree.path] ?? EMPTY_PANES
  const activePaneKey = useAppStore((s) => s.activePane[worktree.path] ?? '')
  const setActivePane = useAppStore((s) => s.setActivePane)
  const closePane = useAppStore((s) => s.closePane)
  const terminalOrderRecord = useAppStore((s) => s.terminalOrder)
  const terminalOrder = terminalOrderRecord[worktree.path] ?? EMPTY_ORDER
  const terminals = useAppStore((s) => s.terminals)
  const activeTerminal = useAppStore((s) => s.activeTerminal[worktree.path] ?? '')
  const selectTerminal = useAppStore((s) => s.selectTerminal)
  const openTerminal = useAppStore((s) => s.openTerminal)
  const closeTerminal = useAppStore((s) => s.closeTerminal)
  const togglePane = useAppStore((s) => s.togglePane)
  const loadExplorer = useAppStore((s) => s.loadExplorer)
  const removeWorktree = useAppStore((s) => s.removeWorktree)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const activeWorktreePath = useAppStore((s) => s.activeWorktreePath)
  const status = useAppStore((s) => s.statuses[worktree.path])
  const runningAgents = useAppStore((s) => s.runningAgents)
  const runAgent = useAppStore((s) => s.runAgent)
  const stopAgent = useAppStore((s) => s.stopAgent)
  const settings = useAppStore((s) => s.settings)

  const sessionOf = (key: string): string | undefined => panes.find((p) => p.key === key)?.sessionId
  const activeSessionId = activeTerminal || sessionOf(activePaneKey) || terminalOrder[terminalOrder.length - 1]
  const agentForCard = Object.values(runningAgents).find((a) => a.worktreePath === worktree.path)
  const activeTerminalState = activeSessionId ? terminals[activeSessionId] : undefined

  // Auto-open a terminal the first time a card becomes visible (matches Orca: each worktree gets a shell ready).
  useEffect(() => {
    if (terminalOrder.length === 0 && activeWorktreePath === worktree.path) {
      void openTerminal(worktree.path)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorktreePath, worktree.path])

  const focusCard = (): void => {
    setActiveWorktree(worktree.path)
    void loadExplorer(worktree.path)
  }

  const addTerminal = async (): Promise<void> => {
    focusCard()
    const session = await openTerminal(worktree.path)
    if (session) selectTerminal(worktree.path, session.id)
  }

  const handleRemove = (): void => {
    const dirty =
      (status?.modified ?? 0) + (status?.staged ?? 0) + (status?.untracked ?? 0) + (status?.conflicts ?? 0) > 0
    const msg = dirty
      ? `Remove worktree ${branchShort(worktree.branch)}?\nIt has uncommitted changes — force-remove will delete them.`
      : `Remove worktree ${branchShort(worktree.branch)}?`
    if (!window.confirm(msg)) return
    void removeWorktree(worktree.path, dirty)
  }

  const agentPaneKeys = panes.filter((p) => p.kind === 'terminal' && p.sessionId && runningAgents[p.sessionId])
  const layout = useAppStore((s) => s.layouts[worktree.path])

  /** Renders one pane (terminal/explorer/git/preview) by key; used by both flat and split layouts. */
  const renderPane = (paneKey: string): ReactNode => {
    const pane = panes.find((p) => p.key === paneKey)
    if (!pane) return null
    if (pane.kind === 'terminal' && pane.sessionId && terminals[pane.sessionId]) {
      return (
        <TerminalPane
          key={pane.key}
          sessionId={pane.sessionId}
          cols={terminals[pane.sessionId]!.cols}
          rows={terminals[pane.sessionId]!.rows}
          // split layout: every leaf is visible; flat layout hides non-active panes
          isActive={!!layout || pane.key === activePaneKey}
        />
      )
    }
    if (pane.kind === 'explorer') {
      return <div className="pane non-terminal"><ExplorerPane worktreePath={worktree.path} /></div>
    }
    if (pane.kind === 'git-status') {
      return <div className="pane non-terminal"><GitStatusPane worktreePath={worktree.path} /></div>
    }
    if (pane.kind === 'preview') {
      return <PreviewPane worktreePath={worktree.path} isActive />
    }
    return null
  }

  const launchAgent = async (): Promise<void> => {
    focusCard()
    await runAgent(worktree.path, settings.agentCommand)
  }

  return (
    <div className={`worktree-card ${activeWorktreePath === worktree.path ? 'focused' : ''}`} onClick={focusCard}>
      <div className="worktree-card-header">
        <span className="wt-name" title={worktree.path}>
          {branchShort(worktree.branch)}
        </span>
        <span className="wt-path" title={worktree.path}>
          {worktree.path}
        </span>
        <div className="wt-status">
          {status && (status.modified + status.staged + status.untracked + status.conflicts) > 0 && (
            <span className="dirty-dot" title={`${status.staged} staged, ${status.modified} unstaged, ${status.untracked} untracked, ${status.conflicts} conflicts`}>
              {(status.modified + status.staged + status.conflicts) > 0 ? '●' : '○'} {status.modified + status.staged + status.untracked + status.conflicts}
            </span>
          )}
          {status?.branch && !worktree.isMain && (
            <span className="wt-aheadbehind">
              {status.ahead > 0 ? ` ↑${status.ahead}` : ''}
              {status.behind > 0 ? ` ↓${status.behind}` : ''}
            </span>
          )}
          {agentForCard && (
            <span className="agent-status running" title={`${agentForCard.agent} started ${new Date(agentForCard.startedAt).toLocaleTimeString()}`}>
              <Icon name="play" size={10} /> {agentForCard.agent}
            </span>
          )}
        </div>
        <div className="wt-actions">
          <button className="icon-btn" title="New terminal" onClick={() => void addTerminal()}>
            <Icon name="terminal" size={13} />
          </button>
          <button className="icon-btn" title="Toggle explorer" onClick={() => togglePane(worktree.path, 'explorer')}>
            <Icon name="dir" size={13} />
          </button>
          <button className="icon-btn" title="Toggle git status" onClick={() => togglePane(worktree.path, 'git-status')}>
            <Icon name="git" size={13} />
          </button>
          <button className="icon-btn danger" title="Remove worktree" onClick={handleRemove}>
            <Icon name="x" size={13} />
          </button>
        </div>
      </div>

      {panes.length > 0 && (
        <div className="pane-tabs">
          {panes.map((pane) => {
            const title =
              pane.kind === 'terminal'
                ? terminals[pane.sessionId!]?.session.title ?? 'terminal'
                : pane.kind === 'explorer'
                  ? 'Explorer'
                  : pane.kind === 'git-status'
                    ? 'Git Status'
                    : pane.file!.split('/').pop()!
            return (
              <span
                key={pane.key}
                className={`pane-tab ${activePaneKey === pane.key ? 'active' : ''}`}
                onClick={() => setActivePane(worktree.path, pane.key)}
              >
                {pane.kind === 'terminal' ? <Icon name="terminal" size={10} /> : pane.kind === 'explorer' ? <Icon name="dir" size={10} /> : pane.kind === 'git-status' ? <Icon name="git" size={10} /> : <Icon name="file" size={10} />}
                <span className="pane-tab-title">{title}</span>
                {pane.kind === 'terminal' && runningAgents[pane.sessionId!] && <span className="pane-tab-agent-dot" title={`${runningAgents[pane.sessionId!]!.agent} running`} />}
                <button
                  className="pane-tab-close"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (pane.kind === 'terminal' && pane.sessionId) closeTerminal(worktree.path, pane.sessionId)
                    else closePane(worktree.path, pane.key)
                  }}
                >
                  ×
                </button>
              </span>
            )
          })}
          <button className="pane-tab-add" title="New terminal" onClick={() => void addTerminal()}>
            +
          </button>
        </div>
      )}

      <div className={`terminal-panes ${layout ? 'split-layout' : ''}`}>
        {layout ? (
          <LayoutTree
            node={layout}
            render={(paneKey) => {
              const pane = panes.find((p) => p.key === paneKey)
              if (!pane) return null
              return renderPane(paneKey)
            }}
          />
        ) : (
          <>
            {/* terminal panes: always mounted, hidden unless active — scrollback survives */}
            {panes.map((pane) =>
              pane.kind === 'terminal' && pane.sessionId && terminals[pane.sessionId] ? (
                <TerminalPane
                  key={pane.key}
                  sessionId={pane.sessionId}
                  cols={terminals[pane.sessionId]!.cols}
                  rows={terminals[pane.sessionId]!.rows}
                  isActive={pane.key === activePaneKey}
                />
              ) : null
            )}

            {panes.some((p) => p.kind === 'explorer') && (
              <div className={`pane non-terminal ${panes.find((p) => p.kind === 'explorer')!.key === activePaneKey ? '' : 'terminal-hidden'}`}>
                <ExplorerPane worktreePath={worktree.path} />
              </div>
            )}
            {panes.some((p) => p.kind === 'git-status') && (
              <div className={`pane non-terminal ${panes.find((p) => p.kind === 'git-status')!.key === activePaneKey ? '' : 'terminal-hidden'}`}>
                <GitStatusPane worktreePath={worktree.path} />
              </div>
            )}
            {panes.some((p) => p.kind === 'preview') && <PreviewPane worktreePath={worktree.path} isActive={panes.find((p) => p.kind === 'preview')!.key === activePaneKey} />}
          </>
        )}
      </div>

      <div className="agent-launch">
        <button className="btn agent-run" disabled={!!agentForCard} onClick={() => void launchAgent()}>
          <Icon name="play" size={11} /> {agentForCard ? `${agentForCard.agent} running…` : `Run ${settings.agentCommand}`}
        </button>
        {agentForCard && (
          <button className="btn agent-stop" title="Stop agent (Ctrl-C)" onClick={() => stopAgent(agentForCard.sessionId)}>
            <Icon name="stop" size={11} /> Stop
          </button>
        )}
        {agentPaneKeys.length > 0 && <span className="agent-hint">Agent output in terminal above</span>}
        {activeTerminalState?.session.exited && <span className="terminal-exited">Terminal exited</span>}
      </div>
    </div>
  )
}