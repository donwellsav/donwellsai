import { useEffect, useMemo, useRef, useState } from 'react'
import {
  appCommandPlatform,
  formatAppShortcut,
  resolveAppShortcuts,
  type AppCommandId
} from '@shared/app-commands'
import type { NavigationTarget } from '@shared/navigation-history'
import {
  activateRecentNavigationTarget,
  getNavigationCapabilities,
  navigateHistory,
  navigationTargetAvailable,
  switchNavigationMru,
  useNavigationHistoryState
} from '../navigation-controller'
import { pathBasename, pathParentLabel } from '../workspace-navigation'
import { useAppStore, type Pane } from '../store'
import './navigation-controls.css'

function ArrowIcon({ direction }: { direction: 'left' | 'right' }) {
  const path = direction === 'left' ? 'M10.5 3.5L6 8l4.5 4.5' : 'M5.5 3.5L10 8l-4.5 4.5'
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={path} />
    </svg>
  )
}

function RecentIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2a6 6 0 106 6M8 4.5V8l2.5 1.5M2 2v4h4" />
    </svg>
  )
}

function paneFor(target: NavigationTarget, panes: Record<string, Pane[]>): Pane | undefined {
  return target.kind === 'workspace'
    ? undefined
    : panes[target.worktreePath]?.find((pane) => pane.key === target.paneKey)
}

function targetLabel(target: NavigationTarget, panes: Record<string, Pane[]>): { label: string; detail: string } {
  const pane = paneFor(target, panes)
  const workspace = pathBasename(target.worktreePath)
  if (target.kind === 'workspace') return { label: workspace, detail: pathParentLabel(target.worktreePath) }
  if (target.kind === 'file') {
    const location = target.location?.line ? `:${target.location.line}${target.location.column ? `:${target.location.column}` : ''}` : ''
    return { label: pathBasename(target.file) + location, detail: `${workspace} · ${target.file}` }
  }
  if (target.kind === 'terminal') return { label: pane?.label ?? 'Terminal', detail: workspace }
  if (target.kind === 'browser') return { label: pane?.label ?? 'Browser', detail: `${workspace} · ${pane?.url ?? 'Embedded browser'}` }
  return { label: pane?.label ?? `${pathBasename(target.file)} diff`, detail: `${workspace} · ${target.file}` }
}

export function NavigationControls() {
  const history = useNavigationHistoryState()
  const activeRepoId = useAppStore((state) => state.activeRepoId)
  const repos = useAppStore((state) => state.repos)
  const panes = useAppStore((state) => state.panes)
  const terminals = useAppStore((state) => state.terminals)
  const settings = useAppStore((state) => state.settings)
  const [recentOpen, setRecentOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const platform = appCommandPlatform(navigator.platform || navigator.userAgent)
  const shortcuts = useMemo(() => resolveAppShortcuts(settings.keyboardShortcutOverrides, platform).shortcuts,
    [platform, settings.keyboardShortcutOverrides])
  const shortcutFor = (commandId: AppCommandId): string | undefined => {
    const shortcut = shortcuts.find((candidate) => candidate.command.id === commandId)?.shortcut
    return shortcut ? formatAppShortcut(shortcut, platform) : undefined
  }

  const capabilities = useMemo(
    () => getNavigationCapabilities(),
    [activeRepoId, history, panes, repos, terminals]
  )
  const recent = (activeRepoId ? history.projects[activeRepoId]?.mru ?? [] : [])
    .filter((target) => navigationTargetAvailable(target))
    .slice(0, 8)

  useEffect(() => {
    if (!recentOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current && !event.composedPath().includes(rootRef.current)) setRecentOpen(false)
    }
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setRecentOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [recentOpen])

  const backShortcut = shortcutFor('navigate-back')
  const forwardShortcut = shortcutFor('navigate-forward')
  const mruShortcut = shortcutFor('switch-mru-next')

  return (
    <div className="navigation-controls" ref={rootRef} aria-label="Navigation history">
      <div className="navigation-control-pair">
        <button
          type="button"
          className="navigation-control"
          disabled={!capabilities.canGoBack}
          aria-label="Go back"
          title={`Go back${backShortcut ? ` (${backShortcut})` : ''}`}
          onClick={() => void navigateHistory(-1)}
        >
          <ArrowIcon direction="left" />
        </button>
        <button
          type="button"
          className="navigation-control"
          disabled={!capabilities.canGoForward}
          aria-label="Go forward"
          title={`Go forward${forwardShortcut ? ` (${forwardShortcut})` : ''}`}
          onClick={() => void navigateHistory(1)}
        >
          <ArrowIcon direction="right" />
        </button>
      </div>
      <button
        type="button"
        className={`navigation-control navigation-recent-trigger${recentOpen ? ' active' : ''}`}
        disabled={recent.length === 0}
        aria-label="Recent locations"
        aria-haspopup="menu"
        aria-expanded={recentOpen}
        title={`Recent locations${mruShortcut ? ` · switch with ${mruShortcut}` : ''}`}
        onClick={() => setRecentOpen((open) => !open)}
      >
        <RecentIcon />
        <span className="navigation-control-caret" aria-hidden="true">▾</span>
      </button>
      {recentOpen ? (
        <div className="navigation-recent-menu" role="menu" aria-label="Recent locations">
          <div className="navigation-recent-heading">
            <span>Recent locations</span>
            {mruShortcut ? <kbd>{mruShortcut}</kbd> : null}
          </div>
          {recent.map((target) => {
            const presentation = targetLabel(target, panes)
            return (
              <button
                type="button"
                role="menuitem"
                className="navigation-recent-item"
                key={`${target.kind}\u0000${target.worktreePath}\u0000${target.kind === 'workspace' ? '' : target.paneKey}`}
                onClick={() => {
                  setRecentOpen(false)
                  void activateRecentNavigationTarget(target)
                }}
              >
                <span>{presentation.label}</span>
                <small>{presentation.detail}</small>
              </button>
            )
          })}
          {capabilities.canSwitchMru ? (
            <button
              type="button"
              role="menuitem"
              className="navigation-recent-switch"
              onClick={() => {
                setRecentOpen(false)
                void switchNavigationMru(1)
              }}
            >
              Switch to next recent location
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
