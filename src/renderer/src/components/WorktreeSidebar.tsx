import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { RepoSummary, Worktree, WorktreeStatus } from '@shared/types'
import { appCommand, appCommandPlatform, formatAppShortcut } from '@shared/app-commands'
import type { AppCommandId } from '@shared/app-commands'
import { agentForWorkspace, agentNeedsAttention, agentPresentation } from '@shared/agent-presentation'
import { dispatchAppCommand } from '../commands'
import { ProjectActions } from './ProjectActions'
import { useAppStore } from '../store'
import {
  orderedWorkspacePaths,
  pathBasename,
  pathParentLabel,
  type WorkspaceNavigationState
} from '../workspace-navigation'
import { Icon } from './Icon'

type WorkspaceEntry = { repo: RepoSummary; worktree: Worktree }

function gitStatusLabel(status: WorktreeStatus | undefined, folder: boolean): string {
  if (folder) return 'Folder workspace — source control is not enabled'
  if (!status) return 'Source control status is loading'
  if (status.conflicts > 0) return `${status.conflicts} conflict${status.conflicts === 1 ? '' : 's'}`
  const changes = status.staged + status.modified + status.untracked
  if (changes === 0) return 'Working tree clean'
  const parts: string[] = []
  if (status.staged) parts.push(`${status.staged} staged`)
  if (status.modified) parts.push(`${status.modified} modified`)
  if (status.untracked) parts.push(`${status.untracked} untracked`)
  return parts.join(', ')
}

function StatusLane({ entry }: { entry: WorkspaceEntry }) {
  const runs = useAppStore((state) => state.runningAgents)
  const status = useAppStore((state) => state.statuses[entry.worktree.path])
  const run = agentForWorkspace(entry.worktree.path, runs)
  const agent = run ? agentPresentation(run) : null
  const folder = entry.repo.repo.kind === 'folder'
  const statusLabel = gitStatusLabel(status, folder)
  const dirty = !!status && status.staged + status.modified + status.untracked + status.conflicts > 0
  const statusClass = folder ? 'folder' : !status ? 'pending' : status.conflicts > 0 ? 'conflict' : dirty ? 'dirty' : 'clean'

  return (
    <span className="status-lane" title={agent ? `${agent.description} · ${statusLabel}` : statusLabel}>
      {agent?.tone === 'working' ? (
        <span className="agent-spin" aria-hidden="true" />
      ) : agent ? (
        <Icon name={agent.tone === 'done' ? 'check' : 'activity'} size={12} className={`workspace-agent-${agent.tone}`} />
      ) : (
        <span className={`dot ${statusClass}`} />
      )}
      <span className="sr-only">{agent?.label ?? statusLabel}</span>
    </span>
  )
}

function WorkspaceActions({
  entry,
  navigation,
  onRename,
  onClose
}: {
  entry: WorkspaceEntry
  navigation: WorkspaceNavigationState
  onRename: () => void
  onClose: () => void
}) {
  const path = entry.worktree.path
  const pinned = navigation.pinnedPaths.includes(path)
  const canDelete = entry.repo.repo.kind !== 'folder' && !entry.worktree.isMain
  const run = (action: () => void): void => {
    action()
    onClose()
  }

  return (
    <div className="workspace-actions-menu" role="menu" aria-label={`Actions for ${pathBasename(path)}`}>
      <button role="menuitem" onClick={() => run(() => useAppStore.getState().toggleWorkspacePinned(path))}>
        {pinned ? 'Unpin workspace' : 'Pin workspace'}
      </button>
      <button role="menuitem" onClick={() => run(onRename)}>Rename label…</button>
      <button role="menuitem" onClick={() => run(() => useAppStore.getState().moveWorkspace(path, -1))}>Move up</button>
      <button role="menuitem" onClick={() => run(() => useAppStore.getState().moveWorkspace(path, 1))}>Move down</button>
      <span className="workspace-actions-rule" />
      <button role="menuitem" onClick={() => run(() => useAppStore.getState().hideWorkspace(path))}>Hide from sidebar</button>
      {canDelete && (
        <button className="danger" role="menuitem" onClick={() => run(() => useAppStore.getState().setDeleteTarget(path))}>
          Move worktree to Trash…
        </button>
      )}
    </div>
  )
}

