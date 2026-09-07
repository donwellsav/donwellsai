import type { KnowledgeSelection, KnowledgeSourceRef } from './project-knowledge'
import type { Repo } from './types'

export type ProjectKitReference = { kind: 'memory' | 'handoff'; id: string; originalProjectKey: string; originalId: string }
export type ProjectKitIdentityMapping = ProjectKitReference & { targetId: string }
export type ProjectKitPreview = {
  schemaVersion: 1 | 2 | 3
  learnedFacts?: number
  temporalSources?: number
  portableSettings?: ProjectKitSettings
  erasedMemories: number
  archiveId: string
  sourceProjectKey: string
  sourceName: string
  sha256: string
  memories: number
  revisions: number
  handoffs: number
  artifacts: string[]
  tools: Array<{ id: string; version: string; configured: boolean; enabled: boolean }>
  warnings: string[]
}
export type ProjectKitSettings = { documentRetrievalMode?: import('./project-doctor').DocumentRetrievalMode; hindsightModel?: string; graphitiModel?: string; embeddingModel?: string; embeddingDimensions?: number; taskAuthority?: 'backlog.md' }
export type ProjectKitKnowledge = { hindsight: { transferSchemaRevision: string; exportedAt: string; model: string; sources: Array<KnowledgeSourceRef & {documentId:string}>; documents: Record<string,unknown>[] } | null; temporal: KnowledgeSelection[]; settings: ProjectKitSettings }
export type ProjectKitReport = ProjectKitPreview & { projectPath: string; projectKey: string; restoredAt: string; identityMapping?: ProjectKitIdentityMapping[] }
export type ProjectKitApi = {
  projectKitReconnectLearned(workspacePath: string): Promise<import('./project-knowledge').KnowledgeStatus>
  projectKitExport(workspacePath: string, outputPath: string, artifacts: string[], options?: { includeLearned?: boolean }): Promise<ProjectKitPreview & { path: string }>
  projectKitPreview(archivePath: string): Promise<ProjectKitPreview>
  projectKitImport(archivePath: string, destinationPath: string, expectedSha256: string, sourceProjectKey: string): Promise<{ repo: Repo; report: ProjectKitReport }>
  projectKitReport(workspacePath: string): Promise<ProjectKitReport | null>
}

export function artifactPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024 || !value || /[\\\x00-\x1f\x7f:]/.test(value) || value.split('/').some(part => !part || part === '..' || part.startsWith('.')) || /(?:^|\/)(?:node_modules|credentials?|secrets?|cookies?|auth|env|environment)(?:[./]|$)/i.test(value) || /\.(?:pem|key|p12|pfx|sqlite|db)$/i.test(value)) throw new Error('Select a relative, non-secret text artifact path')
  return value
}
