import { rankWorkspaceFiles } from '@shared/file-search'
import type {
  WorkspaceFileMatch,
  WorkspaceFileSearchRequest,
  WorkspaceFileSearchResult
} from '@shared/file-workspace'

export type PaletteFileScope = 'active' | 'global'

type ScopeListener = (scope: PaletteFileScope) => void
let paletteFileScope: PaletteFileScope = 'active'
const scopeListeners = new Set<ScopeListener>()

export function getPaletteFileScope(): PaletteFileScope {
  return paletteFileScope
}

export function requestPaletteFileScope(scope: PaletteFileScope): void {
  if (paletteFileScope === scope) return
  paletteFileScope = scope
  for (const listener of scopeListeners) listener(scope)
}

export function subscribePaletteFileScope(listener: ScopeListener): () => void {
  scopeListeners.add(listener)
  return () => scopeListeners.delete(listener)
}

export type NavigatorWorkspaceSearch = {
  repoId: string
  workspacePath: string
  workspaceLabel: string
  request: WorkspaceFileSearchRequest
}

export type NavigatorFileResult = {
  repoId: string
  workspacePath: string
  workspaceLabel: string
  match: WorkspaceFileMatch
}

export type NavigatorFileError = {
  workspacePath: string
  workspaceLabel: string
  message: string
}

export type NavigatorFileSearchSnapshot = {
  matches: readonly NavigatorFileResult[]
  errors: readonly NavigatorFileError[]
  pending: number
  /** True while all visible file results came from bounded local cache entries. */
  localOnly: boolean
}

export type NavigatorFileSearchProvider = (
  workspacePath: string,
  request: WorkspaceFileSearchRequest
) => Promise<WorkspaceFileSearchResult>

export type NavigatorFileSearchTask = {
  initial: NavigatorFileSearchSnapshot
  done: Promise<NavigatorFileSearchSnapshot>
  cancel(): void
}

type CacheEntry = {
  key: string
  workspacePath: string
  optionsKey: string
  query: string
  providerId: number
  result: WorkspaceFileSearchResult
}

type WorkspaceResult = {
  search: NavigatorWorkspaceSearch
  result: WorkspaceFileSearchResult
}

const MAX_CACHE_ENTRIES = 48
const MAX_CACHE_ENTRIES_PER_WORKSPACE = 8
const MAX_GLOBAL_FILE_RESULTS = 100
const MAX_CONCURRENT_SEARCHES = 3

function mruKey(paths: readonly string[] | undefined): string {
  return (paths ?? []).slice(0, 32).join('\u0000')
}

function optionsKey(request: WorkspaceFileSearchRequest): string {
  return `${request.showHidden ? 'h' : '-'}${request.includeIgnored ? 'i' : '-'}\u0000${mruKey(request.mruPaths)}`
}

function cacheKey(search: NavigatorWorkspaceSearch, providerId: number): string {
  return `${providerId}\u0000${search.workspacePath}\u0000${optionsKey(search.request)}\u0000${search.request.query.trim().toLocaleLowerCase()}`
}

function insertGlobalResult(results: NavigatorFileResult[], candidate: NavigatorFileResult): void {
  let low = 0
  let high = results.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const current = results[middle]!
    const before = candidate.match.score > current.match.score
      || (candidate.match.score === current.match.score
        && (candidate.workspaceLabel.localeCompare(current.workspaceLabel)
          || candidate.match.entry.path.localeCompare(current.match.entry.path)) < 0)
    if (before) high = middle
    else low = middle + 1
  }
  if (low < MAX_GLOBAL_FILE_RESULTS) results.splice(low, 0, candidate)
  if (results.length > MAX_GLOBAL_FILE_RESULTS) results.pop()
}

function searchSnapshot(
  workspaceResults: ReadonlyMap<string, WorkspaceResult>,
  errors: ReadonlyMap<string, NavigatorFileError>,
  pending: number,
  localOnly: boolean
): NavigatorFileSearchSnapshot {
  const matches: NavigatorFileResult[] = []
  for (const { search, result } of workspaceResults.values()) {
    for (const match of result.matches) {
      insertGlobalResult(matches, {
        repoId: search.repoId,
        workspacePath: search.workspacePath,
        workspaceLabel: search.workspaceLabel,
        match
      })
    }
  }
  return { matches, errors: [...errors.values()], pending, localOnly }
}

