import type { Repo } from './types'

export type ProjectKitPreview = {
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
export type ProjectKitReport = ProjectKitPreview & { projectPath: string; projectKey: string; restoredAt: string }
export type ProjectKitApi = {
  projectKitExport(workspacePath: string, outputPath: string, artifacts: string[]): Promise<ProjectKitPreview & { path: string }>
  projectKitPreview(archivePath: string): Promise<ProjectKitPreview>
  projectKitImport(archivePath: string, destinationPath: string, expectedSha256: string, sourceProjectKey: string): Promise<{ repo: Repo; report: ProjectKitReport }>
  projectKitReport(workspacePath: string): Promise<ProjectKitReport | null>
}
