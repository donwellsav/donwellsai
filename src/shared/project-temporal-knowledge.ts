import type { KnowledgeSelection, KnowledgeSourceRef } from './project-knowledge'
export type GraphitiConfiguration = { enabled: boolean; python: string; neo4jUri: string; neo4jUser: string; modelUrl: string; model: string; embeddingUrl: string; embeddingModel: string; embeddingDimensions: number }
export type TemporalSource = { ref: KnowledgeSourceRef; episodeId: string; content: string; availableFrom: string; availableUntil: string | null }
export type TemporalSnapshot = { sources: TemporalSource[]; historyFloors: Array<{ id: string; oldestAvailableAt: string }>; selected: KnowledgeSelection[] }
export type TemporalKnowledgeStatus = { enabled: boolean; generation: string | null; stale: boolean; pendingCleanup: number; sources: KnowledgeSelection[]; busy: boolean; error: string | null }
export type TemporalKnowledgeAnswer = { classification: 'learned'; generation: string; asOf: string; mode: 'current' | 'historical'; omitted: number; relationships: Array<{ id: string; text: string; validAt: string | null; invalidAt: string | null; sources: KnowledgeSourceRef[] }> }
export interface ProjectTemporalKnowledgeApi {
  projectTemporalKnowledgePasswordSet(workspacePath: string, password: string): Promise<void>
  projectTemporalKnowledgeStatus(workspacePath: string): Promise<TemporalKnowledgeStatus>
  projectTemporalKnowledgeReconcile(workspacePath: string, sources: KnowledgeSelection[]): Promise<TemporalKnowledgeStatus>
  projectTemporalKnowledgeQuery(workspacePath: string, query: string, asOf?: string): Promise<TemporalKnowledgeAnswer>
  projectTemporalKnowledgeStop(workspacePath: string): Promise<void>
}
export function parseGraphitiConfiguration(value: unknown): GraphitiConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Graphiti configuration')
  const v = value as GraphitiConfiguration
  const fields = ['enabled', 'python', 'neo4jUri', 'neo4jUser', 'modelUrl', 'model', 'embeddingUrl', 'embeddingModel', 'embeddingDimensions']
  if (Object.keys(v).some(key => !fields.includes(key)) || typeof v.enabled !== 'boolean' || !Number.isSafeInteger(v.embeddingDimensions) || v.embeddingDimensions < 1 || v.embeddingDimensions > 4096) throw new Error('Invalid Graphiti model configuration')
  for (const key of fields.filter(key => !['enabled', 'embeddingDimensions'].includes(key)) as Array<Exclude<keyof GraphitiConfiguration, 'enabled' | 'embeddingDimensions'>>) if (typeof v[key] !== 'string' || !v[key].trim() || v[key].length > 4096 || /[\x00-\x1f\x7f]/.test(v[key])) throw new Error('Graphiti requires explicit executable, endpoints and model identities')
  if (!v.python.startsWith('/')) throw new Error('Graphiti Python must be an absolute executable path')
  for (const [key, protocol] of [['neo4jUri', 'bolt:'], ['modelUrl', 'http:'], ['embeddingUrl', 'http:']] as const) {
    const url = new URL(v[key])
    if (url.protocol !== protocol || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.hash || url.search || (key === 'neo4jUri' && url.pathname && url.pathname !== '/')) throw new Error('Graphiti requires explicit loopback endpoints without inline credentials')
  }
  return { ...v }
}
