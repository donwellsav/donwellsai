import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AgentHookEventKind,
  AgentHookSupport,
  AgentProviderDefinition
} from '@shared/agent-runtime'
import { unavailableAgentHooks } from '@shared/agent-runtime'
import { quoteWindowsCmdArgument } from '@shared/child-process/windows-command-line'

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
  command: string
  env: NodeJS.ProcessEnv
  hookSupport: AgentHookSupport
  cleanup: () => void
}

function quotePosix(value: string): string {
  if (value.includes('\0')) throw new Error('agent hook command cannot contain NUL')
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function shellCommand(args: readonly string[], platform: NodeJS.Platform): string {
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
  command: string
  provider?: AgentProviderDefinition
  binding: AgentHookBinding
  emitterCommand: readonly string[]
  runtimeDir: string
  inheritedEnv?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}): AgentLaunchPlan {
  const platform = options.platform ?? process.platform
  const env: NodeJS.ProcessEnv = {
    [AGENT_HOOK_ENV.socket]: options.binding.socketPath,
    [AGENT_HOOK_ENV.runId]: options.binding.runId,
    [AGENT_HOOK_ENV.sessionId]: options.binding.sessionId,
    [AGENT_HOOK_ENV.token]: options.binding.token
  }
  const noCleanup = (): void => {}
  if (!options.provider) {
    return {
      command: options.command,
      env,
      hookSupport: unavailableAgentHooks('No documented provider hook adapter matched this exact command.'),
      cleanup: noCleanup
    }
  }

  if (options.provider.id === 'codex') {
    return {
      command: appendArguments(
        options.command,
        codexHookArguments(options.emitterCommand, platform),
        platform
      ),
      env,
      hookSupport: { ...options.provider.hookSupport, events: [...options.provider.hookSupport.events] },
      cleanup: noCleanup
    }
  }

  if (options.provider.id === 'claude') {
    return {
      command: appendArguments(
        options.command,
        claudeHookArguments(options.emitterCommand, platform),
        platform
      ),
      env,
      hookSupport: { ...options.provider.hookSupport, events: [...options.provider.hookSupport.events] },
      cleanup: noCleanup
    }
  }

  if (options.provider.id !== 'opencode') {
    return {
      command: options.command,
      env,
      hookSupport: { ...options.provider.hookSupport, events: [] },
      cleanup: noCleanup
    }
  }

  if (options.inheritedEnv?.['OPENCODE_CONFIG_DIR']) {
    return {
      command: options.command,
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
  const pluginPath = join(pluginDir, 'runtime-status.mjs')
  writeFileSync(pluginPath, opencodePluginSource(options.emitterCommand), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx'
  })
  env['OPENCODE_CONFIG_DIR'] = configDir
  return {
    command: options.command,
    env,
    hookSupport: { ...options.provider.hookSupport, events: [...options.provider.hookSupport.events] },
    cleanup: () => rmSync(configDir, { recursive: true, force: true })
  }
}
