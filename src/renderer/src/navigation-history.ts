import {
  MAX_NAVIGATION_ENTRIES,
  MAX_NAVIGATION_MRU,
  MAX_NAVIGATION_PROJECTS,
  NAVIGATION_HISTORY_VERSION,
  type NavigationTarget,
  type PersistedNavigationHistoryV1,
  type PersistedProjectNavigationHistory,
  validatePersistedNavigationHistory
} from '@shared/navigation-history'

export type NavigationDirection = -1 | 1
export type NavigationTargetPredicate = (target: NavigationTarget) => boolean

export const EMPTY_NAVIGATION_HISTORY: PersistedNavigationHistoryV1 = {
  version: NAVIGATION_HISTORY_VERSION,
  projectOrder: [],
  projects: {}
}

function copyTarget(target: NavigationTarget): NavigationTarget {
  return target.kind === 'file' && target.location
    ? { ...target, location: { ...target.location } }
    : { ...target }
}

export function sameNavigationTarget(left: NavigationTarget, right: NavigationTarget): boolean {
  if (left.repoId !== right.repoId || left.worktreePath !== right.worktreePath || left.kind !== right.kind) return false
  if (left.kind === 'workspace' || right.kind === 'workspace') return left.kind === right.kind
  if (left.paneKey !== right.paneKey) return false
  if (left.kind === 'terminal' && right.kind === 'terminal') return left.sessionId === right.sessionId
  if (left.kind === 'browser' && right.kind === 'browser') return true
  if (left.kind === 'diff' && right.kind === 'diff') return left.file === right.file
  if (left.kind !== 'file' || right.kind !== 'file' || left.file !== right.file) return false
  return left.location?.mode === right.location?.mode
    && left.location?.line === right.location?.line
    && left.location?.column === right.location?.column
    && left.location?.anchor === right.location?.anchor
}

/** MRU identity intentionally ignores a file's transient cursor/anchor location. */
function sameMruTarget(left: NavigationTarget, right: NavigationTarget): boolean {
  if (left.repoId !== right.repoId || left.worktreePath !== right.worktreePath || left.kind !== right.kind) return false
  if (left.kind === 'workspace' || right.kind === 'workspace') return left.kind === right.kind
  if (left.paneKey !== right.paneKey) return false
  if (left.kind === 'terminal' && right.kind === 'terminal') return left.sessionId === right.sessionId
  if (left.kind === 'file' && right.kind === 'file') return left.file === right.file
  if (left.kind === 'diff' && right.kind === 'diff') return left.file === right.file
  return left.kind === 'browser' && right.kind === 'browser'
}

function touchProject(projectOrder: readonly string[], repoId: string): string[] {
  return [repoId, ...projectOrder.filter((id) => id !== repoId)].slice(0, MAX_NAVIGATION_PROJECTS)
}

function withProject(
  state: PersistedNavigationHistoryV1,
  repoId: string,
  project: PersistedProjectNavigationHistory
): PersistedNavigationHistoryV1 {
  const projectOrder = touchProject(state.projectOrder, repoId)
  const projects = { ...state.projects, [repoId]: project }
  for (const existing of Object.keys(projects)) {
    if (!projectOrder.includes(existing)) delete projects[existing]
  }
  return { version: NAVIGATION_HISTORY_VERSION, projectOrder, projects }
}

export function recordNavigationTarget(
  state: PersistedNavigationHistoryV1,
  target: NavigationTarget
): PersistedNavigationHistoryV1 {
  const current = state.projects[target.repoId]
  if (current?.entries[current.cursor] && sameNavigationTarget(current.entries[current.cursor]!, target)) return state

  const previousEntries = current?.entries ?? []
  const cursor = current?.cursor ?? -1
  const entries = [...previousEntries.slice(0, cursor + 1), copyTarget(target)]
  if (entries.length > MAX_NAVIGATION_ENTRIES) entries.splice(0, entries.length - MAX_NAVIGATION_ENTRIES)
  const mru = [copyTarget(target), ...(current?.mru ?? []).filter((candidate) => !sameMruTarget(candidate, target))]
    .slice(0, MAX_NAVIGATION_MRU)
  return withProject(state, target.repoId, { entries, cursor: entries.length - 1, mru })
}

function availableHistoryIndex(
  project: PersistedProjectNavigationHistory | undefined,
  direction: NavigationDirection,
  isAvailable: NavigationTargetPredicate
): number {
  if (!project) return -1
  for (let index = project.cursor + direction; index >= 0 && index < project.entries.length; index += direction) {
    if (isAvailable(project.entries[index]!)) return index
  }
  return -1
}

export function navigationHistoryAvailable(
  state: PersistedNavigationHistoryV1,
  repoId: string | null | undefined,
  direction: NavigationDirection,
  isAvailable: NavigationTargetPredicate
): boolean {
  return Boolean(repoId) && availableHistoryIndex(state.projects[repoId!], direction, isAvailable) >= 0
}

