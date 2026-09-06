import type { ProjectSearchHit } from './project-tools'

export type SessionHistorySearch = { hits: ProjectSearchHit[]; truncated: boolean; capabilities: Record<string, string> }
export type SessionHistorySource = {
  id: string; agent: string; nativeId: string; source: string; cwd: string; indexedAt: string
  resume: import('./agent-runtime').AgentExecutable | null
  messages: Array<{ ordinal: number; role: string; content: string }>; untrusted: true
}
export type ProjectSessionHistoryApi = {
  projectSessionHistoryIndex(workspacePath: string): Promise<{ indexedAt: string; capabilities: Record<string, string> }>
  projectSessionHistorySearch(workspacePath: string, query: string): Promise<SessionHistorySearch>
  projectSessionHistoryGet(workspacePath: string, id: string): Promise<SessionHistorySource>
}
