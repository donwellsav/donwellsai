import { Icon } from './Icon'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { agentPresentation, agentProviderName } from '@shared/agent-presentation'
import { APP_COMMANDS, appCommandPlatform, formatAppShortcut } from '@shared/app-commands'
import { commandUnavailableReason, dispatchAppCommand, pinnedWorktree } from '../commands'
import type { CommandContext } from '../commands'
import {
  getPaletteFileScope,
  globalNavigatorFileCache,
  requestPaletteFileScope,
  subscribePaletteFileScope,
  type NavigatorFileSearchSnapshot,
  type NavigatorFileSearchProvider,
  type NavigatorFileSearchTask,
  type NavigatorWorkspaceSearch,
  type PaletteFileScope
} from '../global-navigator'
import { focusRetainedAgentSession } from '../navigation-controller'
import { pathBasename } from '../workspace-navigation'
import { fuzzyMatch } from '../fuzzy'
import { useAppStore } from '../store'
import { workspacePaneLabel } from '../workspace-layout'
import { ModalDialog } from './ModalDialog'

export type PaletteItem = {
  id: string
  label: string
  detail?: string
  hint?: string
  shortcut?: string
  disabledReason?: string
  score: number
  hits: number[]
  run(): void
}

const EMPTY_MRU: string[] = []
const EMPTY_FILE_SEARCH: NavigatorFileSearchSnapshot = Object.freeze({ matches: [], errors: [], pending: 0, localOnly: false })
const MAX_PALETTE_ITEMS = 100
const MAX_LOCAL_FILE_CANDIDATES = 1_024

const workspaceFileSearchProvider: NavigatorFileSearchProvider = (workspacePath, request) =>
  window.donwells.searchWorkspaceFiles(workspacePath, request)
const MAX_METADATA_CANDIDATES = 320

function Highlighted({ label, hits }: { label: string; hits: number[] }): ReactNode {
  if (hits.length === 0) return label
  const positions = new Set(hits)
  return [...label].map((character, index) => positions.has(index) ? <mark key={index}>{character}</mark> : character)
}

function itemOrder(left: PaletteItem, right: PaletteItem): number {
  return Number(Boolean(left.disabledReason)) - Number(Boolean(right.disabledReason))
    || right.score - left.score
    || left.label.localeCompare(right.label)
}

function mergePaletteItems(...groups: readonly PaletteItem[][]): PaletteItem[] {
  const byId = new Map<string, PaletteItem>()
  for (const group of groups) {
    for (const item of group) {
      const previous = byId.get(item.id)
      if (!previous || item.score > previous.score) byId.set(item.id, item)
    }
  }
  return [...byId.values()].sort(itemOrder).slice(0, MAX_PALETTE_ITEMS)
}