function WorktreeCardRow({
  entry,
  navigation,
  active,
  actionOpen,
  setActionOpen
}: {
  entry: WorkspaceEntry
  navigation: WorkspaceNavigationState
  active: boolean
  actionOpen: boolean
  setActionOpen: (open: boolean) => void
}) {
  const path = entry.worktree.path
  const customLabel = navigation.renames[path]
  const displayName = customLabel ?? pathBasename(path)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(displayName)
  const status = useAppStore((state) => state.statuses[path])
  const folder = entry.repo.repo.kind === 'folder'
  const branch = status?.branch || entry.worktree.branch
  const pinned = navigation.pinnedPaths.includes(path)

  const commitRename = (): void => {
    useAppStore.getState().renameWorkspace(path, draft)
    setRenaming(false)
  }

  return (
    <div className={`wt-card${active ? ' active' : ''}${actionOpen ? ' menu-open' : ''}`} data-worktree-card-active={active || undefined}>
      <button
        className="wt-card-main"
        data-workspace-row
        aria-current={active ? 'page' : undefined}
        title={path}
        onClick={() => useAppStore.getState().setActiveWorktree(path)}
        onDoubleClick={() => {
          setDraft(displayName)
          setRenaming(true)
        }}
      >
        <StatusLane entry={entry} />
        <span className="wt-card-copy">
          {renaming ? (
            <input
              className="input workspace-rename-input"
              value={draft}
              aria-label="Workspace label"
              maxLength={80}
              autoFocus
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                event.stopPropagation()
                if (event.key === 'Enter') commitRename()
                if (event.key === 'Escape') setRenaming(false)
              }}
            />
          ) : (
            <span className="wt-name">{displayName}</span>
          )}
          <span className="wt-meta">
            {folder ? (
              <><span className="badge badge-folder">folder</span><span>{pathParentLabel(path)}</span></>
            ) : (
              <>
                <Icon name="git" size={10} />
                <span className="wt-branch">{entry.worktree.detached ? `detached ${entry.worktree.head?.slice(0, 8) ?? ''}` : branch || 'branch unavailable'}</span>
                {entry.worktree.isMain && <span className="badge">main</span>}
              </>
            )}
          </span>
        </span>
        {pinned && <span className="workspace-pin" title="Pinned" aria-label="Pinned">•</span>}
      </button>
      <button
        className="ws-icon-btn workspace-more"
        aria-label={`Workspace actions for ${displayName}`}
        aria-expanded={actionOpen}
        onClick={() => setActionOpen(!actionOpen)}
      >
        ···
      </button>
      {actionOpen && (
        <WorkspaceActions
          entry={entry}
          navigation={navigation}
          onRename={() => {
            setDraft(displayName)
            setRenaming(true)
          }}
          onClose={() => setActionOpen(false)}
        />
      )}
    </div>
  )
}

function RepoSection({
  repo,
  entries,
  navigation,
  query,
  actionPath,
  setActionPath
}: {
  repo: RepoSummary
  entries: WorkspaceEntry[]
  navigation: WorkspaceNavigationState
  query: string
  actionPath: string | null
  setActionPath: (path: string | null) => void
}) {
  const activeWorktreePath = useAppStore((state) => state.activeWorktreePath)
  const collapsed = !query && navigation.collapsedRepoIds.includes(repo.repo.id)
  const folder = repo.repo.kind === 'folder'
  const repoLabel = pathBasename(repo.repo.path)

  if (!entries.length && query) return null
  return (
    <section className="repo-section" aria-label={repoLabel}>
      <div className="section-header">
        <button
          className="repo-collapse"
          aria-expanded={!collapsed}
          title={collapsed ? `Expand ${repoLabel}` : `Collapse ${repoLabel}`}
          onClick={() => useAppStore.getState().toggleRepoCollapsed(repo.repo.id)}
        >
          <Icon name="chevrons" size={11} className={collapsed ? '' : 'expanded'} />
          <span className="section-icon">{folder ? <Icon name="dir" size={10} /> : repoLabel.slice(0, 2).toUpperCase()}</span>
          <span className="section-copy">
            <span className="section-title" title={repo.repo.path}>{repoLabel}</span>
            <span className="section-count">{entries.length} {entries.length === 1 ? 'workspace' : 'workspaces'}</span>
          </span>
        </button>
        {!folder && (
          <button
            className="ws-icon-btn"
            title={`New worktree in ${repoLabel}`}
            aria-label={`New worktree in ${repoLabel}`}
            onClick={() => {
              useAppStore.getState().setActiveRepo(repo.repo.id)
              dispatchAppCommand('new-worktree')
            }}
          >
            <Icon name="plus" size={12} />
          </button>
        )}
        <ProjectActions repo={repo} />
      </div>
      {!collapsed && entries.map((entry) => (
        <WorktreeCardRow
          key={entry.worktree.path}
          entry={entry}
          navigation={navigation}
          active={entry.worktree.path === activeWorktreePath}
          actionOpen={actionPath === entry.worktree.path}
          setActionOpen={(open) => setActionPath(open ? entry.worktree.path : null)}
        />
      ))}
    </section>
  )
}

