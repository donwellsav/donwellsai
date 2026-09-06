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
