import {
  MAX_FILE_SEARCH_CANDIDATES,
  MAX_FILE_SEARCH_MRU,
  MAX_FILE_SEARCH_QUERY_LENGTH,
  MAX_FILE_SEARCH_RESULTS,
  type WorkspaceFileMatch,
  type WorkspaceFileSearchRequest,
  type WorkspaceFileSearchResult
} from './file-workspace'
import type { FileEntry } from './types'
import { fuzzyMatch } from './fuzzy'

function boundedResultCount(requested: number | undefined): number {
  if (requested === undefined) return 30
  if (!Number.isSafeInteger(requested)) return 30
  return Math.max(1, Math.min(requested, MAX_FILE_SEARCH_RESULTS))
}

function hiddenPath(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.'))
}

/**
 * Path-shaped weighting on top of the shared subsequence score: an exact or
 * prefixed basename outranks a mid-path hit.
 */
function basenameBonus(path: string, query: string): number {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return 0
  const text = path.toLowerCase()
  const basename = text.slice(text.lastIndexOf('/') + 1)
  if (basename === needle) return 2_000
  if (basename.startsWith(needle)) return 1_000
  if (text.startsWith(needle)) return 500
  return 0
}

function insertRanked(results: WorkspaceFileMatch[], candidate: WorkspaceFileMatch, limit: number): void {
  let low = 0
  let high = results.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const current = results[middle]!
    const before = candidate.score > current.score || (candidate.score === current.score && candidate.entry.path.localeCompare(current.entry.path) < 0)
    if (before) high = middle
    else low = middle + 1
  }
  if (low < limit) results.splice(low, 0, candidate)
  if (results.length > limit) results.pop()
}

/**
 * Rank already-authorized workspace files without ever returning or scoring an
 * unbounded result set. The caller owns ignored-file discovery.
 */
export function rankWorkspaceFiles(
  candidates: Iterable<FileEntry>,
  request: WorkspaceFileSearchRequest
): WorkspaceFileSearchResult {
  const query = request.query.trim()
  if (query.length > MAX_FILE_SEARCH_QUERY_LENGTH) throw new Error(`File search query exceeds ${MAX_FILE_SEARCH_QUERY_LENGTH} characters`)
  const maxResults = boundedResultCount(request.maxResults)
  const mru = request.mruPaths?.slice(0, MAX_FILE_SEARCH_MRU) ?? []
  const mruRank = new Map(mru.map((path, index) => [path, MAX_FILE_SEARCH_MRU - index]))
  const matches: WorkspaceFileMatch[] = []
  let scanned = 0
  let matched = 0
  let truncated = false

  for (const entry of candidates) {
    if (scanned >= MAX_FILE_SEARCH_CANDIDATES) {
      truncated = true
      break
    }
    scanned += 1
    if (entry.type !== 'file' || (!request.showHidden && hiddenPath(entry.path))) continue
    const result = fuzzyMatch(entry.path, query)
    if (!result) continue
    matched += 1
    const recent = mruRank.get(entry.path) ?? 0
    insertRanked(matches, { entry, score: result.score + basenameBonus(entry.path, query) + recent * 12, hits: result.hits }, maxResults)
  }

  if (matched > matches.length) truncated = true
  return { matches, scanned, truncated }
}
