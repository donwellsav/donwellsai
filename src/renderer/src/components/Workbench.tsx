import { useRef, type ReactNode } from 'react'
import { useAppStore, isMarkdownFile, type LayoutNode, type Pane } from '../store'
import { TerminalPane } from './TerminalPane'
import { EditorPane } from './EditorPane'
import { BrowserPane } from './BrowserPane'
import { Icon } from './Icon'

// Stable references for selectors: zustand v5 compares snapshots by identity, so a
// fresh `?? []` per call would re-render in an infinite loop (React error #185).
const EMPTY_PANES: Pane[] = []

/**
 * Recursive split-tree renderer (upstream TabGroupLayoutNode shape). Split
 * nodes carry a first-child percent; the divider is a live drag handle.
 */
function LayoutTree({ node, render, onResize }: { node: LayoutNode; render: (paneKey: string) => ReactNode; onResize: (splitId: number, pct: number) => void }) {
  const counter = useRef({ n: 0 })
  counter.current.n = 0
  return <LayoutNodeView node={node} render={render} onResize={onResize} counter={counter.current} />
}

function LayoutNodeView({ node, render, onResize, counter }: { node: LayoutNode; render: (paneKey: string) => ReactNode; onResize: (splitId: number, pct: number) => void; counter: { n: number } }) {
  if (node.kind === 'leaf') return <>{render(node.pane)}</>
  const id = counter.n++
  const pct = node.size ?? 50
  const startDrag = (e: React.MouseEvent): void => {
    e.preventDefault()
    const container = e.currentTarget.parentElement as HTMLElement
    const rect = container.getBoundingClientRect()
    const move = (ev: MouseEvent): void => {
      const raw = node.dir === 'row'
        ? ((ev.clientX - rect.left) / rect.width) * 100
        : ((ev.clientY - rect.top) / rect.height) * 100
      onResize(id, raw)
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  return (
    <div className={`split split-${node.dir}`}>
      <div className="split-side" style={{ flex: `0 0 ${pct}%` }}>
        <LayoutNodeView node={node.first} render={render} onResize={onResize} counter={counter} />
      </div>
      <div className="split-divider" data-dir={node.dir} onMouseDown={startDrag} />
      <div className="split-side">
        <LayoutNodeView node={node.second} render={render} onResize={onResize} counter={counter} />
      </div>
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
  const closePreview = useAppStore((s) => s.closePreview)
  const retargetPreview = useAppStore((s) => s.retargetPreview)
  const previewsForWt = useAppStore((s) => (s.activeWorktreePath ? s.previews[s.activeWorktreePath] : undefined))
  const openFiles = Object.keys(previewsForWt ?? {})
  const setPreviewMode = useAppStore((s) => s.setPreviewMode)
  const splitTerminal = useAppStore((s) => s.splitTerminal)
  const openTerminal = useAppStore((s) => s.openTerminal)
  const resizeSplit = useAppStore((s) => s.resizeSplit)

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
          {pane.kind === 'preview' && pane.file ? (
            <div className="editor-tabs" role="tablist">
              {openFiles.map((rel) => {
                const name = rel.split('/').pop() ?? rel
                const parts = rel.split('/')
                const dup = openFiles.filter((o) => o.split('/').pop() === name).length > 1
                const active = pane.file === rel
                return (
                  <button
                    key={rel}
                    role="tab"
                    aria-selected={active}
                    className={`editor-tab${active ? ' active' : ''}`}
                    title={rel}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (!active) void retargetPreview(activeWorktreePath, pane.key, rel)
                    }}
                  >
                    <span className="editor-tab-name">{dup ? parts.slice(-2).join('/') : name}</span>
                    <span
                      className="editor-tab-close"
                      role="button"
                      title={`Close ${name}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        closePreview(activeWorktreePath, rel)
                      }}
                    >
                      ×
                    </span>
                  </button>
                )
              })}
            </div>
          ) : (
            <>
              <Icon name={pane.kind === 'preview' ? 'file' : 'terminal'} size={11} />
              <span className="pane-title">{labelOf(pane)}</span>
            </>
          )}
          {pane.kind === 'preview' && pane.file && isMarkdownFile(pane.file) && (
            <button
              className="icon-btn"
              title={(previewsForWt?.[pane.file]?.mode ?? 'edit') === 'preview' ? 'Edit source (⌘⇧V)' : 'Rendered preview (⌘⇧V)'}
              onClick={(e) => {
                e.stopPropagation()
                const file = pane.file!
                const cur = previewsForWt?.[file]?.mode ?? 'edit'
                setPreviewMode(activeWorktreePath, file, cur === 'preview' ? 'edit' : 'preview')
              }}
            >
              <Icon name={(previewsForWt?.[pane.file]?.mode ?? 'edit') === 'preview' ? 'edit' : 'eye'} size={11} />
            </button>
          )}
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
          <BrowserPane worktreePath={activeWorktreePath} url={pane.url} onClose={() => closePane(activeWorktreePath, pane.key)} />
        ) : (
          <div className={`pane-body-terminal${isActive || !!layout ? '' : ' terminal-hidden'}`}>
            {pane.kind === 'terminal' && pane.sessionId && terminals[pane.sessionId] ? (
              <TerminalPane
                sessionId={pane.sessionId}
                cols={terminals[pane.sessionId]!.cols}
                rows={terminals[pane.sessionId]!.rows}
                isActive={!!layout || isActive}
              />
            ) : pane.kind === 'preview' && pane.file ? (
              <EditorPane worktreePath={activeWorktreePath} relPath={pane.file} />
            ) : null}
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="workbench">
      {layout ? (
        <LayoutTree node={layout} render={renderPane} onResize={(splitId, pct) => resizeSplit(activeWorktreePath, splitId, pct)} />
      ) : (
        panes
          .filter((p) => p.kind === 'terminal' || p.kind === 'preview' || p.kind === 'browser')
          .map((p) => <div key={p.key} className={p.key === activePaneKey ? '' : 'terminal-hidden'}>{renderPane(p.key)}</div>)
      )}
    </div>
  )
}
