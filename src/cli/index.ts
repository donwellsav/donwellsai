import { RPC_COMMANDS } from '../shared/command-catalog.js'
import { commandUsage, parseCliArguments } from './arguments.js'
import { callRuntime, callTerminalDaemon, CliFailure, defaultUserData, type RpcEnvelope } from './rpc-client.js'
import { localRuntimePaths } from '../main/local-runtime.js'
import { RuntimeOwnershipStore } from '../shared/runtime-ownership.js'
import { inspectRuntimeRecovery, quarantineRuntime } from './runtime-recovery.js'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { parseProjectMemoryMcpArguments, PROJECT_MEMORY_MCP_USAGE, runProjectMemoryMcp } from './project-memory-mcp.js'
import { runtimeIdentityAuthority } from '../main/runtime-identity.js'

/**
 * Worker commands forward the daemon-issued per-session credential through
 * the terminal-daemon call; administrator commands use the explicit
 * administrator path and never upgrade the profile-global runtime token into
 * worker authority.
 */
async function callTaskAuthority(method: string, params: Record<string, unknown>, userData: string, timeoutMs: number): Promise<RpcEnvelope> {
  const credential = resolveWorkerCredential(params)
  const { credential: _omitted, credentialFile: _omittedFile, ...rest } = params
  // Only worker commands may auto-issue a per-session credential; administrator
  // commands stay on the explicit administrator path and never carry one.
  const workerAutoIssue = credential === undefined && (method === 'task.claim' || method === 'task.progress')
  if (method === 'task.progress') {
    const { token, detail } = rest
    if (typeof token !== 'object' || token === null || typeof detail !== 'string') {
      throw new CliFailure('INVALID_ARGUMENTS', 'task.progress requires --token <json> and --detail <text>')
    }
    const projectId = typeof (token as Record<string, unknown>)['projectId'] === 'string' ? (token as Record<string, unknown>)['projectId'] as string : undefined
    return callTerminalDaemon('task.write', { kind: 'progress', token, detail }, userData, timeoutMs, credential, workerAutoIssue ? projectId : undefined)
  }
  if (method === 'task.credential.issue') {
    return callTerminalDaemon('task.credential.issue', rest, userData, timeoutMs)
  }
  const projectId = typeof rest['projectId'] === 'string' ? rest['projectId'] as string : undefined
  return callTerminalDaemon(method, rest, userData, timeoutMs, credential, workerAutoIssue ? projectId : undefined)
}

function resolveWorkerCredential(params: Record<string, unknown>): { credentialId: string; token: string } | undefined {
  const inline = params['credential']
  if (inline !== undefined) {
    if (typeof inline !== 'object' || inline === null) throw new CliFailure('INVALID_ARGUMENTS', '--credential must be a JSON object')
    const record = inline as Record<string, unknown>
    if (typeof record['credentialId'] !== 'string' || typeof record['token'] !== 'string') {
      throw new CliFailure('INVALID_ARGUMENTS', '--credential requires credentialId and token strings')
    }
    return { credentialId: record['credentialId'], token: record['token'] }
  }
  const credentialFile = params['credentialFile']
  if (credentialFile === undefined) return undefined
  if (typeof credentialFile !== 'string' || credentialFile.length === 0) throw new CliFailure('INVALID_ARGUMENTS', '--credential-file requires a path')
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(credentialFile, 'utf8'))
  } catch (error) {
    throw new CliFailure('INVALID_ARGUMENTS', 'credential file could not be read as JSON: ' + (error instanceof Error ? error.message : String(error)))
  }
  if (typeof parsed !== 'object' || parsed === null) throw new CliFailure('INVALID_ARGUMENTS', 'credential file must contain a JSON object')
  const record = parsed as Record<string, unknown>
  if (typeof record['credentialId'] !== 'string' || typeof record['token'] !== 'string') {
    throw new CliFailure('INVALID_ARGUMENTS', 'credential file requires credentialId and token strings')
  }
  return { credentialId: record['credentialId'], token: record['token'] }
}

async function runMemoryMcp(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help')) {
    console.log(PROJECT_MEMORY_MCP_USAGE + ' [--user-data <directory>]\nLocal stdio MCP server pinned to one registered project.')
    return 0
  }
  try {
    const memoryArgs: string[] = []
    let userData: string | undefined
    for (let index = 0; index < argv.length; index++) {
      const argument = argv[index]!
      if (argument === '--user-data' || argument.startsWith('--user-data=')) {
        if (userData !== undefined) throw new Error('--user-data may only be specified once')
        const value = argument === '--user-data' ? argv[++index] : argument.slice(12)
        if (!value || value.startsWith('--')) throw new Error('--user-data requires a directory')
        userData = resolve(value)
      } else memoryArgs.push(argument)
    }
    const options = parseProjectMemoryMcpArguments(memoryArgs)
    const { DONWELLS_AGENT_HOOK_RUN_ID: runId, DONWELLS_AGENT_HOOK_SESSION_ID: sessionId, DONWELLS_AGENT_HOOK_TOKEN: token } = process.env
    const credential = runId && sessionId && token ? { runId, sessionId, token } : undefined
    await runProjectMemoryMcp({ ...options, credential, invoke: async (method, params) => {
      const envelope = await callRuntime(method, params, userData ?? defaultUserData(), 30_000)
      if (!envelope.ok) throw new CliFailure(envelope.code ?? 'MEMORY_FAILED', envelope.error ?? 'Project memory request failed')
      return envelope.result
    } })
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}
function recoveryKind(value: string | undefined): 'donwells-app' | 'terminal-daemon' {
  if (value === undefined || value === 'app' || value === 'donwells-app') return 'donwells-app'
  if (value === 'terminal' || value === 'terminal-daemon') return 'terminal-daemon'
  throw new Error('--kind must be app or terminal')
}