export function CommandPalette({ open }: { open: boolean }) {
  const mode = useAppStore((state) => state.paletteMode)
  const setOpen = useAppStore((state) => state.setPaletteOpen)
  const repos = useAppStore((state) => state.repos)
  const agents = useAppStore((state) => state.agents)
  const runningAgents = useAppStore((state) => state.runningAgents)
  const settings = useAppStore((state) => state.settings)
  const activeWorktreePath = useAppStore((state) => state.activeWorktreePath)
  const explorerRecord = useAppStore((state) => state.explorer)
  const fileSearchMru = useAppStore((state) => state.fileSearchMru)
  const activeRepoId = useAppStore((state) => state.activeRepoId)
  const panes = useAppStore((state) => state.panes)
  const activePane = useAppStore((state) => state.activePane)
  const runsOpen = useAppStore((state) => state.runsOpen)
  const context = useMemo<CommandContext>(() => ({ repos, activeRepoId, activeWorktreePath, panes, activePane, runsOpen, settings }),
    [repos, activeRepoId, activeWorktreePath, panes, activePane, runsOpen, settings])
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string>()
  const [requestedScope, setRequestedScope] = useState<PaletteFileScope>(getPaletteFileScope)
  const [fileSearch, setFileSearch] = useState<NavigatorFileSearchSnapshot>(EMPTY_FILE_SEARCH)
  const inputRef = useRef<HTMLInputElement>(null)

  const prefixGlobal = mode === 'files' && query.startsWith('@')
  const scope: PaletteFileScope = prefixGlobal ? 'global' : requestedScope
  const fileQuery = prefixGlobal ? query.slice(1).trimStart() : query
  const workspaces = useMemo(() => repos.flatMap((repo) => {
    const repoLabel = pathBasename(repo.repo.path)
    return repo.worktrees.map((worktree) => ({
      repoId: repo.repo.id,
      repoLabel,
      workspacePath: worktree.path,
      workspaceLabel: pathBasename(worktree.path)
    }))
  }), [repos])

  useEffect(() => {
    globalNavigatorFileCache.reconcileAuthorizedWorkspaces(
      new Set(workspaces.map((workspace) => workspace.workspacePath))
    )
  }, [workspaces])

  useEffect(() => subscribePaletteFileScope((nextScope) => {
    setRequestedScope(nextScope)
    setSelectedId(undefined)
    setFileSearch(EMPTY_FILE_SEARCH)
  }), [])

  useEffect(() => {
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.repos !== previous.repos) {
        const authorized = new Set(state.repos.flatMap((repo) => repo.worktrees.map((worktree) => worktree.path)))
        globalNavigatorFileCache.reconcileAuthorizedWorkspaces(authorized)
        for (const workspacePath of authorized) globalNavigatorFileCache.invalidateWorkspace(workspacePath)
      }
      if (state.explorer !== previous.explorer) {
        const paths = new Set([...Object.keys(state.explorer), ...Object.keys(previous.explorer)])
        for (const workspacePath of paths) {
          if (state.explorer[workspacePath] !== previous.explorer[workspacePath]) {
            globalNavigatorFileCache.invalidateWorkspace(workspacePath)
          }
        }
      }
      if (state.fileSearchMru !== previous.fileSearchMru) {
        const paths = new Set([...Object.keys(state.fileSearchMru), ...Object.keys(previous.fileSearchMru)])
        for (const workspacePath of paths) {
          if (state.fileSearchMru[workspacePath] !== previous.fileSearchMru[workspacePath]) {
            globalNavigatorFileCache.invalidateWorkspace(workspacePath)
          }
        }
      }
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelectedId(undefined)
    setFileSearch(EMPTY_FILE_SEARCH)
    queueMicrotask(() => inputRef.current?.focus())
  }, [mode, open])

  useEffect(() => {
    if (!open || mode !== 'files') return
    if (scope === 'active' && !activeWorktreePath) {
      setFileSearch(EMPTY_FILE_SEARCH)
      return
    }
    // Global empty/one-character queries stay local; scanning every project for
    // discovery traffic would turn each keystroke into a filesystem fan-out.
    if (scope === 'global' && fileQuery.trim().length < 2) {
      setFileSearch(EMPTY_FILE_SEARCH)
      return
    }

    let cancelled = false
    let task: NavigatorFileSearchTask | undefined
    setFileSearch(EMPTY_FILE_SEARCH)
    const handle = window.setTimeout(() => {
      const candidates = scope === 'active'
        ? workspaces.filter((workspace) => workspace.workspacePath === activeWorktreePath)
        : workspaces
      const searches: NavigatorWorkspaceSearch[] = candidates.map((workspace) => {
        const explorer = explorerRecord[workspace.workspacePath]
        return {
          repoId: workspace.repoId,
          workspacePath: workspace.workspacePath,
          workspaceLabel: workspace.workspaceLabel,
          request: {
            query: fileQuery,
            maxResults: 100,
            mruPaths: fileSearchMru[workspace.workspacePath] ?? EMPTY_MRU,
            showHidden: explorer?.showHidden ?? false,
            includeIgnored: explorer?.includeIgnored ?? false
          }
        }
      })
      task = globalNavigatorFileCache.search(
        searches,
        workspaceFileSearchProvider,
        (snapshot) => {
          if (!cancelled) setFileSearch(snapshot)
        }
      )
      setFileSearch(task.initial)
      void task.done.then((snapshot) => {
        if (!cancelled) setFileSearch(snapshot)
      })
    }, scope === 'global' ? 160 : 70)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
      task?.cancel()
    }
  }, [activeWorktreePath, explorerRecord, fileQuery, fileSearchMru, mode, open, scope, workspaces])

  const commandItems = useMemo<PaletteItem[]>(() => {
    if (!open || mode !== 'commands') return []
    const items: PaletteItem[] = []
    const normalizedQuery = query.trim()
    const platform = appCommandPlatform(navigator.platform || navigator.userAgent)
    for (const command of APP_COMMANDS) {
      if (!command.palette) continue
      const match = fuzzyMatch(command.label + ' ' + command.category, normalizedQuery)
      if (!match) continue
      const shortcut = settings.keyboardShortcutOverrides[command.id] ?? command.defaultAccelerators[0]
      items.push({
        id: 'command:' + command.id,
        label: command.label,
        hint: command.category,
        shortcut: shortcut ? formatAppShortcut(shortcut, platform) : undefined,
        disabledReason: commandUnavailableReason(command.id, context),
        score: match.score,
        hits: match.hits.filter((index) => index < command.label.length),
        run: () => dispatchAppCommand(command.id)
      })
    }
    for (const agent of agents) {
      const label = 'Run agent: ' + agent.name
      const match = fuzzyMatch(label, normalizedQuery)
      if (!match) continue
      // Agent identity is no longer a command string: a run starts from the
      // default provider instance, exactly like the `run-agent` command.
      const defaultInstanceId = useAppStore.getState().providerCatalog?.defaultInstanceId ?? null
      items.push({
        id: 'agent-preset:' + agent.name,
        label,
        hint: agent.command,
        disabledReason: !agent.available ? `${agent.name} is not installed on this host.` : defaultInstanceId === null ? 'Choose a default provider instance in Settings → Agents.' : pinnedWorktree(context) ? undefined : 'Select a registered workspace first.',
        score: match.score,
        hits: match.hits,
        run: () => {
          const worktreePath = pinnedWorktree()
          if (worktreePath && defaultInstanceId !== null) void useAppStore.getState().launchProviderInstance(worktreePath, defaultInstanceId)
        }
      })
    }
    return items.sort(itemOrder).slice(0, MAX_PALETTE_ITEMS)
  }, [agents, context, mode, open, query, settings.keyboardShortcutOverrides])

  const localFileItems = useMemo<PaletteItem[]>(() => {
    if (!open || mode !== 'files') return []
    const candidates = scope === 'active'
      ? workspaces.filter((workspace) => workspace.workspacePath === activeWorktreePath)
      : workspaces
    const items: PaletteItem[] = []
    let visited = 0
    for (const workspace of candidates) {
      const recent = [
        ...(panes[workspace.workspacePath] ?? []).flatMap((pane) => pane.kind === 'preview' && pane.file ? [pane.file] : []),
        ...(fileSearchMru[workspace.workspacePath] ?? EMPTY_MRU)
      ]
      const seen = new Set<string>()
      for (const path of recent) {
        if (seen.has(path)) continue
        seen.add(path)
        visited += 1
        if (visited > MAX_LOCAL_FILE_CANDIDATES) return items.sort(itemOrder).slice(0, MAX_PALETTE_ITEMS)
        const match = fuzzyMatch(path, fileQuery)
        if (!match) continue
        items.push({
          id: `file:${workspace.workspacePath}:${path}`,
          label: path,
          hint: scope === 'global' ? workspace.workspaceLabel : 'Recent file',
          score: 1_400 + match.score,
          hits: match.hits,
          run: () => {
            const state = useAppStore.getState()
            state.setActiveWorktree(workspace.workspacePath)
            void state.openPreview(workspace.workspacePath, path)
          }
        })
      }
    }
    return items.sort(itemOrder).slice(0, MAX_PALETTE_ITEMS)
  }, [activeWorktreePath, fileQuery, fileSearchMru, mode, open, panes, scope, workspaces])

  const globalMetadataItems = useMemo<PaletteItem[]>(() => {
    if (!open || mode !== 'files' || scope !== 'global') return []
    const items: PaletteItem[] = []
    const normalizedQuery = fileQuery.trim()
    const add = (item: PaletteItem): void => {
      let low = 0
      let high = items.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (itemOrder(item, items[middle]!) < 0) high = middle
        else low = middle + 1
      }
      if (low < MAX_METADATA_CANDIDATES) items.splice(low, 0, item)
      if (items.length > MAX_METADATA_CANDIDATES) items.pop()
    }
    for (const repo of repos) {
      const repoLabel = pathBasename(repo.repo.path)
      const label = `Project · ${repoLabel}`
      const match = fuzzyMatch(`${label} ${repo.repo.path}`, normalizedQuery)
      if (match) add({
        id: 'project:' + repo.repo.id,
        label,
        detail: repo.repo.path,
        hint: repo.repo.kind === 'folder' ? 'Folder project' : 'Git project',
        score: 3_000 + match.score,
        hits: match.hits.filter((index) => index < label.length),
        run: () => {
          const state = useAppStore.getState()
          const workspacePath = repo.worktrees.find((worktree) => worktree.isMain)?.path ?? repo.worktrees[0]?.path
          if (workspacePath) state.setActiveWorktree(workspacePath)
          else state.setActiveRepo(repo.repo.id)
        }
      })
      for (const worktree of repo.worktrees) {
        const workspaceLabel = pathBasename(worktree.path)
        const workspaceTitle = `Workspace · ${workspaceLabel}`
        const workspaceMatch = fuzzyMatch(`${workspaceTitle} ${repoLabel} ${worktree.branch}`, normalizedQuery)
        if (!workspaceMatch) continue
        add({
          id: 'workspace:' + worktree.path,
          label: workspaceTitle,
          detail: worktree.path,
          hint: repoLabel,
          score: 2_900 + workspaceMatch.score,
          hits: workspaceMatch.hits.filter((index) => index < workspaceTitle.length),
          run: () => {
            const state = useAppStore.getState()
            state.setActiveWorktree(worktree.path)
          }
        })
      }
    }

    const agentSessionIds = new Set(Object.keys(runningAgents))
    for (const run of Object.values(runningAgents)) {
      const presentation = agentPresentation(run)
      const workspaceLabel = pathBasename(run.workspacePath)
      const label = `${agentProviderName(run)} session · ${workspaceLabel}`
      const match = fuzzyMatch(`${label} ${presentation.label} ${presentation.description} ${run.command}`, normalizedQuery)
      if (!match) continue
      add({
        id: 'agent-session:' + run.sessionId,
        label,
        detail: presentation.description,
        hint: presentation.label,
        score: 3_100 + match.score,
        hits: match.hits.filter((index) => index < label.length),
        run: () => void focusRetainedAgentSession(run.sessionId)
      })
    }

    for (const workspace of workspaces) {
      for (const pane of panes[workspace.workspacePath] ?? []) {
        if (pane.sessionId && agentSessionIds.has(pane.sessionId)) continue
        const title = workspacePaneLabel(pane)
        const prefix = pane.kind === 'preview' ? 'Open file' : pane.kind === 'browser' ? 'Browser' : pane.kind === 'diff' ? 'Diff' : undefined
        const label = prefix ? `${prefix} · ${title}` : title
        const match = fuzzyMatch(`${label} ${workspace.workspaceLabel} ${pane.file ?? ''} ${pane.url ?? ''}`, normalizedQuery)
        if (!match) continue
        add({
          id: `pane:${workspace.workspacePath}:${pane.key}`,
          label,
          detail: pane.file ?? pane.url ?? workspace.workspacePath,
          hint: workspace.workspaceLabel,
          score: 2_700 + match.score,
          hits: match.hits.filter((index) => index < label.length),
          run: () => {
            const state = useAppStore.getState()
            state.setActiveWorktree(workspace.workspacePath)
            state.setActivePane(workspace.workspacePath, pane.key)
          }
        })
      }
    }
    return items.slice(0, MAX_PALETTE_ITEMS)
  }, [fileQuery, mode, open, panes, repos, runningAgents, scope, workspaces])

  const remoteFileItems = useMemo<PaletteItem[]>(() => fileSearch.matches.map(({ workspacePath, workspaceLabel, match }) => ({
    id: `file:${workspacePath}:${match.entry.path}`,
    label: match.entry.path,
    hint: scope === 'global' ? workspaceLabel : 'File',
    score: match.score,
    hits: match.hits,
    run: () => {
      const state = useAppStore.getState()
      state.setActiveWorktree(workspacePath)
      void state.openPreview(workspacePath, match.entry.path)
    }
  })), [fileSearch.matches, scope])

  const items = mode === 'commands'
    ? commandItems
    : mergePaletteItems(globalMetadataItems, localFileItems, remoteFileItems)
  const selectedIndex = selectedId ? items.findIndex((item) => item.id === selectedId) : -1
  const cursor = selectedIndex >= 0 ? selectedIndex : items.findIndex((item) => !item.disabledReason)

  useEffect(() => {
    if (items.length === 0) {
      if (selectedId !== undefined) setSelectedId(undefined)
      return
    }
    if (selectedId && items.some((item) => item.id === selectedId)) return
    setSelectedId(items.find((item) => !item.disabledReason)?.id ?? items[0]?.id)
  }, [items, selectedId])

  useEffect(() => {
    if (open && cursor >= 0) document.getElementById('palette-item-' + cursor)?.scrollIntoView({ block: 'nearest' })
  }, [cursor, open, selectedId])

  if (!open) return null

  const run = (item: PaletteItem | undefined): void => {
    if (!item || item.disabledReason) return
    setOpen(false)
    item.run()
  }

  const moveCursor = (direction: -1 | 1): void => {
    if (items.length === 0) return
    let index = cursor < 0 ? (direction === 1 ? -1 : 0) : cursor
    for (let visited = 0; visited < items.length; visited += 1) {
      index = (index + direction + items.length) % items.length
      const item = items[index]
      if (item && !item.disabledReason) {
        setSelectedId(item.id)
        return
      }
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveCursor(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const candidates = event.key === 'Home' ? items : [...items].reverse()
      setSelectedId(candidates.find((item) => !item.disabledReason)?.id)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      run(cursor >= 0 ? items[cursor] : undefined)
    }
  }

  const title = mode === 'commands' ? 'Command Palette' : scope === 'global' ? 'Global Navigator' : 'Quick Open'
  const listLabel = mode === 'commands' ? 'Commands' : scope === 'global' ? 'All projects and files' : 'Workspace files'
  const placeholder = mode === 'commands'
    ? 'Type a command'
    : scope === 'global'
      ? 'Search projects, workspaces, sessions, panes, and files'
      : 'Search files by name or path · prefix @ for everywhere'

  return (
    <ModalDialog className="palette-dialog" labelledBy="palette-title" onClose={() => setOpen(false)}>
      <div className="palette">
        <header className="palette-header">
          <h2 id="palette-title">{title}</h2>
          <div className="palette-modes" role="group" aria-label="Search mode">
            <button type="button" aria-pressed={mode === 'commands'} onClick={() => setOpen(true, 'commands')}>Commands</button>
            <button
              type="button"
              aria-pressed={mode === 'files' && scope === 'active'}
              disabled={Boolean(commandUnavailableReason('quick-open', context))}
              title={commandUnavailableReason('quick-open', context)}
              onClick={() => {
                requestPaletteFileScope('active')
                setOpen(true, 'files')
              }}
            >Workspace</button>
            <button
              type="button"
              aria-pressed={mode === 'files' && scope === 'global'}
              disabled={repos.length === 0}
              onClick={() => {
                requestPaletteFileScope('global')
                setOpen(true, 'files')
              }}
            >Everywhere</button>
          </div>
          <button type="button" className="icon-btn palette-close" aria-label="Close palette" title="Close command search and return to your workspace" onClick={() => setOpen(false)}><Icon name="x" /></button>
        </header>
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          maxLength={256}
          onChange={(event) => {
            setQuery(event.currentTarget.value)
            setSelectedId(undefined)
            setFileSearch(EMPTY_FILE_SEARCH)
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-label={listLabel}
          aria-controls="palette-results"
          aria-activedescendant={cursor >= 0 ? 'palette-item-' + cursor : undefined}
        />
        <div id="palette-results" className="palette-list" role="listbox" aria-label={listLabel}>
          {mode === 'files' && scope === 'active' && !activeWorktreePath ? <div className="palette-empty">Open a workspace to search files.</div> : null}
          {mode === 'files' && scope === 'global' && fileQuery.trim().length < 2 && items.length === 0 ? (
            <div className="palette-empty">Type at least two characters to search files across every registered workspace.</div>
          ) : null}
          {items.map((item, index) => (
            <button
              id={'palette-item-' + index}
              type="button"
              role="option"
              aria-selected={index === cursor}
              aria-disabled={Boolean(item.disabledReason)}
              tabIndex={-1}
              key={item.id}
              className={'palette-item ' + (index === cursor ? 'selected' : '')}
              onMouseEnter={() => setSelectedId(item.id)}
              onClick={() => run(item)}
            >
              <span className="palette-label">
                <Highlighted label={item.label} hits={item.hits} />
                {item.disabledReason ? <small>{item.disabledReason}</small> : item.detail ? <small>{item.detail}</small> : null}
              </span>
              {item.shortcut ? <kbd className="palette-hint">{item.shortcut}</kbd> : item.hint ? <span className="palette-hint" title={item.hint}>{item.hint}</span> : null}
            </button>
          ))}
          {mode === 'files' && fileSearch.pending > 0 ? (
            <div className="palette-notice" role="status">Searching {fileSearch.pending} workspace{fileSearch.pending === 1 ? '' : 's'}…</div>
          ) : null}
          {mode === 'files' ? fileSearch.errors.slice(0, 4).map((error) => (
            <div className="palette-error" role="alert" key={error.workspacePath}>{error.workspaceLabel}: {error.message}</div>
          )) : null}
          {mode === 'files' && fileSearch.errors.length > 4 ? (
            <div className="palette-error" role="alert">{fileSearch.errors.length - 4} additional workspaces could not be searched.</div>
          ) : null}
          {mode === 'files' && fileSearch.pending === 0 && items.length === 0 && !(scope === 'global' && fileQuery.trim().length < 2) ? (
            <div className="palette-empty">No matching locations.</div>
          ) : null}
          {mode === 'commands' && items.length === 0 ? <div className="palette-empty">No matching commands.</div> : null}
        </div>
        <footer className="palette-footer">
          <span>↑ ↓ Navigate · Enter Open · Esc Close{mode === 'files' && scope === 'active' ? ' · @ Everywhere' : ''}</span>
          <span>{items.length} results{fileSearch.localOnly && fileSearch.pending > 0 ? ' · updating' : ''}</span>
        </footer>
      </div>
    </ModalDialog>
  )
}
