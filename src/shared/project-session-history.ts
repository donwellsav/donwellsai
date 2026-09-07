import type { ProjectSearchHit } from './project-tools'

export type SessionHistorySearch = { hits: ProjectSearchHit[]; truncated: boolean; capabilities: Record<string, string> }
export type SessionAnalyticsOptions = { engine?: 'sqlite' | 'duckdb'; requestId?: string; decisionAt?: string }
export type SessionAnalyticsProgress = { phase: 'validating' | 'snapshot' | 'querying' | 'complete' | 'cancelled' | 'failed'; validated: number; scanned: number }
export type SessionHistoryAnalytics = {
  engine?: 'sqlite' | 'duckdb'; sourceGeneration?: string
  sourceRefs?: Array<{ id: string; fingerprint: string }>
  decisionAt?: string
  comparison?: Array<{ period: 'before' | 'after' | 'unknown'; agent: string; sessions: number; outputTokens: number | null; tokenSessions: number }>
  indexedAt: string; sessions: number; excluded: number; truncated: boolean
  days: Array<{ day: string; agent: string; sessions: number; outputTokens: number | null; tokenSessions: number; peakContext: number | null; contextSessions: number }>
  costs: Array<{ day: string; status: string; source: string; events: number; measuredEvents: number; microdollars: number | null }>
}
export type SessionHistorySource = {
  id: string; agent: string; nativeId: string; source: string; cwd: string; indexedAt: string
  sourceFormat: string; sourceVersion: string | null; projectAttribution: 'cwd'
  parentNativeId: string | null; role: 'primary' | 'helper'
  resume: import('./agent-runtime').AgentExecutable | null
  messages: Array<{ ordinal: number; role: string; content: string }>
  previousOrdinal: number | null; nextOrdinal: number | null; untrusted: true
}
export type SessionHistoryPage = { fromOrdinal?: number; limit?: number }
export type ProjectSessionHistoryApi = {
  projectSessionHistoryAnalytics(workspacePath: string, options?: SessionAnalyticsOptions): Promise<SessionHistoryAnalytics>
  projectSessionHistoryAnalyticsCancel(workspacePath: string, requestId: string): Promise<void>
  projectSessionHistoryAnalyticsProgress(workspacePath: string, requestId: string): Promise<SessionAnalyticsProgress>
  projectSessionHistoryIndex(workspacePath: string): Promise<{ indexedAt: string; capabilities: Record<string, string> }>
  projectSessionHistorySearch(workspacePath: string, query: string, requestId?: string): Promise<SessionHistorySearch>
  projectSessionHistorySearchCancel(workspacePath: string, requestId: string): Promise<void>
  projectSessionHistoryGet(workspacePath: string, id: string, page?: SessionHistoryPage): Promise<SessionHistorySource>
}
