import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AgentExecutable,
  AgentHookEventKind,
  AgentHookSupport,
  AgentProviderDefinition
} from '@shared/agent-runtime'
import { parseAgentExecutable, unavailableAgentHooks } from '@shared/agent-runtime'
import type { ProviderCommandSpec } from '@shared/provider-authority'
import { quoteWindowsCmdArgument } from '@shared/child-process/windows-command-line'
import { windowsSystem32Binary } from '@shared/child-process/windows-system-binary'

export const AGENT_HOOK_ENV = {
  socket: 'DONWELLS_AGENT_HOOK_SOCKET',
  runId: 'DONWELLS_AGENT_HOOK_RUN_ID',
  sessionId: 'DONWELLS_AGENT_HOOK_SESSION_ID',
  token: 'DONWELLS_AGENT_HOOK_TOKEN'
} as const

export type AgentHookBinding = {
  socketPath: string
  runId: string
  sessionId: string
  token: string
}

export type AgentLaunchPlan = {
  launch?: AgentExecutable
  command: string
  env: NodeJS.ProcessEnv
  hookSupport: AgentHookSupport
  cleanup: () => void
}

/**
 * A resolved provider command: the executable and argv a launch actually runs.
 *
 * `driver` mode resolves through the driver registry (never through caller
 * text), so a caller cannot smuggle an alternate executable, home, config root,
 * credential helper, or shell past the driver's own argument policy.
 */
export type ResolvedProviderInvocation = Readonly<{
  kind: ProviderCommandSpec['kind']
  /** Program handed to the process launcher (a shell for a shell program). */
  program: string
  args: readonly string[]
  /** Exact argv retained for driver-owned hook injection; absent for shell programs. */
  launch?: AgentExecutable
}>

export class ProviderInvocationError extends Error {
  readonly code: 'EXECUTABLE_UNRESOLVED' | 'COMMAND_SHAPE_INVALID'

  constructor(code: ProviderInvocationError['code'], message: string) {
    super(message)
    this.name = 'ProviderInvocationError'
    this.code = code
  }
}

/**
 * Resolves one provider command spec into the exact program and argv a launch
 * runs. This is the only `driver` path, in every credential mode: the
 * executable comes from driver resolution and the arguments from the driver's
 * own policy, so a `driver` instance can never be pointed at an arbitrary
 * program by its configuration.
 *
 * `external-argv` and `external-shell` are the explicit custom-command escape
 * hatch. They execute only their own literal spec, which is also why managed
 * credentials are refused for them: a custom command has no reviewed argument
 * policy for an environment overlay to bind to.
 */
export function resolveProviderInvocation(options: {
  command: ProviderCommandSpec
  /** Driver executable resolved by the registry; absent when discovery failed. */
  driverExecutable?: string
  platform?: NodeJS.Platform
  /** Shell used only for the `external-shell` kind. */
  shellPath?: string
}): ResolvedProviderInvocation {
  const platform = options.platform ?? process.platform
  if (options.command.kind === 'driver') {
    const executable = options.driverExecutable
    if (executable === undefined || executable.length === 0) {
      throw new ProviderInvocationError('EXECUTABLE_UNRESOLVED', `driver ${options.command.driverId} executable could not be resolved`)
    }
    return { kind: 'driver', program: executable, args: [], launch: { executable, args: [] } }
  }
  if (options.command.kind === 'external-argv') {
    const executable = options.command.executable.executable
    if (executable.length === 0) throw new ProviderInvocationError('COMMAND_SHAPE_INVALID', 'external argv command has no executable')
    const args = [...options.command.executable.args]
    return { kind: 'external-argv', program: executable, args, launch: { executable, args: [...args] } }
  }
  const program = options.command.program
  if (program.length === 0) throw new ProviderInvocationError('COMMAND_SHAPE_INVALID', 'external shell command has no program')
  const shellPath = options.shellPath ?? defaultProviderShell(platform)
  return {
    kind: 'external-shell',
    program: shellPath,
    args: platform === 'win32' ? ['/d', '/s', '/c', program] : ['-c', program]
  }
}

function defaultProviderShell(platform: NodeJS.Platform): string {
  if (platform === 'win32') return process.env.ComSpec ?? windowsSystem32Binary('cmd.exe')
  return process.env.SHELL || '/bin/sh'
}

