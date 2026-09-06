import type { TerminalSession } from './types'

export const AGENT_PROVIDER_IDS = [
  'codex',
  'claude',
  'pi',
  'opencode',
  'cursor-agent',
  'qwen-code',
  'goose',
  'omp',
  'hermes',
  'kimi',
  'deepseek-harness'
] as const

export type AgentProviderId = (typeof AGENT_PROVIDER_IDS)[number]
export type AgentLiveness = 'live' | 'unverifiable' | 'exited'
export type AgentActivity =
  | 'starting'
  | 'working'
  | 'waiting'
  | 'permission'
  | 'stopping'
  | 'completed'
  | 'failed'
export type AgentHookEventKind = 'working' | 'waiting' | 'permission' | 'completed' | 'failed'
export type AgentHookAdapter = 'codex-hooks' | 'claude-hooks' | 'opencode-plugin'

export type AgentHookSupport =
  | {
      support: 'native'
      adapter: AgentHookAdapter
      events: AgentHookEventKind[]
      documentationUrl: string
    }
  | {
      support: 'unavailable'
      events: AgentHookEventKind[]
      reason: string
    }

export type AgentSkillConsumer =
  | {
      supported: true
      /** Workspace-relative native discovery root. */
      root: string
      discovery: 'native'
    }
  | {
      supported: false
      reason: string
    }

export type AgentPreset = {
  id: AgentProviderId
  name: string
  command: string
  available: boolean
  executablePath?: string
  readiness?: { installed: boolean; launchable: 'unverified' | 'unavailable'; authenticated: 'unknown'; memoryConnected: false }
  hookSupport: AgentHookSupport
  skillConsumer: AgentSkillConsumer
}

export type RunningAgent = {
  launch?: AgentExecutable
  id: string
  sessionId: string
  workspacePath: string
  command: string
  presetId?: AgentProviderId
  startedAt: string
  updatedAt: string
  liveness: AgentLiveness
  activity: AgentActivity
  detail?: string
  hook: AgentHookSupport & {
    connected: boolean
    lastEventAt?: string
  }
  exitCode?: number
  stopRequestedAt?: string
}

export type AgentStartResult = {
  run: RunningAgent
  session: TerminalSession
}


export const AGENT_HOOK_DETAIL_MAX = 240
export const AGENT_HOOK_INPUT_MAX_BYTES = 64 * 1024

export type AgentHookMessage = {
  kind: AgentHookEventKind
  detail?: string
}

export type AgentProviderDefinition = {
  id: AgentProviderId
  name: string
  command: string
  hookSupport: AgentHookSupport
  skillConsumer: AgentSkillConsumer
}

const UNSUPPORTED_HOOK_REASON = 'No documented per-run hook adapter is registered for this CLI.'
const UNSUPPORTED_SKILL_REASON = 'No documented workspace skill discovery root is registered for this CLI.'

