import { useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { useAppStore, isMarkdownFile, layoutHasLeaf, type LayoutNode, type Pane } from '../store'
import { TerminalPane } from './TerminalPane'
import { MediaPreviewRouter } from './MediaPreviewRouter'
import { DiffPane } from './DiffPane'

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
  const pct = Math.min(85, Math.max(15, node.size ?? 50))
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
  const resizeFromKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 10 : 4
    let next: number | undefined
    if (event.key === 'Home') next = 15
    else if (event.key === 'End') next = 85
    else if (node.dir === 'row' && event.key === 'ArrowLeft') next = pct - step
    else if (node.dir === 'row' && event.key === 'ArrowRight') next = pct + step
    else if (node.dir === 'col' && event.key === 'ArrowUp') next = pct - step
    else if (node.dir === 'col' && event.key === 'ArrowDown') next = pct + step
    if (next === undefined) return
    event.preventDefault()
    onResize(id, Math.min(85, Math.max(15, next)))
  }
  return (
    <div className={`split split-${node.dir}`}>
      <div className="split-side" style={{ flex: `0 0 ${pct}%` }}>
        <LayoutNodeView node={node.first} render={render} onResize={onResize} counter={counter} />
      </div>
      <div
        className="split-divider"
        data-dir={node.dir}
        role="separator"
        tabIndex={0}
        aria-label={node.dir === 'row' ? 'Resize panes left and right' : 'Resize panes above and below'}
        aria-orientation={node.dir === 'row' ? 'vertical' : 'horizontal'}
        aria-valuemin={15}
        aria-valuemax={85}
        aria-valuenow={Math.round(pct)}
        aria-valuetext={`${Math.round(pct)} percent for the first pane`}
        title="Drag or use arrow keys to resize. Double-click to balance."
        onDoubleClick={() => onResize(id, 50)}
        onKeyDown={resizeFromKeyboard}
        onMouseDown={startDrag}
      />
      <div className="split-side">
        <LayoutNodeView node={node.second} render={render} onResize={onResize} counter={counter} />
      </div>
    </div>
  )
}

/**
 * Center workbench: the ACTIVE worktree's terminal/preview panes laid out by the
 * split tree (flat = single active pane; split = every leaf visible, upstream's
 * TabGroupSplitLayout).
 */
