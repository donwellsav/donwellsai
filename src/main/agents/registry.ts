import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import {
  AGENT_PROVIDER_DEFINITIONS,
  agentProviderForCommand,
  type AgentPreset,
  type AgentProviderDefinition
} from '@shared/agent-runtime'

export type AgentRegistryOptions = {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  cwd?: string
}

function executableExtensions(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return ['']
  const extensions = (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean)
  return ['', ...extensions]
}

function executableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Declarative registry plus side-effect-free executable discovery. */
export class AgentRegistry {
  private readonly env: NodeJS.ProcessEnv
  private readonly platform: NodeJS.Platform
  private readonly cwd: string

  constructor(options: AgentRegistryOptions = {}) {
    this.env = options.env ?? process.env
    this.platform = options.platform ?? process.platform
    this.cwd = options.cwd ?? process.cwd()
  }

  list(): AgentPreset[] {
    return AGENT_PROVIDER_DEFINITIONS.map((provider) => {
      const executablePath = this.findExecutable(provider.command)
      return {
        ...provider,
        available: executablePath !== undefined,
        readiness: { installed: executablePath !== undefined, launchable: executablePath ? 'unverified' : 'unavailable', authenticated: 'unknown', memoryConnected: false },
        ...(executablePath ? { executablePath } : {}),
        hookSupport: { ...provider.hookSupport, events: [...provider.hookSupport.events] },
        skillConsumer: { ...provider.skillConsumer }
      }
    })
  }

  providerForCommand(command: string): AgentProviderDefinition | undefined {
    return agentProviderForCommand(command)
  }

  findExecutable(command: string): string | undefined {
    const extensions = executableExtensions(this.env, this.platform)
    if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
      const base = isAbsolute(command) ? command : resolve(this.cwd, command)
      return extensions.map((extension) => base + extension).find((path) => executableFile(path, this.platform))
    }

    const pathEntries = (this.env['PATH'] ?? '')
      .split(delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean)
    for (const entry of pathEntries) {
      for (const extension of extensions) {
        const candidate = join(entry, command + extension)
        if (executableFile(candidate, this.platform)) return candidate
      }
    }
    return undefined
  }
}
