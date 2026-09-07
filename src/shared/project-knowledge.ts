import { parseProjectMemoryIdentifier } from './project-memory'

export type KnowledgeSelection = { kind: 'memory' | 'handoff'; id: string; revision: number }
export type KnowledgeSourceRef = KnowledgeSelection & { projectKey: string; sourceTime: string | null }
export type HindsightConfiguration = { enabled: boolean; endpoint: string; model: string }
export type KnowledgeStatus = { enabled: boolean; phase: 'idle' | 'retaining' | 'querying' | 'stopped'; generation: string | null; sources: KnowledgeSelection[]; stale: boolean; pendingCleanup: number; error: string | null; model: string }
export type KnowledgeAnswer = { classification: 'learned'; generation: string; model: string; items: Array<{ text: string; sources: KnowledgeSourceRef[] }>; omitted: number }
export type ProjectKnowledgeApi = {
  projectKnowledgeStatus(workspacePath: string): Promise<KnowledgeStatus>
  projectKnowledgeReconcile(workspacePath: string, sources: KnowledgeSelection[]): Promise<KnowledgeStatus>
  projectKnowledgeRecall(workspacePath: string, query: string): Promise<KnowledgeAnswer>
  projectKnowledgeReflect(workspacePath: string, query: string): Promise<KnowledgeAnswer>
  projectKnowledgeStop(workspacePath: string): Promise<void>
}
export function parseKnowledgeSelections(value: unknown): KnowledgeSelection[] {
  if (!Array.isArray(value) || value.length > 50) throw new Error('Explicitly select up to 50 reviewed knowledge sources')
  const keys = new Set<string>()
  return value.map(source => {
    if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).length !== 3 || !['memory', 'handoff'].includes(source.kind) || !Number.isSafeInteger(source.revision) || source.revision < 1) throw new Error('Invalid knowledge source selection')
    const id = parseProjectMemoryIdentifier(source.id), key = source.kind + ':' + id
    if (keys.has(key)) throw new Error('Duplicate knowledge source')
    keys.add(key)
    return { kind: source.kind, id, revision: source.revision }
  })
}
export function parseHindsightConfiguration(value: unknown): HindsightConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Hindsight configuration')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['enabled', 'endpoint', 'model'].includes(key)) || typeof input.enabled !== 'boolean' || typeof input.endpoint !== 'string' || typeof input.model !== 'string' || !input.model.trim() || input.model.length > 200 || /[\x00-\x1f\x7f]/.test(input.model)) throw new Error('Select a Hindsight endpoint and model identity')
  const endpoint = new URL(input.endpoint)
  if (endpoint.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw new Error('Hindsight currently requires a local HTTP origin without credentials or a path')
  return { enabled: input.enabled, endpoint: endpoint.origin, model: input.model.trim() }
}

/** Native learned-fact archive. It is historical on restore until an explicit service import. */
export type HindsightTransferSnapshot = { format: 'hindsight-document-transfer'; transferSchemaRevision: string; exportedAt: string; model: string; sources: Array<KnowledgeSourceRef & { documentId: string }>; archiveBase64: string; sha256: string }
