import { lstat, mkdtemp, open } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { AgentMemorySetupResult } from '../../shared/types'
import type { GitWorktrees } from '../git'

export async function configureAgentMemory(options: {
  files: Pick<GitWorktrees, 'readFile' | 'writeFile' | 'createWorkspaceEntry'>
  workspacePath: string
  provider: string
  userDataDir: string
  executable: string
  cliPath: string
  launchArgs?: string[]
  replacement?: { action: 'preview' } | { action: 'apply'; revision: string }
}): Promise<AgentMemorySetupResult> {
  const { files, workspacePath, provider, userDataDir, executable, cliPath } = options
  if (options.replacement !== undefined) {
    const replacement = options.replacement as unknown
    if (!replacement || typeof replacement !== 'object' || Array.isArray(replacement)) throw new Error('Invalid memory configuration replacement request')
    const value = replacement as Record<string, unknown>, keys = Object.keys(value)
    if (value.action === 'preview') {
      if (keys.length !== 1) throw new Error('Invalid memory configuration replacement request')
    } else if (value.action === 'apply') {
      if (keys.length !== 2 || typeof value.revision !== 'string' || !value.revision || value.revision.length > 256 || /[\x00-\x1f\x7f]/.test(value.revision)) throw new Error('Invalid memory configuration replacement request')
    } else throw new Error('Invalid memory configuration replacement request')
  }
  const server = { command: executable, args: [cliPath, 'memory-mcp', '--workspace', workspacePath, '--harness', provider, '--user-data', userDataDir], env: { ELECTRON_RUN_AS_NODE: '1' } }
  if (provider === 'codex') {
    const literal = (value: string | string[]) => JSON.stringify(value).replace(/\x7f/g, '\\u007f')
    return { path: 'session', changed: false, launchArgs: ['-c', `mcp_servers.donwells-project-memory={command=${literal(server.command)},args=${literal(server.args)},env={ELECTRON_RUN_AS_NODE="1"},env_vars=${literal(['DONWELLS_AGENT_HOOK_RUN_ID', 'DONWELLS_AGENT_HOOK_SESSION_ID', 'DONWELLS_AGENT_HOOK_TOKEN'])}}`] }
  }
  if (provider === 'claude') return { path: 'session', changed: false, launchArgs: ['--mcp-config', JSON.stringify({ mcpServers: { 'donwells-project-memory': server } })] }
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
  const exists = async (relative: string): Promise<boolean> => {
    try { await lstat(join(workspacePath, relative)); return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  }
  const snapshot = await exists(path) ? await files.readFile(workspacePath, path) : undefined
  if (options.replacement?.action === 'apply' && (!snapshot?.revision || options.replacement.revision !== snapshot.revision)) throw new Error(`${path} changed after review; it was left unchanged`)
  const replace = async (content: string): Promise<string> => {
    if (!snapshot?.revision) throw new Error(`${path} changed after review; it was left unchanged`)
    const backupPath = join(await mkdtemp(join(userDataDir, 'agent-config-backup-')), 'mcp.json')
    const backup = await open(backupPath, 'wx', 0o600)
    try { await backup.writeFile(snapshot.content); await backup.sync() } finally { await backup.close() }
    await files.writeFile(workspacePath, path, content, snapshot.revision)
    return backupPath
  }
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
      if (!isDeepStrictEqual(existing, patch)) {
        if (!options.replacement) throw new Error(`${path} has different content; it was left unchanged`)
        if (options.replacement.action === 'preview') return { path, changed: false, launchArgs, replacement: { revision: snapshot.revision, current: existing, proposed: patch } }
        return { path, changed: true, launchArgs, backupPath: await replace(JSON.stringify(patch, null, 2) + '\n') }
      }
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
    if (!options.replacement) throw new Error(`${path} already has a different donwells-project-memory entry; it was left unchanged`)
    if (options.replacement.action === 'preview') return { path, changed: false, replacement: { revision: snapshot!.revision!, current: entries['donwells-project-memory'], proposed: server } }
  }
  const content = JSON.stringify({ ...config, mcpServers: { ...entries, 'donwells-project-memory': server } }, null, 2) + '\n'
  if (!snapshot) {
    if (!await exists(directory)) await files.createWorkspaceEntry(workspacePath, { path: directory, kind: 'dir' })
    await files.createWorkspaceEntry(workspacePath, { path, kind: 'file', content })
    return { path, changed: true }
  }
  return { path, changed: true, backupPath: await replace(content) }
}