export function traverseNavigationHistory(
  state: PersistedNavigationHistoryV1,
  repoId: string | null | undefined,
  direction: NavigationDirection,
  isAvailable: NavigationTargetPredicate
): { state: PersistedNavigationHistoryV1; target?: NavigationTarget } {
  if (!repoId) return { state }
  const project = state.projects[repoId]
  const cursor = availableHistoryIndex(project, direction, isAvailable)
  if (!project || cursor < 0) return { state }
  return {
    state: withProject(state, repoId, { ...project, cursor }),
    target: copyTarget(project.entries[cursor]!)
  }
}

export function navigationMruAvailable(
  state: PersistedNavigationHistoryV1,
  repoId: string | null | undefined,
  current: NavigationTarget | undefined,
  isAvailable: NavigationTargetPredicate
): boolean {
  if (!repoId) return false
  const candidates = state.projects[repoId]?.mru ?? []
  return candidates.some((target) => isAvailable(target) && (!current || !sameMruTarget(target, current)))
}

export function cycleNavigationMru(
  state: PersistedNavigationHistoryV1,
  repoId: string | null | undefined,
  current: NavigationTarget | undefined,
  direction: NavigationDirection,
  isAvailable: NavigationTargetPredicate
): NavigationTarget | undefined {
  if (!repoId) return undefined
  const candidates = (state.projects[repoId]?.mru ?? []).filter(isAvailable)
  if (candidates.length < 2 && (!candidates[0] || (current && sameMruTarget(candidates[0], current)))) return undefined
  const currentIndex = current ? candidates.findIndex((target) => sameMruTarget(target, current)) : -1
  const start = currentIndex < 0 ? (direction === 1 ? -1 : 0) : currentIndex
  for (let offset = 1; offset <= candidates.length; offset += 1) {
    const index = (start + direction * offset + candidates.length) % candidates.length
    const target = candidates[index]
    if (target && (!current || !sameMruTarget(target, current))) return copyTarget(target)
  }
  return undefined
}

function reconcileProject(
  project: PersistedProjectNavigationHistory,
  isAvailable: NavigationTargetPredicate
): PersistedProjectNavigationHistory | undefined {
  const entries: NavigationTarget[] = []
  let cursor = -1
  for (let index = 0; index < project.entries.length; index += 1) {
    const target = project.entries[index]!
    if (!isAvailable(target)) continue
    entries.push(copyTarget(target))
    if (index <= project.cursor) cursor = entries.length - 1
  }
  if (entries.length > 0 && cursor < 0) cursor = 0

  const mru: NavigationTarget[] = []
  for (const target of project.mru) {
    if (!isAvailable(target) || mru.some((candidate) => sameMruTarget(candidate, target))) continue
    mru.push(copyTarget(target))
    if (mru.length >= MAX_NAVIGATION_MRU) break
  }
  if (entries.length === 0 && mru.length === 0) return undefined
  return { entries, cursor, mru }
}

export function reconcileNavigationHistory(
  state: PersistedNavigationHistoryV1,
  isAvailable: NavigationTargetPredicate
): PersistedNavigationHistoryV1 {
  const projects: Record<string, PersistedProjectNavigationHistory> = {}
  const projectOrder: string[] = []
  for (const repoId of state.projectOrder) {
    const project = state.projects[repoId]
    if (!project) continue
    const reconciled = reconcileProject(project, isAvailable)
    if (!reconciled) continue
    projects[repoId] = reconciled
    projectOrder.push(repoId)
  }
  const unchanged = projectOrder.length === state.projectOrder.length && projectOrder.every((repoId, index) => {
    if (state.projectOrder[index] !== repoId) return false
    const previous = state.projects[repoId]
    const nextProject = projects[repoId]
    return Boolean(previous && nextProject
      && previous.cursor === nextProject.cursor
      && previous.entries.length === nextProject.entries.length
      && previous.entries.every((target, targetIndex) => sameNavigationTarget(target, nextProject.entries[targetIndex]!))
      && previous.mru.length === nextProject.mru.length
      && previous.mru.every((target, targetIndex) => sameNavigationTarget(target, nextProject.mru[targetIndex]!)))
  })
  return unchanged ? state : { version: NAVIGATION_HISTORY_VERSION, projectOrder, projects }
}

export function serializeNavigationHistory(state: PersistedNavigationHistoryV1): PersistedNavigationHistoryV1 {
  const projects: Record<string, PersistedProjectNavigationHistory> = {}
  for (const repoId of state.projectOrder) {
    const project = state.projects[repoId]
    if (!project) continue
    projects[repoId] = {
      entries: project.entries.map(copyTarget),
      cursor: project.cursor,
      mru: project.mru.map(copyTarget)
    }
  }
  return { version: NAVIGATION_HISTORY_VERSION, projectOrder: [...state.projectOrder], projects }
}

