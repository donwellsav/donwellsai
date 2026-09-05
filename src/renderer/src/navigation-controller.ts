import { useEffect, useSyncExternalStore } from 'react'
import type { NavigationLocation, NavigationTarget } from '@shared/navigation-history'
import type { RepoSummary } from '@shared/types'
import { ensureNavigationHistoryInitialized, navigationHistoryAuthority, navigationHistoryAvailable, navigationMruAvailable, sameNavigationTarget } from './navigation-history'
import type { NavigationDirection, NavigationTargetPredicate } from './navigation-history'
import { persistSessionSoon, useAppStore } from './store'
import type { DocumentNavigationTarget, Pane } from './store'

export type NavigationCapabilities = {
  canGoBack: boolean
  canGoForward: boolean
  canSwitchMru: boolean
}

export type NavigationStoreSnapshot = {
  repos: readonly RepoSummary[]
  activeRepoId: string | null
  activeWorktreePath: string | null
  panes: Record<string, Pane[]>
  activePane: Record<string, string>
  terminals: Record<string, unknown>
  previews: Record<string, Record<string, unknown>>
  documentNavigation: Record<string, Record<string, DocumentNavigationTarget>>
  loading: boolean
  setActiveRepo(repoId: string | null): void
  setActiveWorktree(path: string | null): void
  setActivePane(worktreePath: string, key: string): void
  openPreview(worktreePath: string, relPath: string, navigation?: NavigationLocation): Promise<boolean>
  focusAgentSession(sessionId: string): Promise<boolean>
  setError(error: string | null): void
}

let installed = false
let lastObserved: NavigationTarget | undefined
let pendingObserved: NavigationTarget | undefined
let traversalDepth = 0

function navigationField(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return Reflect.get(value, 'navigationHistory')
}

function fileLocation(state: NavigationStoreSnapshot, worktreePath: string, file: string): NavigationLocation | undefined {
  const navigation = state.documentNavigation[worktreePath]?.[file]
  if (!navigation) return undefined
  const location: NavigationLocation = {
    ...(navigation.mode ? { mode: navigation.mode } : {}),
    ...(navigation.line ? { line: navigation.line } : {}),
    ...(navigation.column ? { column: navigation.column } : {}),
    ...(navigation.anchor !== undefined ? { anchor: navigation.anchor } : {})
  }
  return Object.keys(location).length > 0 ? location : undefined
}

export function activeNavigationTarget(state: NavigationStoreSnapshot = useAppStore.getState()): NavigationTarget | undefined {
  const repoId = state.activeRepoId
  const worktreePath = state.activeWorktreePath
  if (!repoId || !worktreePath) return undefined
  const repo = state.repos.find((candidate) => candidate.repo.id === repoId)
  if (!repo?.worktrees.some((worktree) => worktree.path === worktreePath)) return undefined
  const paneKey = state.activePane[worktreePath]
  const pane = paneKey ? state.panes[worktreePath]?.find((candidate) => candidate.key === paneKey) : undefined
  if (!pane || pane.kind === 'explorer' || pane.kind === 'git-status') return { repoId, worktreePath, kind: 'workspace' }
  if (pane.kind === 'terminal' && pane.sessionId) {
    return { repoId, worktreePath, kind: 'terminal', paneKey, sessionId: pane.sessionId }
  }
  if (pane.kind === 'preview' && pane.file) {
    const location = fileLocation(state, worktreePath, pane.file)
    return { repoId, worktreePath, kind: 'file', paneKey, file: pane.file, ...(location ? { location } : {}) }
  }
  if (pane.kind === 'browser') return { repoId, worktreePath, kind: 'browser', paneKey }
  if (pane.kind === 'diff' && pane.file) return { repoId, worktreePath, kind: 'diff', paneKey, file: pane.file }
  return { repoId, worktreePath, kind: 'workspace' }
}

export function navigationTargetAvailable(
  target: NavigationTarget,
  state: NavigationStoreSnapshot = useAppStore.getState()
): boolean {
  const repo = state.repos.find((candidate) => candidate.repo.id === target.repoId)
  if (!repo?.worktrees.some((worktree) => worktree.path === target.worktreePath)) return false
  const pane = target.kind === 'workspace'
    ? undefined
    : state.panes[target.worktreePath]?.find((candidate) => candidate.key === target.paneKey)
  switch (target.kind) {
    case 'workspace':
      return true
    case 'terminal':
      return pane?.kind === 'terminal' && pane.sessionId === target.sessionId && Boolean(state.terminals[target.sessionId])
    case 'file':
      return pane?.kind === 'preview' && pane.file === target.file && Boolean(state.previews[target.worktreePath]?.[target.file])
    case 'browser':
      return pane?.kind === 'browser'
    case 'diff':
      return pane?.kind === 'diff' && pane.file === target.file
  }
}

function waitForStoreLoad(): Promise<void> {
  if (!useAppStore.getState().loading) return Promise.resolve()
  const { promise, resolve } = Promise.withResolvers<void>()
  const unsubscribe = useAppStore.subscribe((state) => {
    if (state.loading) return
    unsubscribe()
    resolve()
  })
  return promise
}

function focusPaneTarget(target: NavigationTarget): void {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (target.kind === 'workspace') {
      document.querySelector<HTMLElement>('.workspace-stage')?.focus()
      return
    }
    const pane = document.querySelector<HTMLElement>(`[data-pane-key="${CSS.escape(target.paneKey)}"]`)
    if (!pane) return
    const selector = target.kind === 'terminal'
      ? '.xterm-helper-textarea'
      : target.kind === 'browser'
        ? 'webview'
        : '.monaco-editor textarea, .markdown-preview [tabindex], textarea'
    const focusable = pane.querySelector<HTMLElement>(selector)
    ;(focusable ?? pane).focus()
  }))
}