function quotePosix(value: string): string {
  if (value.includes('\0')) throw new Error('agent hook command cannot contain NUL')
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function shellCommand(args: readonly string[], platform: NodeJS.Platform): string {
  if (args.length === 0) throw new Error('agent hook command is empty')
  return args
    .map((argument) => platform === 'win32' ? quoteWindowsCmdArgument(argument) : quotePosix(argument))
    .join(' ')
}

function hookCommand(
  emitterCommand: readonly string[],
  event: AgentHookEventKind,
  platform: NodeJS.Platform
): string {
  const command = shellCommand([...emitterCommand, event], platform)
  return platform === 'win32'
    ? `set "ELECTRON_RUN_AS_NODE=1" && ${command}`
    : `ELECTRON_RUN_AS_NODE=1 ${command}`
}


function appendArguments(command: string, args: readonly string[], platform: NodeJS.Platform): string {
  return `${shellCommand([command], platform)} ${args.map((argument) => (
    platform === 'win32' ? quoteWindowsCmdArgument(argument) : quotePosix(argument)
  )).join(' ')}`
}

function codexHookArguments(emitterCommand: readonly string[], platform: NodeJS.Platform): string[] {
  const events: readonly [string, AgentHookEventKind][] = [
    ['SessionStart', 'working'],
    ['UserPromptSubmit', 'working'],
    ['PreToolUse', 'working'],
    ['PermissionRequest', 'permission'],
    ['Stop', 'waiting'],
    ['Interrupt', 'waiting'],
    ['SessionEnd', 'completed']
  ]
  return events.flatMap(([providerEvent, event]) => {
    const command = JSON.stringify(hookCommand(emitterCommand, event, platform))
    return [
      '-c',
      `hooks.${providerEvent}=[{ hooks=[{ type="command", command=${command}, timeout=5 }] }]`
    ]
  })
}

function claudeHookArguments(emitterCommand: readonly string[], platform: NodeJS.Platform): string[] {
  const events: readonly [string, AgentHookEventKind][] = [
    ['SessionStart', 'working'],
    ['UserPromptSubmit', 'working'],
    ['PreToolUse', 'working'],
    ['PermissionRequest', 'permission'],
    ['Notification', 'waiting'],
    ['Stop', 'waiting'],
    ['StopFailure', 'failed'],
    ['SessionEnd', 'completed']
  ]
  const hooks: Record<string, unknown> = {}
  for (const [providerEvent, event] of events) {
    hooks[providerEvent] = [{
      hooks: [{ type: 'command', command: hookCommand(emitterCommand, event, platform), timeout: 5 }]
    }]
  }
  return ['--settings', JSON.stringify({ hooks })]
}

function opencodePluginSource(emitterCommand: readonly string[]): string {
  return `import { spawn } from 'node:child_process'\n\nconst emitter = ${JSON.stringify(emitterCommand)}\n\nfunction emit(kind, detail) {\n  const { promise, resolve } = Promise.withResolvers()\n  const child = spawn(emitter[0], [...emitter.slice(1), kind], {\n    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },\n    stdio: ['pipe', 'ignore', 'ignore']\n  })\n  child.once('error', () => resolve())\n  child.once('close', () => resolve())\n  child.stdin.end(JSON.stringify(detail ? { detail } : {}))\n  return promise\n}\n\nexport const RuntimeStatusPlugin = async () => ({\n  'tool.execute.before': async (input) => {\n    await emit('working', typeof input?.tool === 'string' ? input.tool : undefined)\n  },\n  event: async ({ event }) => {\n    if (event?.type === 'permission.asked') await emit('permission', 'Permission requested')\n    else if (event?.type === 'session.idle') await emit('waiting')\n    else if (event?.type === 'session.error') await emit('failed')\n    else if (event?.type === 'session.created') await emit('working')\n    else if (event?.type === 'session.deleted') await emit('completed')\n  }\n})\n`
}

/** Build only per-run overrides; never mutate project or user provider settings. */
export function createAgentLaunchPlan(options: {
  launch?: AgentExecutable
  command: string
  provider?: AgentProviderDefinition
  binding: AgentHookBinding
  emitterCommand: readonly string[]
  runtimeDir: string
  inheritedEnv?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}): AgentLaunchPlan {
  if (options.launch) options = { ...options, launch: parseAgentExecutable(options.launch) }
  const platform = options.platform ?? process.platform
  const base = { command: options.command, ...(options.launch ? { launch: options.launch } : {}) }
  const withArguments = (args: string[]) => options.launch
    ? { ...base, launch: { ...options.launch, args: [...options.launch.args, ...args] } }
    : { command: appendArguments(options.command, args, platform) }
  const env: NodeJS.ProcessEnv = {
    ...(options.launch?.hermesHome ? { HERMES_HOME: options.launch.hermesHome } : {}),
    ...(options.launch?.dshHome ? { DSH_HOME: options.launch.dshHome } : {}),
    [AGENT_HOOK_ENV.socket]: options.binding.socketPath,
    [AGENT_HOOK_ENV.runId]: options.binding.runId,
    [AGENT_HOOK_ENV.sessionId]: options.binding.sessionId,
    [AGENT_HOOK_ENV.token]: options.binding.token
  }
  const noCleanup = (): void => {}
  if (!options.provider) {
    return {
      ...base,
      env,
      hookSupport: unavailableAgentHooks('No documented provider hook adapter matched this exact command.'),
      cleanup: noCleanup
    }
  }

  if (options.provider.id === 'codex') {
    return {
      ...withArguments(codexHookArguments(options.emitterCommand, platform)),
      env,
      hookSupport: { ...options.provider.hookSupport, events: [...options.provider.hookSupport.events] },
      cleanup: noCleanup
    }
  }

  if (options.provider.id === 'claude') {
    return {
      ...withArguments(claudeHookArguments(options.emitterCommand, platform)),
      env,
      hookSupport: { ...options.provider.hookSupport, events: [...options.provider.hookSupport.events] },
      cleanup: noCleanup
    }
  }

  if (options.provider.id !== 'opencode') {
    return {
      ...base,
      env,
      hookSupport: { ...options.provider.hookSupport, events: [] },
      cleanup: noCleanup
    }
  }

  if (options.inheritedEnv?.['OPENCODE_CONFIG_DIR']) {
    return {
      ...base,
      env,
      hookSupport: unavailableAgentHooks(
        'The existing OPENCODE_CONFIG_DIR was preserved; a per-run plugin was not injected.'
      ),
      cleanup: noCleanup
    }
  }

  const configDir = join(options.runtimeDir, 'agent-hooks', options.binding.runId)
  const pluginDir = join(configDir, 'plugins')
  mkdirSync(pluginDir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(pluginDir, 0o700)
  const pluginPath = join(pluginDir, 'runtime-status.js')
  writeFileSync(pluginPath, opencodePluginSource(options.emitterCommand), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx'
  })
  env['OPENCODE_CONFIG_DIR'] = configDir
  return {
    ...base,
    env,
    hookSupport: { ...options.provider.hookSupport, events: [...options.provider.hookSupport.events] },
    cleanup: () => rmSync(configDir, { recursive: true, force: true })
  }
}