export function Workbench() {
  const activeWorktreePath = useAppStore((s) => s.activeWorktreePath)
  const paneRecord = useAppStore((s) => s.panes)
  const panes = activeWorktreePath ? paneRecord[activeWorktreePath] ?? EMPTY_PANES : EMPTY_PANES
  const layout = useAppStore((s) => (activeWorktreePath ? s.layouts[activeWorktreePath] : undefined))
  const activePaneKey = useAppStore((s) => (activeWorktreePath ? s.activePane[activeWorktreePath] ?? '' : ''))
  const visibleLayout = layout && layoutHasLeaf(layout, activePaneKey) ? layout : undefined
  const terminals = useAppStore((s) => s.terminals)
  const runningAgents = useAppStore((s) => s.runningAgents)
  const stopAgent = useAppStore((state) => state.stopAgent)
  const dismissAgent = useAppStore((state) => state.dismissAgent)
  const setActivePane = useAppStore((state) => state.setActivePane)
  const requestClosePane = useAppStore((state) => state.requestClosePane)
  const closePreview = useAppStore((state) => state.closePreview)
  const retargetPreview = useAppStore((s) => s.retargetPreview)
  const previewsForWt = useAppStore((s) => (s.activeWorktreePath ? s.previews[s.activeWorktreePath] : undefined))
  const openFiles = Object.keys(previewsForWt ?? {})
  const setPreviewMode = useAppStore((s) => s.setPreviewMode)
  const splitTerminal = useAppStore((s) => s.splitTerminal)
  const resizeSplit = useAppStore((s) => s.resizeSplit)

  if (!activeWorktreePath) return null

  const labelOf = (pane: Pane): string => {
    if (pane.label) return pane.label
    if (pane.kind === 'preview' || pane.kind === 'diff') return pane.file?.split('/').pop() ?? 'File'
    if (pane.kind === 'browser') return pane.url?.replace(/^https?:\/\//, '').split('/')[0] ?? 'Browser'
    return 'Terminal'
  }

  const renderPane = (paneKey: string): ReactNode => {
    const pane = panes.find((p) => p.key === paneKey)
    if (!pane) return null
    const isActive = pane.key === activePaneKey
    return (
      <div
        className={'pane' + (isActive ? ' pane-active' : '')}
        data-pane-key={pane.key}
        data-pane-kind={pane.kind}
        tabIndex={-1}
        onFocus={() => setActivePane(activeWorktreePath, paneKey)}
        onMouseDown={() => setActivePane(activeWorktreePath, paneKey)}
      >
        {pane.kind !== 'diff' && pane.kind !== 'browser' && <div className="pane-title-bar">
          {pane.kind === 'preview' && pane.file ? (
            <div className="editor-tabs" role="tablist">
              {openFiles.map((rel) => {
                const name = rel.split('/').pop() ?? rel
                const parts = rel.split('/')
                const dup = openFiles.filter((o) => o.split('/').pop() === name).length > 1
                const active = pane.file === rel
                return (
                  <div key={rel} className={`editor-tab${active ? ' active' : ''}`}>
                    <button role="tab" aria-selected={active} className="editor-tab-select" title={rel} onClick={(event) => {
                      event.stopPropagation()
                      if (!active) void retargetPreview(activeWorktreePath, pane.key, rel)
                    }}>
                      <span className="editor-tab-name">{dup ? parts.slice(-2).join('/') : name}</span>
                    </button>
                    <button className="editor-tab-close" aria-label={`Close ${name}`} onClick={(event) => {
                      event.stopPropagation()
                      void closePreview(activeWorktreePath, rel)
                    }}>×</button>
                  </div>
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
              aria-label={(previewsForWt?.[pane.file]?.mode ?? 'edit') === 'preview' ? 'Edit Markdown source' : 'Preview rendered Markdown'}
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
            <span className="pane-split-actions" aria-label="Split terminal">
              <button className="icon-btn" title="Split terminal right" aria-label="Split terminal right" onClick={() => void splitTerminal(activeWorktreePath, 'row')}>
                <Icon name="columns" size={11} />
              </button>
              <button className="icon-btn" title="Split terminal down" aria-label="Split terminal down" onClick={() => void splitTerminal(activeWorktreePath, 'col')}>
                <Icon name="split" size={11} />
              </button>
            </span>
          )}
          {/* Hook state is informational. Permission decisions stay in the provider's own UI. */}
          {pane.kind === 'terminal' && pane.sessionId && runningAgents[pane.sessionId] && (() => {
            const agent = runningAgents[pane.sessionId]!
            const terminalAgent = agent.command.trim().split(' ')[0] || agent.presetId || 'agent'
            const settled = agent.liveness === 'exited'
            const busy = agent.activity === 'starting' || agent.activity === 'working' || agent.activity === 'stopping'
            const stateLabel = agent.liveness === 'unverifiable'
              ? agent.activity + ' · liveness unavailable'
              : agent.liveness === 'exited'
                ? agent.exitCode === undefined ? 'exited' : 'exited ' + agent.exitCode
                : agent.activity
            return (
              <span
                className={'agent-chip agent-state-' + agent.activity + ' agent-liveness-' + agent.liveness}
                title={agent.detail ? stateLabel + ' · ' + agent.detail : stateLabel}
                onClick={(event) => event.stopPropagation()}
              >
                {busy && <span className="spinner" />}
                {agent.activity === 'permission' && <span className="state-icon state-permission" />}
                {agent.activity === 'waiting' && <Icon name="clock" size={10} />}
                {agent.activity === 'completed' && <Icon name="check" size={10} />}
                {agent.activity === 'failed' && <Icon name="alert" size={10} />}
                <span className="agent-cmd">{agent.presetId ?? terminalAgent}</span>
                <span className="agent-state-label">{stateLabel}</span>
                <button
                  className="icon-btn"
                  aria-label={settled ? 'Dismiss agent status' : agent.activity === 'stopping' ? 'Stopping agent' : 'Stop agent'}
                  title={settled ? 'Dismiss agent status' : agent.activity === 'stopping' ? 'Stopping agent…' : 'Stop agent'}
                  disabled={!settled && (agent.activity === 'stopping' || agent.liveness !== 'live')}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (settled) void dismissAgent(agent.sessionId)
                    else void stopAgent(agent.sessionId)
                  }}
                >
                  {settled ? <Icon name="x" size={10} /> : <Icon name="stop" size={10} />}
                </button>
              </span>
            )
          })()}
          <button
            className="icon-btn danger"
            aria-label={`Close ${labelOf(pane)}`}
            title="Close pane"
            onClick={(e) => {
              e.stopPropagation()
              requestClosePane(activeWorktreePath, paneKey)
            }}
          >
            <Icon name="x" size={11} />
          </button>
        </div>}
        {pane.kind === 'browser' && pane.url ? (
          <div className="browser-pane-slot" data-browser-worktree={activeWorktreePath} />
        ) : (
          <div className={`pane-body-terminal${isActive || !!visibleLayout ? '' : ' terminal-hidden'}`}>
            {pane.kind === 'terminal' && pane.sessionId && terminals[pane.sessionId] ? (
              <TerminalPane
                sessionId={pane.sessionId}
                cols={terminals[pane.sessionId]!.cols}
                rows={terminals[pane.sessionId]!.rows}
                isActive={!!visibleLayout || isActive}
              />
            ) : pane.kind === 'preview' && pane.file ? (
              <MediaPreviewRouter worktreePath={activeWorktreePath} relPath={pane.file} />
            ) : pane.kind === 'diff' && pane.file ? (
              <DiffPane worktreePath={activeWorktreePath} relPath={pane.file} comparison={pane.comparison} />
            ) : null}
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="workbench">
      {visibleLayout ? (
        <LayoutTree node={visibleLayout} render={renderPane} onResize={(splitId, pct) => resizeSplit(activeWorktreePath, splitId, pct)} />
      ) : (
        panes
          .filter((p) => p.kind === 'terminal' || p.kind === 'preview' || p.kind === 'browser' || p.kind === 'diff')
          .map((p) => <div key={`${activeWorktreePath}:${p.key}`} className={p.key === activePaneKey ? '' : 'terminal-hidden'}>{renderPane(p.key)}</div>)
      )}
    </div>
  )
}