async function runRuntimeRecovery(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.length === 0) {
    console.log('Usage: donwells runtime-recovery <inspect|quarantine> --kind app|terminal --user-data <exact-directory> [--confirm <sha256>]')
    return argv.length === 0 ? 2 : 0
  }
  try {
    const action = argv[0]
    if (action !== 'inspect' && action !== 'quarantine') throw new Error('runtime-recovery action must be inspect or quarantine')
    let userData: string | undefined
    let kind: 'donwells-app' | 'terminal-daemon' | undefined
    let confirm: string | undefined
    for (let index = 1; index < argv.length; index++) {
      const argument = argv[index]!
      const next = (): string => {
        const value = argv[++index]
        if (!value || value.startsWith('--')) throw new Error(argument + ' requires a value')
        return value
      }
      if (argument === '--user-data') userData = resolve(next())
      else if (argument.startsWith('--user-data=')) userData = resolve(argument.slice(12))
      else if (argument === '--kind') kind = recoveryKind(next())
      else if (argument.startsWith('--kind=')) kind = recoveryKind(argument.slice(7))
      else if (argument === '--confirm') confirm = next()
      else if (argument.startsWith('--confirm=')) confirm = argument.slice(10)
      else throw new Error('unknown runtime-recovery option: ' + argument)
    }
    if (userData === undefined) throw new Error('runtime-recovery requires --user-data <exact-directory>')
    if (kind === undefined) throw new Error('runtime-recovery requires --kind app|terminal')
    const runtimeKind = kind
    if (action === 'inspect') {
      console.log(JSON.stringify({ ok: true, inspection: inspectRuntimeRecovery({ userDataDir: userData, kind: runtimeKind }) }, null, 2))
      return 0
    }
    if (!confirm) throw new Error('quarantine requires --confirm <sha256>')
    const paths = localRuntimePaths(userData, runtimeKind === 'donwells-app' ? 'app' : 'terminal')
    const store = new RuntimeOwnershipStore(paths.ownershipDatabasePath)
    try {
      const result = quarantineRuntime({ userDataDir: userData, kind: runtimeKind, store, authority: runtimeIdentityAuthority(), confirm })
      console.log(JSON.stringify({ ok: true, recovery: result }, null, 2))
      return 0
    } finally {
      store.close()
    }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'RECOVERY_FAILED'
    console.log(JSON.stringify({ ok: false, code, error: error instanceof Error ? error.message : String(error) }))
    return 1
  }
}
export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv[0] === 'runtime-recovery') return runRuntimeRecovery(argv.slice(1))
  if (argv[0] === 'memory-mcp') return runMemoryMcp(argv.slice(1))
  let parsed: ReturnType<typeof parseCliArguments>
  try { parsed = parseCliArguments(argv) } catch (error) {
    console.log(JSON.stringify({ ok: false, code: 'INVALID_ARGUMENTS', error: error instanceof Error ? error.message : String(error) }))
    return 2
  }
  if (parsed.help || !parsed.command) {
    if (parsed.command) console.log(commandUsage(parsed.command) + '\n' + parsed.command.summary)
    else {
      console.log('donwells.ai command-line interface\nUsage: donwells <command> [arguments] [options]\n')
      for (const command of RPC_COMMANDS) console.log(commandUsage(command).padEnd(66) + "  " + command.summary)
      console.log(PROJECT_MEMORY_MCP_USAGE + '  Serve project memory to coding harnesses over MCP')
    }
    console.log('\nOptions: --user-data <directory>, --text | --json, --params <json>, --timeout-ms <100..120000>, --dry-run, --help\nUse -- before a literal argument beginning with --. Mutations are never retried automatically.')
    return 0
  }
  if (parsed.dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, method: parsed.command.method, effect: parsed.command.effect, params: parsed.params }, null, parsed.text ? 2 : undefined))
    return 0
  }
  try {
    const userData = parsed.userData ?? defaultUserData()
    // The daemon owns the authority database, the maintenance gate, and the
    // migration; task, migration, and maintenance commands all speak its wire.
    if (parsed.command.method.startsWith('task.') || parsed.command.method.startsWith('maintenance.')) {
      const envelope = await callTaskAuthority(parsed.command.method, parsed.params, userData, parsed.timeoutMs)
      if (parsed.text && !envelope.ok) console.error((envelope.code ?? 'COMMAND_FAILED') + ': ' + envelope.error)
      else console.log(JSON.stringify(parsed.text ? envelope.result : envelope, null, parsed.text ? 2 : undefined))
      return envelope.ok ? 0 : 1
    }
    const envelope = await callRuntime(parsed.command.method, parsed.params, userData, parsed.timeoutMs)
    if (parsed.text && !envelope.ok) console.error(envelope.code + ': ' + envelope.error)
    else console.log(JSON.stringify(parsed.text ? envelope.result : envelope, null, parsed.text ? 2 : undefined))
    return envelope.ok ? 0 : 1
  } catch (error) {
    const failure = { ok: false, code: error instanceof CliFailure ? error.code : 'COMMAND_FAILED', error: error instanceof Error ? error.message : String(error) }
    if (parsed.text) console.error(failure.code + ': ' + failure.error)
    else console.log(JSON.stringify(failure))
    return 1
  }
}

if (require.main === module) void runCli().then(code => { process.exitCode = code })
