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
  return ordered
}

export function moveWorkspaceNavigation(
  state: WorkspaceNavigationState,
  repos: readonly RepoSummary[],
  path: string,
  delta: -1 | 1
): WorkspaceNavigationState {
  const order = orderedWorkspacePaths(repos, state)
  const from = order.indexOf(path)
  const to = from + delta
  if (from < 0 || to < 0 || to >= order.length) return state
  const next = [...order]
  ;[next[from], next[to]] = [next[to]!, next[from]!]
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
