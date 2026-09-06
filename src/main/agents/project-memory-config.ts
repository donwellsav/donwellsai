import { lstat, mkdtemp, open } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { GitWorktrees } from '../git'

export async function configureAgentMemory(options: {
  files: Pick<GitWorktrees, 'readFile' | 'writeFile' | 'createWorkspaceEntry'>
  workspacePath: string
  provider: string
  userDataDir: string
  executable: string
  cliPath: string
}): Promise<{ path: string; changed: boolean; backupPath?: string; launchArgs?: string[] }> {
  const { files, workspacePath, provider, userDataDir, executable, cliPath } = options
  if (provider !== 'omp' && provider !== 'kimi' && provider !== 'deepseek-harness') throw new Error('Native memory setup is not yet available for this provider')
  const directory = provider === 'omp' ? '.omp' : provider === 'kimi' ? '.kimi-code' : '.dsh'
  const path = `${directory}/${provider === 'deepseek-harness' ? 'donwells-memory.patch.json' : 'mcp.json'}`
  const server = { command: executable, args: [cliPath, 'memory-mcp', '--workspace', workspacePath, '--harness', provider, '--user-data', userDataDir], env: { ELECTRON_RUN_AS_NODE: '1' } }
  const exists = async (relative: string): Promise<boolean> => {
    try { await lstat(join(workspacePath, relative)); return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  }
  const snapshot = await exists(path) ? await files.readFile(workspacePath, path) : undefined
  if (provider === 'deepseek-harness') {
    const patch = [{ insert: [{ id: 'donwells-project-memory', name: '@deepseek-ai/dsh-mcp-client', config: {
      serverName: 'donwells-project-memory', transport: 'stdio', ...server, failOnStartupError: true, reconnect: { enabled: false }
    } }] }]
    const launchArgs = ['--patch', join(workspacePath, path)]
    if (snapshot) {
      if (!snapshot.revision || snapshot.binary || snapshot.truncated) throw new Error(`${path} must be a complete, stable text file`)
      let existing: unknown
      try { existing = JSON.parse(snapshot.content) } catch { throw new Error(`${path} is not valid JSON; it was left unchanged`) }
      if (!isDeepStrictEqual(existing, patch)) throw new Error(`${path} has different content; it was left unchanged`)
      return { path, changed: false, launchArgs }
    }
    if (!await exists(directory)) await files.createWorkspaceEntry(workspacePath, { path: directory, kind: 'dir' })
    await files.createWorkspaceEntry(workspacePath, { path, kind: 'file', content: JSON.stringify(patch, null, 2) + '\n' })
    return { path, changed: true, launchArgs }
  }
  let config: Record<string, unknown> = {}
  if (snapshot) {
    if (!snapshot.revision || snapshot.binary || snapshot.truncated) throw new Error(`${path} must be a complete, stable text file`)
    try { config = JSON.parse(snapshot.content) } catch { throw new Error(`${path} is not valid JSON; it was left unchanged`) }
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`${path} must contain a JSON object`)
  }
  const servers = config.mcpServers === undefined ? {} : config.mcpServers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error(`${path} mcpServers must be an object`)
  const entries = servers as Record<string, unknown>
  if (Object.hasOwn(entries, 'donwells-project-memory')) {
    if (isDeepStrictEqual(entries['donwells-project-memory'], server)) return { path, changed: false }
    // ponytail: never infer ownership from a server name; managed upgrades need a stored ownership receipt.
    throw new Error(`${path} already has a different donwells-project-memory entry; it was left unchanged`)
  }
  const content = JSON.stringify({ ...config, mcpServers: { ...entries, 'donwells-project-memory': server } }, null, 2) + '\n'
  if (!snapshot) {
    if (!await exists(directory)) await files.createWorkspaceEntry(workspacePath, { path: directory, kind: 'dir' })
    await files.createWorkspaceEntry(workspacePath, { path, kind: 'file', content })
    return { path, changed: true }
  }
  const backupPath = join(await mkdtemp(join(userDataDir, 'agent-config-backup-')), 'mcp.json')
  const backup = await open(backupPath, 'wx', 0o600)
  try { await backup.writeFile(snapshot.content); await backup.sync() } finally { await backup.close() }
  await files.writeFile(workspacePath, path, content, snapshot.revision)
  return { path, changed: true, backupPath }
}
