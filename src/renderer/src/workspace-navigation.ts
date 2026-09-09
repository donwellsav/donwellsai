import type { RepoSummary } from '@shared/types'

export type WorkspaceNavigationState = {
  collapsedRepoIds: string[]
  pinnedPaths: string[]
  order: string[]
  renames: Record<string, string>
  hiddenPaths: string[]
}

export const EMPTY_WORKSPACE_NAVIGATION: WorkspaceNavigationState = Object.freeze({
  collapsedRepoIds: [],
  pinnedPaths: [],
  order: [],
  renames: {},
  hiddenPaths: []
})

type PartialWorkspaceNavigation = Partial<WorkspaceNavigationState> | null | undefined

function uniqueExisting(values: readonly string[] | undefined, valid: ReadonlySet<string>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values ?? []) {
    if (!valid.has(value) || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

export function workspacePaths(repos: readonly RepoSummary[]): string[] {
  return repos.flatMap((repo) => repo.worktrees.map((worktree) => worktree.path))
}

export function normalizeWorkspaceNavigation(
  value: PartialWorkspaceNavigation,
  repos: readonly RepoSummary[]
): WorkspaceNavigationState {
  const validPaths = new Set(workspacePaths(repos))
  const validRepoIds = new Set(repos.map((repo) => repo.repo.id))
  const renames: Record<string, string> = {}
  for (const [path, label] of Object.entries(value?.renames ?? {})) {
    const normalized = label.trim().replace(/\s+/g, ' ').slice(0, 80)
    if (validPaths.has(path) && normalized) renames[path] = normalized
  }
  return {
    collapsedRepoIds: uniqueExisting(value?.collapsedRepoIds, validRepoIds),
    pinnedPaths: uniqueExisting(value?.pinnedPaths, validPaths),
    order: uniqueExisting(value?.order, validPaths),
    renames,
    hiddenPaths: uniqueExisting(value?.hiddenPaths, validPaths)
  }
}

export function toggleNavigationValue(
  state: WorkspaceNavigationState,
  key: 'collapsedRepoIds' | 'pinnedPaths' | 'hiddenPaths',
  value: string
): WorkspaceNavigationState {
  const values = state[key]
  return {
    ...state,
    [key]: values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value]
  }
}

export function renameWorkspaceNavigation(
  state: WorkspaceNavigationState,
  path: string,
  label: string
): WorkspaceNavigationState {
  const renames = { ...state.renames }
  const normalized = label.trim().replace(/\s+/g, ' ').slice(0, 80)
  if (normalized) renames[path] = normalized
  else delete renames[path]
  return { ...state, renames }
}

export function restoreWorkspaceNavigation(
  state: WorkspaceNavigationState,
  path?: string
): WorkspaceNavigationState {
  return {
    ...state,
    hiddenPaths: path ? state.hiddenPaths.filter((entry) => entry !== path) : []
  }
}

export function orderedWorkspacePaths(
  repos: readonly RepoSummary[],
  state: WorkspaceNavigationState
): string[] {
  const existing = workspacePaths(repos)
  const valid = new Set(existing)
  const ordered = state.order.filter((path) => valid.has(path))
  const included = new Set(ordered)
  for (const path of existing) {
    if (!included.has(path)) ordered.push(path)
  }
  const rank = (repo: RepoSummary): number => Math.min(...repo.worktrees.map(worktree => ordered.indexOf(worktree.path)))
  const pinned = (repo: RepoSummary): boolean => repo.worktrees.some(worktree => state.pinnedPaths.includes(worktree.path))
  return [...repos].sort((a, b) => Number(pinned(b)) - Number(pinned(a)) || rank(a) - rank(b)).flatMap(repo =>
    repo.worktrees.map(worktree => worktree.path).sort((a, b) => Number(state.pinnedPaths.includes(b)) - Number(state.pinnedPaths.includes(a)) || ordered.indexOf(a) - ordered.indexOf(b)))
}

export function moveWorkspaceNavigation(
  state: WorkspaceNavigationState,
  repos: readonly RepoSummary[],
  path: string,
  delta: -1 | 1
): WorkspaceNavigationState {
  const order = orderedWorkspacePaths(repos, state)
  const repo = repos.find(repo => repo.worktrees.some(worktree => worktree.path === path))
  if (!repo || state.hiddenPaths.includes(path)) return state
  const pinned = state.pinnedPaths.includes(path)
  if (repo.worktrees.length === 1) {
    const groups = [...repos].sort((a, b) => order.indexOf(a.worktrees[0]?.path ?? '') - order.indexOf(b.worktrees[0]?.path ?? ''))
      .map(repo => order.filter(path => repo.worktrees.some(worktree => worktree.path === path)))
    const visible = groups.filter(group => group.some(path => !state.hiddenPaths.includes(path)) && group.some(path => state.pinnedPaths.includes(path)) === pinned)
    const from = visible.findIndex(group => group.includes(path)), to = from + delta
    if (from < 0 || to < 0 || to >= visible.length) return state
    const first = groups.indexOf(visible[from]!), second = groups.indexOf(visible[to]!)
    ;[groups[first], groups[second]] = [groups[second]!, groups[first]!]
    return { ...state, order: groups.flat() }
  }
  const siblings = order.filter(path => repo.worktrees.some(worktree => worktree.path === path) && !state.hiddenPaths.includes(path) && state.pinnedPaths.includes(path) === pinned)
  const from = siblings.indexOf(path), to = from + delta
  if (from < 0 || to < 0 || to >= siblings.length) return state
  const next = [...order], first = next.indexOf(path), second = next.indexOf(siblings[to]!)
  ;[next[first], next[second]] = [next[second]!, next[first]!]
  return { ...state, order: next }
}

export function pathBasename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  const parts = normalized.split(/[\\/]/)
  return parts[parts.length - 1] || normalized
}

export function pathParentLabel(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  const parts = normalized.split(/[\\/]/)
  return parts.length > 1 ? parts[parts.length - 2]! : normalized
}