/** Bounded query cache + three-lane scheduler. IPC promises are not abortable, so stale generations are ignored. */
export class GlobalNavigatorFileCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly workspaceVersions = new Map<string, number>()
  private readonly providerIds = new WeakMap<NavigatorFileSearchProvider, number>()
  private authorizedWorkspaces: Set<string> | undefined
  private nextProviderId = 1
  private generation = 0

  invalidateWorkspace(workspacePath: string): void {
    this.workspaceVersions.set(workspacePath, (this.workspaceVersions.get(workspacePath) ?? 0) + 1)
    for (const [key, entry] of this.entries) {
      if (entry.workspacePath === workspacePath) this.entries.delete(key)
    }
  }

  reconcileAuthorizedWorkspaces(workspacePaths: ReadonlySet<string>): void {
    const previous = this.authorizedWorkspaces
    if (previous) {
      for (const workspacePath of previous) {
        if (!workspacePaths.has(workspacePath)) this.invalidateWorkspace(workspacePath)
      }
    } else {
      for (const entry of this.entries.values()) {
        if (!workspacePaths.has(entry.workspacePath)) this.invalidateWorkspace(entry.workspacePath)
      }
    }
    this.authorizedWorkspaces = new Set(workspacePaths)
  }

  search(
    searches: readonly NavigatorWorkspaceSearch[],
    provider: NavigatorFileSearchProvider,
    onUpdate?: (snapshot: NavigatorFileSearchSnapshot) => void
  ): NavigatorFileSearchTask {
    const generation = ++this.generation
    let providerId = this.providerIds.get(provider)
    if (providerId === undefined) {
      providerId = this.nextProviderId
      this.nextProviderId += 1
      this.providerIds.set(provider, providerId)
    }
    let cancelled = false
    const workspaceResults = new Map<string, WorkspaceResult>()
    const errors = new Map<string, NavigatorFileError>()
    const pending: Array<{ search: NavigatorWorkspaceSearch; version: number }> = []

    for (const search of searches) {
      if (this.authorizedWorkspaces && !this.authorizedWorkspaces.has(search.workspacePath)) {
        errors.set(search.workspacePath, {
          workspacePath: search.workspacePath,
          workspaceLabel: search.workspaceLabel,
          message: 'Workspace is no longer authorized for search.'
        })
        continue
      }
      if (!this.workspaceVersions.has(search.workspacePath)) this.workspaceVersions.set(search.workspacePath, 0)
      const exact = this.readExact(search, providerId)
      if (exact) {
        workspaceResults.set(search.workspacePath, { search, result: exact })
        continue
      }
      const local = this.readRelated(search, providerId)
      if (local) workspaceResults.set(search.workspacePath, { search, result: local })
      pending.push({ search, version: this.workspaceVersions.get(search.workspacePath) ?? 0 })
    }

    const initial = searchSnapshot(workspaceResults, errors, pending.length, pending.length > 0)
    const workers = Math.min(MAX_CONCURRENT_SEARCHES, pending.length)
    let queueIndex = 0
    let pendingCount = pending.length

    const runWorker = async (): Promise<void> => {
      while (!cancelled && generation === this.generation) {
        const item = pending[queueIndex]
        queueIndex += 1
        if (!item) return
        try {
          const result = await provider(item.search.workspacePath, item.search.request)
          if (cancelled || generation !== this.generation) return
          if ((this.workspaceVersions.get(item.search.workspacePath) ?? 0) !== item.version) continue
          this.write(item.search, result, providerId)
          workspaceResults.set(item.search.workspacePath, { search: item.search, result })
          errors.delete(item.search.workspacePath)
        } catch (error) {
          if (cancelled || generation !== this.generation) return
          if ((this.workspaceVersions.get(item.search.workspacePath) ?? 0) !== item.version) continue
          errors.set(item.search.workspacePath, {
            workspacePath: item.search.workspacePath,
            workspaceLabel: item.search.workspaceLabel,
            message: error instanceof Error ? error.message : String(error)
          })
        } finally {
          pendingCount -= 1
          if (!cancelled && generation === this.generation) {
            onUpdate?.(searchSnapshot(workspaceResults, errors, pendingCount, pendingCount > 0))
          }
        }
      }
    }

    const done = Promise.all(Array.from({ length: workers }, () => runWorker())).then(() =>
      searchSnapshot(workspaceResults, errors, Math.max(0, pendingCount), false))
    return {
      initial,
      done,
      cancel: () => {
        cancelled = true
        if (generation === this.generation) this.generation += 1
      }
    }
  }

  private readExact(search: NavigatorWorkspaceSearch, providerId: number): WorkspaceFileSearchResult | undefined {
    const key = cacheKey(search, providerId)
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.result
  }

  private readRelated(search: NavigatorWorkspaceSearch, providerId: number): WorkspaceFileSearchResult | undefined {
    const query = search.request.query.trim().toLocaleLowerCase()
    const options = optionsKey(search.request)
    let related: CacheEntry | undefined
    for (const entry of this.entries.values()) {
      if (entry.providerId !== providerId || entry.workspacePath !== search.workspacePath || entry.optionsKey !== options) continue
      if (!query.startsWith(entry.query) || (related && related.query.length >= entry.query.length)) continue
      related = entry
    }
    if (!related) return undefined
    return rankWorkspaceFiles(related.result.matches.map((match) => match.entry), search.request)
  }

  private write(search: NavigatorWorkspaceSearch, result: WorkspaceFileSearchResult, providerId: number): void {
    const key = cacheKey(search, providerId)
    const entry: CacheEntry = {
      key,
      workspacePath: search.workspacePath,
      optionsKey: optionsKey(search.request),
      query: search.request.query.trim().toLocaleLowerCase(),
      providerId,
      result
    }
    this.entries.delete(key)
    this.entries.set(key, entry)

    let workspaceCount = 0
    for (const candidate of [...this.entries.values()].reverse()) {
      if (candidate.workspacePath !== search.workspacePath) continue
      workspaceCount += 1
      if (workspaceCount > MAX_CACHE_ENTRIES_PER_WORKSPACE) this.entries.delete(candidate.key)
    }
    while (this.entries.size > MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
}

export const globalNavigatorFileCache = new GlobalNavigatorFileCache()
