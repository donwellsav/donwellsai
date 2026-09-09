import { Icon } from './Icon'
import { useCallback, useId, useMemo, useRef, useState } from 'react'
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
import { contextMenuKey, focusContextMenu } from '../context-menu'

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
  const recentMenuId = useId()
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

  const openRecentMenu = useCallback((menu: HTMLDivElement | null): void => {
    if (!menu || !rootRef.current) return
    const anchor = rootRef.current.getBoundingClientRect()
    menu.style.left = `${Math.max(8, anchor.right - menu.offsetWidth)}px`
    menu.style.top = `${anchor.bottom + 4}px`
    focusContextMenu(menu)
  }, [])

  const backShortcut = shortcutFor('navigate-back')
  const forwardShortcut = shortcutFor('navigate-forward')
  const mruShortcut = shortcutFor('switch-mru-next')

  return (
    <div className="navigation-controls" ref={rootRef} aria-label="Navigation history">
      <button
        type="button"
        className={`navigation-control navigation-recent-trigger${recentOpen ? ' active' : ''}`}
        disabled={recent.length === 0 && !capabilities.canGoBack && !capabilities.canGoForward}
        aria-label="Recent locations"
        aria-haspopup="menu"
        aria-expanded={recentOpen}
        title={`Workspace history: back, forward and recent locations${mruShortcut ? ` · switch with ${mruShortcut}` : ''}`}
        popoverTarget={recentMenuId}
      >
        <Icon name="history" />
      </button>
        <div id={recentMenuId} className="navigation-recent-menu" popover="auto" onToggle={event => { const open = event.newState === 'open'; setRecentOpen(open); if (open) openRecentMenu(event.currentTarget) }} onKeyDown={event => contextMenuKey(event, () => { event.currentTarget.hidePopover(); rootRef.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus() })} role="menu" aria-label="Recent locations">
          <button type="button" role="menuitem" className="navigation-recent-item" disabled={!capabilities.canGoBack} onClick={() => { document.getElementById(recentMenuId)?.hidePopover(); void navigateHistory(-1) }}>Back{backShortcut ? ` (${backShortcut})` : ''}</button>
          <button type="button" role="menuitem" className="navigation-recent-item" disabled={!capabilities.canGoForward} onClick={() => { document.getElementById(recentMenuId)?.hidePopover(); void navigateHistory(1) }}>Forward{forwardShortcut ? ` (${forwardShortcut})` : ''}</button>
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
                  document.getElementById(recentMenuId)?.hidePopover()
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
                document.getElementById(recentMenuId)?.hidePopover()
                void switchNavigationMru(1)
              }}
            >
              Switch to next recent location
            </button>
          ) : null}
        </div>
    </div>
  )
}
