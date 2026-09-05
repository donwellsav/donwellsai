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

const WORD_BOUNDARY = /[\s\-_./:]/
const MAX_CANDIDATE_PATH_LENGTH = 2_048

export function fuzzyPathMatch(path: string, query: string): { score: number; hits: number[] } | null {
  const text = path.toLowerCase()
  const needle = query.toLowerCase()
  if (needle.length === 0) return { score: 0, hits: [] }
  if (path.length > MAX_CANDIDATE_PATH_LENGTH || needle.length > path.length) return null

  const hits: number[] = []
  let score = 0
  let searchFrom = 0
  let previous = -2
  for (let index = 0; index < needle.length; index += 1) {
    const found = text.indexOf(needle[index]!, searchFrom)
    if (found === -1) return null
    hits.push(found)
    score += 20
    if (found === 0 || WORD_BOUNDARY.test(text[found - 1] ?? '')) score += 28
    if (found === previous + 1) score += 18
    if (found < 4) score += 8
    if (previous >= 0) score -= Math.min(found - previous - 1, 12)
    previous = found
    searchFrom = found + 1
  }

  const basenameOffset = path.lastIndexOf('/') + 1
  const basename = text.slice(basenameOffset)
  if (basename === needle) score += 2_000
  else if (basename.startsWith(needle)) score += 1_000
  else if (text.startsWith(needle)) score += 500
  score -= Math.floor(path.length / 12)
  return { score, hits }
}

function boundedResultCount(requested: number | undefined): number {
  if (requested === undefined) return 30
  if (!Number.isSafeInteger(requested)) return 30
  return Math.max(1, Math.min(requested, MAX_FILE_SEARCH_RESULTS))
}

function hiddenPath(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.'))
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
    const result = fuzzyPathMatch(entry.path, query)
    if (!result) continue
    matched += 1
    const recent = mruRank.get(entry.path) ?? 0
    insertRanked(matches, { entry, score: result.score + recent * 12, hits: result.hits }, maxResults)
  }

  if (matched > matches.length) truncated = true
  return { matches, scanned, truncated }
}