function HiddenWorkspaceRestore({ entries, onClose }: { entries: WorkspaceEntry[]; onClose: () => void }) {
  return (
    <div className="hidden-workspaces" role="dialog" aria-modal="false" aria-label="Hidden workspaces">
      <div className="hidden-workspaces-header">
        <strong>Hidden workspaces</strong>
        <button className="ws-icon-btn" aria-label="Close hidden workspaces" onClick={onClose}><Icon name="x" size={12} /></button>
      </div>
      {entries.map((entry) => (
        <div className="hidden-workspace-row" key={entry.worktree.path}>
          <span title={entry.worktree.path}>{pathBasename(entry.worktree.path)}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => useAppStore.getState().restoreWorkspace(entry.worktree.path)}>Restore</button>
        </div>
      ))}
      <button className="btn btn-secondary btn-sm" onClick={() => useAppStore.getState().restoreWorkspace()}>Restore all</button>
    </div>
  )
}

export function WorktreeSidebar() {
  const repos = useAppStore((state) => state.repos)
  const navigation = useAppStore((state) => state.workspaceNavigation)
  const runningAgents = useAppStore((state) => state.runningAgents)
  const sidebarWidth = useAppStore((state) => state.sidebarWidth)
  const settings = useAppStore((state) => state.settings)
  const runsOpen = useAppStore((state) => state.runsOpen)
  const runsSection = useAppStore((state) => state.runsSection)
  const platform = appCommandPlatform(navigator.platform || navigator.userAgent)
  const shortcutFor = (id: AppCommandId): string | null => {
    const chord = settings.keyboardShortcutOverrides[id] ?? appCommand(id)?.defaultAccelerators[0]
    return chord ? formatAppShortcut(chord, platform) : null
  }
  const [query, setQuery] = useState('')
  const activeWorktreePath = useAppStore((state) => state.activeWorktreePath)
  const [actionPath, setActionPath] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const normalizedQuery = query.trim().toLocaleLowerCase()

  const entriesByPath = useMemo(() => {
    const entries = new Map<string, WorkspaceEntry>()
    for (const repo of repos) {
      for (const worktree of repo.worktrees) entries.set(worktree.path, { repo, worktree })
    }
    return entries
  }, [repos])

  const orderedEntries = orderedWorkspacePaths(repos, navigation)
    .flatMap((path) => entriesByPath.get(path) ?? [])
  const matches = (entry: WorkspaceEntry): boolean => {
    if (!normalizedQuery) return true
    const path = entry.worktree.path
    return [
      navigation.renames[path],
      pathBasename(path),
      path,
      entry.worktree.branch,
      pathBasename(entry.repo.repo.path),
      entry.repo.repo.path
    ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery))
  }
  const visibleEntries = orderedEntries.filter((entry) => !navigation.hiddenPaths.includes(entry.worktree.path) && matches(entry))
  const pinnedEntries = visibleEntries.filter((entry) => navigation.pinnedPaths.includes(entry.worktree.path))
  const hiddenEntries = orderedEntries.filter((entry) => navigation.hiddenPaths.includes(entry.worktree.path))
  const attentionCount = Object.values(runningAgents).filter(agentNeedsAttention).length
  const hasGitProjects = repos.some((repo) => repo.repo.kind !== 'folder')

  const handleKeyboardNavigation = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.target instanceof HTMLInputElement) return
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-workspace-row]'))
    if (!rows.length) return
    const current = rows.indexOf(document.activeElement as HTMLButtonElement)
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? rows.length - 1
        : event.key === 'ArrowDown'
          ? Math.min(rows.length - 1, current + 1)
          : Math.max(0, current < 0 ? rows.length - 1 : current - 1)
    event.preventDefault()
    rows[nextIndex]?.focus()
  }

  return (
    <div
      className="sidebar"
      style={{ width: sidebarWidth }}
      onKeyDown={handleKeyboardNavigation}
      onMouseDown={(event) => {
        if (!(event.target as HTMLElement).closest('.workspace-actions-menu, .workspace-more')) setActionPath(null)
      }}
    >
      <div className="sidebar-nav">
        <label className="workspace-search">
          <Icon name="search" size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter workspaces" aria-label="Filter workspaces" />
          {query && <button aria-label="Clear workspace filter" onClick={() => setQuery('')}><Icon name="x" size={11} /></button>}
        </label>
        <div className="sidebar-shortcuts">
          <button className="nav-entry" disabled={!activeWorktreePath || runsOpen} title={!activeWorktreePath || runsOpen ? 'Open a workspace to browse files.' : 'Quick Open files'} onClick={() => dispatchAppCommand('quick-open')}>
            <Icon name="file" size={14} className="nav-entry-icon" /><span>Files</span><kbd>{shortcutFor('quick-open')}</kbd>
          </button>
          <button className="nav-entry" onClick={() => dispatchAppCommand('command-palette')}>
            <Icon name="search" size={14} className="nav-entry-icon" /><span>Commands</span><kbd>{shortcutFor('command-palette')}</kbd>
          </button>
        </div>
        <div className="sidebar-shortcuts">
          <button className="nav-entry" aria-current={runsOpen && runsSection === 'agents' ? 'page' : undefined} onClick={() => useAppStore.getState().openRuns('agents')}>
            <Icon name="activity" size={14} className="nav-entry-icon" /><span>Agents</span>
            {attentionCount > 0 && <span className="nav-entry-badge" title="Sessions needing attention" aria-label={`${attentionCount} need attention`}>{attentionCount}</span>}
          </button>
          <button className="nav-entry" aria-current={runsOpen && runsSection !== 'agents' ? 'page' : undefined} onClick={() => useAppStore.getState().openRuns('orchestration')}>
            <Icon name="clock" size={14} className="nav-entry-icon" /><span>Runs</span>
          </button>
        </div>
      </div>

      <div className="sidebar-scroll">
        <div className="sidebar-section-title"><span>Workspaces</span><span>{visibleEntries.length}</span></div>
        {repos.length === 0 ? (
          <div className="empty-note">No workspaces yet.<br />Add any folder or Git repository.</div>
        ) : visibleEntries.length === 0 ? (
          <div className="empty-note">{normalizedQuery ? 'No workspaces match this filter.' : 'All workspaces are hidden.'}</div>
        ) : (
          <>
            {pinnedEntries.length > 0 && (
              <section className="repo-section pinned-section" aria-label="Pinned workspaces">
                <div className="section-header pinned-header"><span className="section-title">Pinned</span><span className="section-count">{pinnedEntries.length}</span></div>
                {pinnedEntries.map((entry) => (
                  <WorktreeCardRow
                    key={`pinned:${entry.worktree.path}`}
                    entry={entry}
                    navigation={navigation}
                    active={entry.worktree.path === activeWorktreePath}
                    actionOpen={actionPath === entry.worktree.path}
                    setActionOpen={(open) => setActionPath(open ? entry.worktree.path : null)}
                  />
                ))}
              </section>
            )}
            {repos.map((repo) => (
              <RepoSection
                key={repo.repo.id}
                repo={repo}
                entries={visibleEntries.filter((entry) => entry.repo.repo.id === repo.repo.id && !navigation.pinnedPaths.includes(entry.worktree.path))}
                navigation={navigation}
                query={normalizedQuery}
                actionPath={actionPath}
                setActionPath={setActionPath}
              />
            ))}
          </>
        )}
      </div>

      <div className="sidebar-toolbar">
        <button className="ws-icon-btn" title={hasGitProjects ? 'New worktree' : 'Add a Git repository to create a worktree.'} aria-label="New worktree" disabled={!hasGitProjects} onClick={() => dispatchAppCommand('new-worktree')}><Icon name="plus" size={14} /></button>
        <button
          className="ws-icon-btn"
          title="Add folder or Git repository"
          onClick={() => dispatchAppCommand('add-repo')}
        ><Icon name="dir" size={14} /></button>
        {hiddenEntries.length > 0 && (
          <button className="hidden-workspaces-trigger" aria-expanded={showHidden} onClick={() => setShowHidden(!showHidden)}>
            {hiddenEntries.length} hidden
          </button>
        )}
        <span className="ws-spacer" />
        <button className="ws-icon-btn" title={`Settings${shortcutFor('settings') ? ' (' + shortcutFor('settings') + ')' : ''}`} aria-label="Settings" onClick={() => dispatchAppCommand('settings')}><Icon name="gear" size={14} /></button>
      </div>
      {showHidden && <HiddenWorkspaceRestore entries={hiddenEntries} onClose={() => setShowHidden(false)} />}
      <div
        className="sidebar-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize workspace sidebar"
        onMouseDown={(event) => {
          event.preventDefault()
          const startX = event.clientX
          const startWidth = sidebarWidth
          const move = (moveEvent: MouseEvent): void => useAppStore.getState().setSidebarWidth(startWidth + moveEvent.clientX - startX)
          const up = (): void => {
            window.removeEventListener('mousemove', move)
            window.removeEventListener('mouseup', up)
          }
          window.addEventListener('mousemove', move)
          window.addEventListener('mouseup', up)
        }}
      />
    </div>
  )
}
