import { runProjectMemoryMcp } from '../cli/project-memory-mcp'
import { remoteMemoryRequest } from './project-remote-memory'
export { remoteMemoryRequest } from './project-remote-memory'

if (require.main === module) {
  const env = process.env, socket = env.DONWELLS_REMOTE_MEMORY_SOCKET, workspacePath = env.DONWELLS_REMOTE_MEMORY_ROOT
  const credential = { runId: env.DONWELLS_AGENT_HOOK_RUN_ID ?? '', sessionId: env.DONWELLS_AGENT_HOOK_SESSION_ID ?? '', token: env.DONWELLS_AGENT_HOOK_TOKEN ?? '' }
  if (!socket || !workspacePath || !credential.runId || !credential.token) throw new Error('Remote memory requires its daemon-owned agent session')
  void runProjectMemoryMcp({ workspacePath, harness: 'opencode', memoryOnly: true, invoke: (method, params) => remoteMemoryRequest(socket, method, params, credential) }).catch(error => { console.error(String(error)); process.exitCode = 1 })
}