export const AGENT_PROVIDER_DEFINITIONS: readonly AgentProviderDefinition[] = [
  {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    hookSupport: {
      support: 'native',
      adapter: 'codex-hooks',
      events: ['working', 'waiting', 'permission', 'completed'],
      documentationUrl: 'https://developers.openai.com/codex/hooks'
    },
    skillConsumer: { supported: true, root: '.agents/skills', discovery: 'native' }
  },
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    hookSupport: {
      support: 'native',
      adapter: 'claude-hooks',
      events: ['working', 'waiting', 'permission', 'completed', 'failed'],
      documentationUrl: 'https://code.claude.com/docs/en/hooks'
    },
    skillConsumer: { supported: true, root: '.claude/skills', discovery: 'native' }
  },
  {
    id: 'pi',
    name: 'Pi',
    command: 'pi',
    hookSupport: { support: 'unavailable', events: [], reason: UNSUPPORTED_HOOK_REASON },
    skillConsumer: { supported: false, reason: UNSUPPORTED_SKILL_REASON }
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    hookSupport: {
      support: 'native',
      adapter: 'opencode-plugin',
      events: ['working', 'waiting', 'permission', 'completed', 'failed'],
      documentationUrl: 'https://opencode.ai/docs/plugins/'
    },
    skillConsumer: { supported: true, root: '.opencode/skills', discovery: 'native' }
  },
  {
    id: 'cursor-agent',
    name: 'Cursor Agent',
    command: 'cursor-agent',
    hookSupport: { support: 'unavailable', events: [], reason: UNSUPPORTED_HOOK_REASON },
    skillConsumer: { supported: false, reason: UNSUPPORTED_SKILL_REASON }
  },
  {
    id: 'qwen-code',
    name: 'Qwen Code',
    command: 'qwen-code',
    hookSupport: { support: 'unavailable', events: [], reason: UNSUPPORTED_HOOK_REASON },
    skillConsumer: { supported: false, reason: UNSUPPORTED_SKILL_REASON }
  },
  {
    id: 'goose',
    name: 'Goose',
    command: 'goose',
    hookSupport: { support: 'unavailable', events: [], reason: UNSUPPORTED_HOOK_REASON },
    skillConsumer: { supported: false, reason: UNSUPPORTED_SKILL_REASON }
  },
  {
    id: 'omp',
    name: 'Oh My Pi',
    command: 'omp',
    hookSupport: { support: 'unavailable', events: [], reason: UNSUPPORTED_HOOK_REASON },
    skillConsumer: { supported: false, reason: UNSUPPORTED_SKILL_REASON }
  },
  {
    id: 'hermes', name: 'Hermes', command: 'hermes',
    hookSupport: { support: 'unavailable', events: [], reason: UNSUPPORTED_HOOK_REASON },
    skillConsumer: { supported: false, reason: UNSUPPORTED_SKILL_REASON }
  },
  {
    id: 'kimi', name: 'Kimi CLI', command: 'kimi',
    hookSupport: { support: 'unavailable', events: [], reason: UNSUPPORTED_HOOK_REASON },
    skillConsumer: { supported: false, reason: UNSUPPORTED_SKILL_REASON }
  },
  {
    id: 'deepseek-harness', name: 'DeepSeek Harness', command: 'dsh',
    hookSupport: { support: 'unavailable', events: [], reason: UNSUPPORTED_HOOK_REASON },
    skillConsumer: { supported: false, reason: UNSUPPORTED_SKILL_REASON }
  },

]

const AGENT_HOOK_KINDS: Record<AgentHookEventKind, true> = {
  working: true,
  waiting: true,
  permission: true,
  completed: true,
  failed: true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAgentHookKind(value: unknown): value is AgentHookEventKind {
  return typeof value === 'string' && Object.hasOwn(AGENT_HOOK_KINDS, value)
}

export function normalizeAgentHookMessage(value: unknown): AgentHookMessage | null {
  if (!isRecord(value) || !isAgentHookKind(value['kind'])) return null
  if (value['detail'] !== undefined && typeof value['detail'] !== 'string') return null
  const detail = typeof value['detail'] === 'string'
    ? value['detail'].replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, AGENT_HOOK_DETAIL_MAX)
    : undefined
  return detail ? { kind: value['kind'], detail } : { kind: value['kind'] }
}

/** Only an exact registry command or executable path receives provider-specific hooks. */
export function agentProviderForCommand(command: string): AgentProviderDefinition | undefined {
  const trimmed = command.trim()
  if (!trimmed || /[\s;&|<>`$]/.test(trimmed)) return undefined
  return agentProviderForExecutable(trimmed)
}

export function unavailableAgentHooks(reason: string): AgentHookSupport {
  return { support: 'unavailable', events: [], reason }
}

/** Explicit argv bypasses shell parsing; legacy command strings remain a separate path. */
export type AgentExecutable = { executable: string; args: string[] }
export function parseAgentExecutable(value: unknown): AgentExecutable {
  if (!isRecord(value) || Object.keys(value).some(key => key !== 'executable' && key !== 'args') || typeof value.executable !== 'string' || !value.executable.trim() || value.executable.includes('\0')) throw new Error('Invalid agent executable')
  const args = value.args ?? []
  if (!Array.isArray(args) || args.length > 256 || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Invalid agent arguments')
  if (new TextEncoder().encode(JSON.stringify([value.executable, args])).length > 16 * 1024) throw new Error('Agent executable and arguments exceed limit')
  return { executable: value.executable, args: [...args] }
}

export function agentProviderForExecutable(path: string): AgentProviderDefinition | undefined {
  const name = path.split(/[\\/]/).at(-1)?.replace(/\.(?:cmd|bat|exe)$/i, '').toLowerCase()
  return AGENT_PROVIDER_DEFINITIONS.find(provider => provider.command === name)
}
