/** Project environments use an explicit transport; local ProcessSpec never silently becomes remote. */
export const PROJECT_REMOTE_VERSION = 1
export type SshEnvironmentConfig = {
  kind: 'ssh'; hostname: string; port: number; username: string; identityFile: string
  hostKey: string; hostFingerprint: string; remoteProjectId: string; remoteRoot: string
}
export type ProjectEnvironment = {
  id: string; generation: number; projectKey: string; checkoutPath: string
  state: 'configured' | 'ready' | 'paused' | 'unverifiable'; config: SshEnvironmentConfig; detail?: string
}
export type ProjectRemoteMethod = 'source.put' | 'result.read' | 'hello' | 'agent.start' | 'agent.authenticate' | 'memory.status' | 'memory.prepare' | 'memory.probe' | 'terminal.list' | 'terminal.open' | 'terminal.observe' | 'terminal.write' | 'terminal.resize' | 'terminal.stop' | 'operation.get'
export type ProjectRemoteRequest = {
  version: 1; environmentId: string; generation: number; projectId: string; remoteRoot: string
  requestId: string; method: ProjectRemoteMethod; params: Record<string, unknown>
}
export type ProjectRemoteResponse = { version: 1; requestId: string; ok: boolean; result?: unknown; error?: string }
export type ProjectRemoteOperation = { requestId: string; sessionId?: string; sequence?: number; state: 'accepted' | 'completed' | 'uncertain'; result?: unknown; error?: string }
export const projectEnvironmentId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid environment identifier')
  return value
}
export const remoteMutation = (method: ProjectRemoteMethod) => ['source.put', 'agent.start', 'terminal.open', 'terminal.write', 'terminal.resize', 'terminal.stop'].includes(method)

export type EnvironmentResultFile = { path: string; baseRevision: string | null; baseContent: string | null; currentContent?: string | null; currentRevision?: string | null; received?: { revision: string; content: string } | null; state: 'pending' | 'staged' | 'applied' | 'conflict'; error?: string }
export type EnvironmentResultReview = { id: string; environmentId: string; generation: number; workspacePath: string; baseGitRevision: string | null; files: EnvironmentResultFile[] }
export type EnvironmentMemoryState = { state: 'disconnected' | 'connecting' | 'connected' | 'failed'; detail?: string }
export type ProjectEnvironmentApi = {
  environmentList(workspacePath: string): Promise<ProjectEnvironment[]>
  environmentConfigure(workspacePath: string, id: string, config: SshEnvironmentConfig): Promise<ProjectEnvironment>
  environmentConnect(workspacePath: string, id: string, generation: number): Promise<ProjectEnvironment>
  environmentPause(workspacePath: string, id: string, generation: number): Promise<ProjectEnvironment>
  environmentRequest(workspacePath: string, id: string, generation: number, method: ProjectRemoteMethod, params: Record<string, unknown>, requestId: string): Promise<unknown>
  environmentMemory(workspacePath: string, id: string, generation: number, action: 'start' | 'stop' | 'status'): Promise<EnvironmentMemoryState>
  environmentResultsList(workspacePath: string, id: string, generation: number): Promise<EnvironmentResultReview[]>
  environmentResultsCapture(workspacePath: string, id: string, generation: number, paths: string[]): Promise<EnvironmentResultReview>
  environmentResultsSend(workspacePath: string, reviewId: string): Promise<EnvironmentResultReview>
  environmentResultsStage(workspacePath: string, reviewId: string): Promise<EnvironmentResultReview>
  environmentResultsApply(workspacePath: string, reviewId: string, paths: string[]): Promise<EnvironmentResultReview>
}
