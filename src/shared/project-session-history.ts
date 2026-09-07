import type { ProjectSearchHit } from './project-tools'

export type SessionHistorySearch = { hits: ProjectSearchHit[]; truncated: boolean; capabilities: Record<string, string> }
export type SessionHistoryAnalytics = {
  indexedAt: string; sessions: number; excluded: number; truncated: boolean
  days: Array<{ day: string; agent: string; sessions: number; outputTokens: number | null; tokenSessions: number; peakContext: number | null; contextSessions: number }>
  costs: Array<{ day: string; status: string; source: string; events: number; measuredEvents: number; microdollars: number | null }>
}
export type SessionHistorySource = {
  id: string; agent: string; nativeId: string; source: string; cwd: string; indexedAt: string
  resume: import('./agent-runtime').AgentExecutable | null
  messages: Array<{ ordinal: number; role: string; content: string }>; untrusted: true
}
export type ProjectSessionHistoryApi = {
  projectSessionHistoryAnalytics(workspacePath: string): Promise<SessionHistoryAnalytics>
  projectSessionHistoryIndex(workspacePath: string): Promise<{ indexedAt: string; capabilities: Record<string, string> }>
  projectSessionHistorySearch(workspacePath: string, query: string): Promise<SessionHistorySearch>
  projectSessionHistoryGet(workspacePath: string, id: string): Promise<SessionHistorySource>
}
