export type ProjectToolScope = {
  projectKey: string
  projectPath: string
  checkoutPath: string
  indexKey: string
}

export type ToolServiceState = {
  id: string
  status: 'stopped' | 'starting' | 'ready' | 'failed'
  version: string | null
  detail: string | null
}

export type ProjectSearchHit = {
  source: 'file' | 'code' | 'document' | 'memory' | 'session'
  id: string
  title: string
  excerpt: string
  path: string | null
  line: number | null
  revision: string | null
  indexedAt: string | null
  stale: boolean
}

export type ProjectCodeSearchRequest = { query: string; language?: string; showHidden: boolean; includeIgnored: boolean; maxResults?: number }
export type ProjectCodeSearchResult = { hits: ProjectSearchHit[]; truncated: boolean; skipped: number }

export function parseCodeGraphFunctionName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\0\r\n]/.test(value)) throw new Error('Expected a bounded function name')
  return value
}