async function applyNavigationTarget(target: NavigationTarget): Promise<boolean> {
  if (!navigationTargetAvailable(target)) return false
  traversalDepth += 1
  try {
    const state = useAppStore.getState()
    if (state.activeRepoId !== target.repoId) state.setActiveRepo(target.repoId)
    if (useAppStore.getState().activeWorktreePath !== target.worktreePath) {
      useAppStore.getState().setActiveWorktree(target.worktreePath)
    }
    if (target.kind === 'file') {
      if (!(await useAppStore.getState().openPreview(target.worktreePath, target.file, target.location))) return false
    } else if (target.kind !== 'workspace') {
      useAppStore.getState().setActivePane(target.worktreePath, target.paneKey)
    }
    lastObserved = activeNavigationTarget()
    focusPaneTarget(target)
    return true
  } finally {
    traversalDepth -= 1
  }
}

async function restoreNavigationHistory(): Promise<void> {
  await Promise.all([
    ensureNavigationHistoryInitialized(async () => navigationField(await window.donwells.getWorkspaceSession())),
    waitForStoreLoad()
  ])
  const state = useAppStore.getState()
  const failure = navigationHistoryAuthority.getError()
  if (failure) {
    state.setError(`Navigation history was not restored: ${failure.message}`)
    return
  }

  const isAvailable: NavigationTargetPredicate = (target) => navigationTargetAvailable(target, state)
  navigationHistoryAuthority.reconcile(isAvailable)
  const current = pendingObserved ?? activeNavigationTarget(state)
  pendingObserved = undefined
  lastObserved = current
  if (current) navigationHistoryAuthority.record(current)
}

function ensureNavigationController(): void {
  if (installed) return
  installed = true
  lastObserved = activeNavigationTarget()
  navigationHistoryAuthority.subscribe((change) => {
    if (change !== 'restore' && navigationHistoryAuthority.getPhase() === 'ready') persistSessionSoon()
  })
  useAppStore.subscribe((state, previous) => {
    if (state.repos !== previous.repos || state.panes !== previous.panes || state.terminals !== previous.terminals) {
      if (navigationHistoryAuthority.getPhase() === 'ready') {
        navigationHistoryAuthority.reconcile((target) => navigationTargetAvailable(target, state))
      }
    }
    const current = activeNavigationTarget(state)
    if (navigationHistoryAuthority.getPhase() !== 'ready') {
      pendingObserved = current
      lastObserved = current
      return
    }
    if (traversalDepth > 0) {
      lastObserved = current
      return
    }
    if (current && (!lastObserved || !sameNavigationTarget(current, lastObserved))) {
      navigationHistoryAuthority.record(current)
    }
    lastObserved = current
  })
  void restoreNavigationHistory()
}

/** Mount once at the application root so all store-driven activations are observed. */
export function useNavigationHistoryController(): void {
  useEffect(() => {
    ensureNavigationController()
  }, [])
}

export function useNavigationHistoryState() {
  useEffect(() => {
    ensureNavigationController()
  }, [])
  return useSyncExternalStore(
    (listener) => navigationHistoryAuthority.subscribe(() => listener()),
    () => navigationHistoryAuthority.getSnapshot(),
    () => navigationHistoryAuthority.getSnapshot()
  )
}

export function getNavigationCapabilities(state: NavigationStoreSnapshot = useAppStore.getState()): NavigationCapabilities {
  const repoId = state.activeRepoId
  const current = activeNavigationTarget(state)
  const available = (target: NavigationTarget): boolean => navigationTargetAvailable(target, state)
  const history = navigationHistoryAuthority.getSnapshot()
  return {
    canGoBack: navigationHistoryAvailable(history, repoId, -1, available),
    canGoForward: navigationHistoryAvailable(history, repoId, 1, available),
    canSwitchMru: navigationMruAvailable(history, repoId, current, available)
  }
}

export async function navigateHistory(direction: NavigationDirection): Promise<boolean> {
  ensureNavigationController()
  const state = useAppStore.getState()
  const target = navigationHistoryAuthority.traverse(
    state.activeRepoId,
    direction,
    (candidate) => navigationTargetAvailable(candidate, state)
  )
  return target ? applyNavigationTarget(target) : false
}

export async function switchNavigationMru(direction: NavigationDirection): Promise<boolean> {
  ensureNavigationController()
  const state = useAppStore.getState()
  const target = navigationHistoryAuthority.cycleMru(
    state.activeRepoId,
    activeNavigationTarget(state),
    direction,
    (candidate) => navigationTargetAvailable(candidate, state)
  )
  return target ? applyNavigationTarget(target) : false
}

export async function activateRecentNavigationTarget(target: NavigationTarget): Promise<boolean> {
  ensureNavigationController()
  return applyNavigationTarget(target)
}

/** Retained sessions are adopted through the daemon-checking store action; never replaced. */
export async function focusRetainedAgentSession(sessionId: string): Promise<boolean> {
  ensureNavigationController()
  const focused = await useAppStore.getState().focusAgentSession(sessionId)
  if (!focused) return false
  const target = activeNavigationTarget()
  if (target) focusPaneTarget(target)
  return true
}
