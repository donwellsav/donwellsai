import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { agentPresentation } from '@shared/agent-presentation'
import { useAppStore, type Pane } from '../store'
import { Icon } from './Icon'
import { NavigationControls } from './NavigationControls'

// Stable references: zustand v5 compares snapshots by identity — an inline `?? []`
// creates a fresh array per call and re-renders forever (React error #185).
const EMPTY_PANES: Pane[] = []

function paneLabel(pane: Pane, fallbackTerminalOrdinal: number): string {
  if (pane.label) return pane.label
  if (pane.kind === 'preview' || pane.kind === 'diff') {
    const file = pane.file?.split(/[\\/]/).pop() ?? 'file'
    return pane.kind === 'diff' ? `${file} · ${pane.comparison ?? 'working'} diff` : file
  }
  if (pane.kind === 'browser') return pane.url?.replace(/^https?:\/\//, '').split('/')[0] ?? 'Browser'
  return `Terminal ${fallbackTerminalOrdinal}`
}

/** Compact, reorderable pane tabs. Stable terminal labels are independent of OSC titles. */
export function TitlebarTabs() {
  const activeWorktreePath = useAppStore((state) => state.activeWorktreePath)
  const panes = useAppStore((state) => (activeWorktreePath ? state.panes[activeWorktreePath] ?? EMPTY_PANES : EMPTY_PANES))
  const activePane = useAppStore((state) => (activeWorktreePath ? state.activePane[activeWorktreePath] ?? '' : ''))
  const terminals = useAppStore((state) => state.terminals)
  const runningAgents = useAppStore((state) => state.runningAgents)
  const setActivePane = useAppStore((state) => state.setActivePane)
  const openTerminal = useAppStore((state) => state.openTerminal)
  const openBrowser = useAppStore((state) => state.openBrowser)
  const requestClosePane = useAppStore((state) => state.requestClosePane)
  const reorderPane = useAppStore((state) => state.reorderPane)
  const renamePane = useAppStore((state) => state.renamePane)
  const [urlOpen, setUrlOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  const [renamingKey, setRenamingKey] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const urlInputRef = useRef<HTMLInputElement>(null)
  const urlPopoverRef = useRef<HTMLDivElement>(null)
  const urlButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!urlOpen) return
    const frame = requestAnimationFrame(() => urlInputRef.current?.focus())
    const dismissOutside = (event: PointerEvent): void => {
      if (urlPopoverRef.current && !event.composedPath().includes(urlPopoverRef.current)) setUrlOpen(false)
    }
    const dismissFromBlur = (): void => setUrlOpen(false)
    document.addEventListener('pointerdown', dismissOutside)
    window.addEventListener('blur', dismissFromBlur)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('pointerdown', dismissOutside)
      window.removeEventListener('blur', dismissFromBlur)
    }
  }, [urlOpen])

  if (!activeWorktreePath) return <NavigationControls />
  const tabs = panes.filter((pane) => pane.kind === 'terminal' || pane.kind === 'preview' || pane.kind === 'browser' || pane.kind === 'diff')
  const terminalOrdinals = new Map<string, number>()
  let terminalOrdinal = 0
  for (const pane of tabs) {
    if (pane.kind === 'terminal') terminalOrdinals.set(pane.key, ++terminalOrdinal)
  }

  const openUrl = (): void => {
    const nextUrl = url.trim()
    if (nextUrl) openBrowser(activeWorktreePath, nextUrl)
    setUrl('')
    setUrlOpen(false)
  }

  const focusTab = (index: number): void => {
    const target = tabs[index]
    if (!target) return
    setActivePane(activeWorktreePath, target.key)
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-pane-tab="${CSS.escape(target.key)}"]`)?.focus())
  }

  const handleTabKey = (event: ReactKeyboardEvent, index: number, pane: Pane): void => {
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      focusTab((index + 1) % tabs.length)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      focusTab((index - 1 + tabs.length) % tabs.length)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusTab(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusTab(tabs.length - 1)
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      requestClosePane(activeWorktreePath, pane.key)
    }
  }

  const commitRename = (pane: Pane): void => {
    renamePane(activeWorktreePath, pane.key, renameDraft)
    setRenamingKey(null)
  }

  return (
    <>
      <NavigationControls />
      <div className="titlebar-tab-list" role="tablist" aria-label="Open panes">
        {tabs.map((pane, index) => {
          const label = paneLabel(pane, terminalOrdinals.get(pane.key) ?? 1)
          const session = pane.sessionId ? terminals[pane.sessionId]?.session : null
          const agent = pane.sessionId ? runningAgents[pane.sessionId] : undefined
          const presentation = agent ? agentPresentation(agent) : null
          const agentPhase = presentation
            ? presentation.tone === 'working'
              ? 'working'
              : presentation.tone === 'done'
                ? 'done'
                : 'permission'
            : null
          const icon: Parameters<typeof Icon>[0]['name'] =
            pane.kind === 'browser' ? 'globe' : pane.kind === 'diff' ? 'git' : pane.kind === 'preview' ? 'file' : 'terminal'
          const liveTitle = session?.title && session.title !== label ? `${label} — ${session.title}` : pane.file ?? label
          return (
            <div
              key={pane.key}
              className={`strip-tab${pane.key === activePane ? ' active' : ''}${draggingKey === pane.key ? ' dragging' : ''}`}
              draggable={renamingKey !== pane.key}
              onDragStart={(event) => {
                setDraggingKey(pane.key)
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', pane.key)
              }}
              onDragEnd={() => setDraggingKey(null)}
              onDragOver={(event) => {
                if (draggingKey && draggingKey !== pane.key) event.preventDefault()
              }}
              onDrop={(event) => {
                event.preventDefault()
                if (!draggingKey || draggingKey === pane.key) return
                reorderPane(activeWorktreePath, draggingKey, pane.key)
                setDraggingKey(null)
              }}
            >
              {renamingKey === pane.key ? (
                <input
                  className="strip-tab-rename"
                  value={renameDraft}
                  maxLength={80}
                  aria-label="Pane label"
                  autoFocus
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onBlur={() => commitRename(pane)}
                  onKeyDown={(event) => {
                    event.stopPropagation()
                    if (event.key === 'Enter') commitRename(pane)
                    if (event.key === 'Escape') setRenamingKey(null)
                  }}
                />
              ) : (
                <button
                  className="strip-tab-select"
                  role="tab"
                  data-pane-tab={pane.key}
                  aria-label={presentation ? `${label}, agent ${presentation.label}` : label}
                  aria-selected={pane.key === activePane}
                  tabIndex={pane.key === activePane ? 0 : -1}
                  title={liveTitle}
                  onClick={() => setActivePane(activeWorktreePath, pane.key)}
                  onDoubleClick={() => {
                    setRenameDraft(label)
                    setRenamingKey(pane.key)
                  }}
                  onKeyDown={(event) => handleTabKey(event, index, pane)}
                >
                  <Icon name={icon} size={14} />
                  <span className="strip-tab-label">{label}</span>
                  {agentPhase && <span className={`strip-dot strip-dot-${agentPhase}`} title={presentation?.description} />}
                </button>
              )}
              <button
                className="strip-tab-close"
                aria-label={`Close ${label}`}
                title="Close pane"
                onClick={() => requestClosePane(activeWorktreePath, pane.key)}
              >
                <Icon name="x" size={10} />
              </button>
              {pane.key === activePane && <span className="strip-active-bar" />}
            </div>
          )
        })}
      </div>
      <button className="strip-button" title="New terminal" aria-label="New terminal" onClick={() => void openTerminal(activeWorktreePath)}>
        <Icon name="plus" size={16} />
      </button>
      <div ref={urlPopoverRef} className="url-popover-anchor">
        <button
          ref={urlButtonRef}
          className={`strip-button${urlOpen ? ' active' : ''}`}
          title="Open browser tab"
          aria-label="Open browser tab"
          aria-expanded={urlOpen}
          aria-haspopup="dialog"
          onClick={() => setUrlOpen(!urlOpen)}
        >
          <Icon name="globe" size={16} />
        </button>
        {urlOpen && (
          <div
            className="url-popover"
            role="dialog"
            aria-label="Open browser tab"
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key !== 'Escape') return
              event.preventDefault()
              setUrlOpen(false)
              requestAnimationFrame(() => urlButtonRef.current?.focus())
            }}
          >
            <input
              ref={urlInputRef}
              className="input url-popover-input"
              placeholder="https://…"
              value={url}
              aria-label="Address"
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') openUrl()
                if (event.key === 'Escape') setUrlOpen(false)
              }}
            />
            <button className="btn btn-primary btn-sm" disabled={!url.trim()} onClick={openUrl}>Open</button>
          </div>
        )}
      </div>
    </>
  )
}