export type NavigationHistoryPhase = 'idle' | 'loading' | 'ready' | 'error'
export type NavigationHistoryChange = 'restore' | 'record' | 'cursor' | 'reconcile'

/** Renderer-local authority; it deliberately has no dependency on the Zustand store. */
export class NavigationHistoryAuthority {
  private state: PersistedNavigationHistoryV1 = EMPTY_NAVIGATION_HISTORY
  private phase: NavigationHistoryPhase = 'idle'
  private failure: Error | undefined
  private readonly listeners = new Set<(change: NavigationHistoryChange) => void>()
  private readonly ready: Promise<void>
  private resolveReady: (() => void) | undefined

  constructor() {
    const { promise, resolve } = Promise.withResolvers<void>()
    this.ready = promise
    this.resolveReady = resolve
  }

  getSnapshot(): PersistedNavigationHistoryV1 {
    return this.state
  }

  getPhase(): NavigationHistoryPhase {
    return this.phase
  }

  getError(): Error | undefined {
    return this.failure
  }

  beginRestore(): void {
    if (this.phase === 'idle') this.phase = 'loading'
  }

  completeRestore(value: unknown, isAvailable: NavigationTargetPredicate): { ok: true } | { ok: false; error: string } {
    if (this.phase === 'ready') return { ok: true }
    if (this.phase === 'error') return { ok: false, error: this.failure?.message ?? 'Navigation history restore failed' }
    if (value === undefined) {
      this.state = EMPTY_NAVIGATION_HISTORY
    } else {
      const validation = validatePersistedNavigationHistory(value)
      if (!validation.ok) {
        this.failRestore(new Error(validation.error))
        return validation
      }
      this.state = reconcileNavigationHistory(validation.value, isAvailable)
    }
    this.phase = 'ready'
    this.resolveReady?.()
    this.resolveReady = undefined
    this.emit('restore')
    return { ok: true }
  }

  failRestore(error: Error): void {
    if (this.phase === 'ready' || this.phase === 'error') return
    this.failure = error
    this.phase = 'error'
    this.resolveReady?.()
    this.resolveReady = undefined
    this.emit('restore')
  }

  async waitUntilReady(): Promise<void> {
    await this.ready
  }

  persistedSnapshot(): PersistedNavigationHistoryV1 {
    if (this.phase === 'error') throw this.failure ?? new Error('Navigation history restore failed')
    if (this.phase !== 'ready') throw new Error('Navigation history has not finished restoring')
    return serializeNavigationHistory(this.state)
  }

  subscribe(listener: (change: NavigationHistoryChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  record(target: NavigationTarget): void {
    this.replace(recordNavigationTarget(this.state, target), 'record')
  }

  traverse(repoId: string | null | undefined, direction: NavigationDirection, isAvailable: NavigationTargetPredicate): NavigationTarget | undefined {
    const result = traverseNavigationHistory(this.state, repoId, direction, isAvailable)
    this.replace(result.state, 'cursor')
    return result.target
  }

  cycleMru(
    repoId: string | null | undefined,
    current: NavigationTarget | undefined,
    direction: NavigationDirection,
    isAvailable: NavigationTargetPredicate
  ): NavigationTarget | undefined {
    return cycleNavigationMru(this.state, repoId, current, direction, isAvailable)
  }

  reconcile(isAvailable: NavigationTargetPredicate): void {
    this.replace(reconcileNavigationHistory(this.state, isAvailable), 'reconcile')
  }

  private replace(next: PersistedNavigationHistoryV1, change: NavigationHistoryChange): void {
    if (next === this.state) return
    this.state = next
    this.emit(change)
  }

  private emit(change: NavigationHistoryChange): void {
    for (const listener of this.listeners) listener(change)
  }
}

export const navigationHistoryAuthority = new NavigationHistoryAuthority()
let navigationHistoryInitialization: Promise<void> | undefined

export type NavigationHistoryLoader = () => Promise<unknown>

/** Starts restore exactly once; callers provide the persistence reader to keep this module store-independent. */
export function ensureNavigationHistoryInitialized(load: NavigationHistoryLoader): Promise<void> {
  const phase = navigationHistoryAuthority.getPhase()
  if (phase === 'ready' || phase === 'error') return navigationHistoryAuthority.waitUntilReady()
  if (navigationHistoryInitialization) return navigationHistoryInitialization

  navigationHistoryAuthority.beginRestore()
  navigationHistoryInitialization = (async () => {
    try {
      const persisted = await load()
      navigationHistoryAuthority.completeRestore(persisted, () => true)
    } catch (error) {
      navigationHistoryAuthority.failRestore(error instanceof Error ? error : new Error(String(error)))
    }
  })()
  return navigationHistoryInitialization
}

export function getPersistedNavigationHistory(): PersistedNavigationHistoryV1 {
  return navigationHistoryAuthority.persistedSnapshot()
}

export function waitForNavigationHistoryReady(): Promise<void> {
  return navigationHistoryAuthority.waitUntilReady()
}
