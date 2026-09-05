import { RPC_COMMANDS } from '../shared/command-catalog.js'
import { commandUsage, parseCliArguments } from './arguments.js'
import { callRuntime, CliFailure, defaultUserData } from './rpc-client.js'
import { resolve } from 'node:path'
import { parseProjectMemoryMcpArguments, PROJECT_MEMORY_MCP_USAGE, runProjectMemoryMcp } from './project-memory-mcp.js'

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
    await runProjectMemoryMcp({ ...options, invoke: async (method, params) => {
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

export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
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
    const envelope = await callRuntime(parsed.command.method, parsed.params, parsed.userData ?? defaultUserData(), parsed.timeoutMs)
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
