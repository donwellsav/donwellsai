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
  launchArgs?: string[]
}): Promise<{ path: string; changed: boolean; backupPath?: string; launchArgs?: string[]; setupArgs?: string[] }> {
  const { files, workspacePath, provider, userDataDir, executable, cliPath } = options
  if (provider === 'hermes') {
    const args = options.launchArgs ?? []
    if (!Array.isArray(args) || args.length > 256 || args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) throw new Error('Invalid Hermes launch arguments')
    const profileArgs: string[] = []
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]
      if (arg === '--' || arg === '--args') break
      if (arg === '--profile' || arg === '-p' || arg.startsWith('--profile=')) {
        const profile = arg.startsWith('--profile=') ? arg.slice('--profile='.length) : args[++index]
        if (!profile || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile)) throw new Error('Choose a valid Hermes profile before setup')
        if (profileArgs.length) throw new Error('Choose one Hermes profile before setup')
        profileArgs.push('--profile', profile)
      }
    }
    return { path: 'config.yaml', changed: false, setupArgs: [
      ...profileArgs, 'mcp', 'add', 'donwells-project-memory', '--command', executable,
      '--env', 'ELECTRON_RUN_AS_NODE=1',
      ...['DONWELLS_AGENT_HOOK_RUN_ID', 'DONWELLS_AGENT_HOOK_SESSION_ID', 'DONWELLS_AGENT_HOOK_TOKEN'].map(name => `${name}=\${${name}}`),
      '--args', cliPath, 'memory-mcp',
      '--workspace', '${workspaceFolder}', '--harness', provider, '--user-data', userDataDir
    ] }
  }
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
    // DSH scrubs inherited credentials; its native loader resolves these at launch, never at setup.
    const env = { ...server.env, ...Object.fromEntries(
      ['DONWELLS_AGENT_HOOK_RUN_ID', 'DONWELLS_AGENT_HOOK_SESSION_ID', 'DONWELLS_AGENT_HOOK_TOKEN']
        .map(name => [name, { __jsExpr: `process.env.${name} ?? ""` }])
    ) }
    const patch = [{ insert: [{ id: 'donwells-project-memory', name: '@deepseek-ai/dsh-mcp-client', config: {
      serverName: 'donwells-project-memory', transport: 'stdio', ...server, env, failOnStartupError: true, reconnect: { enabled: false }
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
