/** Project environments use an explicit transport; local ProcessSpec never silently becomes remote. */
export const PROJECT_REMOTE_VERSION = 1
export type SshEnvironmentConfig = {
  kind: 'ssh'; hostname: string; port: number; username: string; identityFile: string
  hostKey: string; hostFingerprint: string; remoteProjectId: string; remoteRoot: string
}
export type ProjectEnvironment = {
  id: string; generation: number; projectKey: string; checkoutPath: string; retired?: boolean
  state: 'configured' | 'ready' | 'paused' | 'unverifiable'; config: SshEnvironmentConfig; detail?: string
  computerControl?: boolean
}
export type ProjectRemoteMethod = 'source.put' | 'result.read' | 'hello' | 'agent.start' | 'agent.authenticate' | 'memory.status' | 'memory.prepare' | 'memory.probe' | 'terminal.list' | 'terminal.open' | 'terminal.observe' | 'terminal.write' | 'terminal.resize' | 'terminal.stop' | 'computer.call' | 'computer.stop' | 'operation.get'
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
export const remoteMutation = (method: ProjectRemoteMethod) => ['source.put', 'agent.start', 'terminal.open', 'terminal.write', 'terminal.resize', 'terminal.stop', 'computer.call', 'computer.stop'].includes(method)

export type EnvironmentResultFile = { path: string; baseRevision: string | null; baseContent: string | null; currentContent?: string | null; currentRevision?: string | null; received?: { revision: string; content: string } | null; state: 'pending' | 'staged' | 'applied' | 'declined' | 'conflict'; error?: string }
export type EnvironmentResultReview = { id: string; environmentId: string; generation: number; workspacePath: string; baseGitRevision: string | null; files: EnvironmentResultFile[] }
export type EnvironmentMemoryState = { state: 'disconnected' | 'connecting' | 'connected' | 'failed'; detail?: string }
export type ProjectEnvironmentApi = {
  environmentLumeList(workspacePath: string): Promise<{ storageDirectory: string; returnDirectory: string; admissionPath: string; guests: LumeEnvironment[] }>
  environmentLumeRegister(workspacePath: string, id: string, config: LumeEnvironmentConfig): Promise<LumeEnvironment>
  environmentLumeAction(workspacePath: string, id: string, action: 'start' | 'stop' | 'status' | 'show' | 'remove'): Promise<LumeEnvironment>
  environmentList(workspacePath: string): Promise<ProjectEnvironment[]>
  environmentConfigure(workspacePath: string, id: string, config: SshEnvironmentConfig): Promise<ProjectEnvironment>
  environmentConnect(workspacePath: string, id: string, generation: number): Promise<ProjectEnvironment>
  environmentRemove(workspacePath: string, id: string, generation: number): Promise<void>
  environmentPause(workspacePath: string, id: string, generation: number): Promise<ProjectEnvironment>
  environmentRequest(workspacePath: string, id: string, generation: number, method: ProjectRemoteMethod, params: Record<string, unknown>, requestId: string): Promise<unknown>
  environmentMemory(workspacePath: string, id: string, generation: number, action: 'start' | 'stop' | 'status'): Promise<EnvironmentMemoryState>
  environmentResultsList(workspacePath: string, id: string, generation: number): Promise<EnvironmentResultReview[]>
  environmentResultsCapture(workspacePath: string, id: string, generation: number, paths: string[]): Promise<EnvironmentResultReview>
  environmentResultsSend(workspacePath: string, reviewId: string): Promise<EnvironmentResultReview>
  environmentResultsStage(workspacePath: string, reviewId: string): Promise<EnvironmentResultReview>
  environmentResultsApply(workspacePath: string, reviewId: string, paths: string[]): Promise<EnvironmentResultReview>
  environmentResultsDecline(workspacePath: string, reviewId: string, paths: string[]): Promise<EnvironmentResultReview>
}

export type LumeEnvironmentConfig = { storageDirectory: string; name: string; machineIdentifierSha256: string; mounts: Array<{ path: string; mode: 'ro' | 'rw'; purpose: 'source' | 'results' }> }
export type LumeEnvironment = { retired?: boolean; id: string; projectKey: string; checkoutPath: string; config: LumeEnvironmentConfig; state: 'stopped' | 'starting' | 'running' | 'stopping' | 'unverifiable'; pid?: number; startedAt?: number; ipAddress?: string; detail?: string }
