import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProviderDefinition, AgentProviderId } from '../src/shared/agent-runtime'
import { AGENT_PROVIDER_DEFINITIONS } from '../src/shared/agent-runtime'
import { AGENT_HOOK_ENV, createAgentLaunchPlan } from '../src/main/agents/provider-hooks'

const directories: string[] = []
const binding = {
  socketPath: '/tmp/donwells-agent.sock',
  runId: 'run-1',
  sessionId: 'session-1',
  token: 'scoped-token'
}

function provider(id: AgentProviderId): AgentProviderDefinition {
  const result = AGENT_PROVIDER_DEFINITIONS.find((candidate) => candidate.id === id)
  if (!result) throw new Error(`missing provider fixture: ${id}`)
  return result
}

function runtimeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'donwells-agent-hooks-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('provider hook launch plans', () => {
  it('adds only per-invocation Codex hook configuration and a scoped credential', () => {
    const plan = createAgentLaunchPlan({
      command: 'codex',
      provider: provider('codex'),
      binding,
      emitterCommand: ['/runtime/daemon-entry', '--emit-agent-hook'],
      runtimeDir: runtimeDirectory(),
      platform: 'darwin'
    })

    expect(plan.command).toContain('hooks.PermissionRequest=')
    expect(plan.command).toContain('hooks.SessionEnd=')
    expect(plan.command).toContain('--emit-agent-hook')
    expect(plan.command).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(plan.command).toContain('permission')
    expect(plan.env).toEqual({
      [AGENT_HOOK_ENV.socket]: binding.socketPath,
      [AGENT_HOOK_ENV.runId]: binding.runId,
      [AGENT_HOOK_ENV.sessionId]: binding.sessionId,
      [AGENT_HOOK_ENV.token]: binding.token
    })
    expect(plan.hookSupport).toMatchObject({ support: 'native', adapter: 'codex-hooks' })
  })

  it('uses Claude session settings instead of modifying user or project settings', () => {
    const plan = createAgentLaunchPlan({
      command: 'claude',
      provider: provider('claude'),
      binding,
      emitterCommand: ['/runtime/emitter'],
      runtimeDir: runtimeDirectory(),
      platform: 'darwin'
    })

    expect(plan.command).toContain("'--settings'")
    expect(plan.command).toContain('PermissionRequest')
    expect(plan.command).toContain('StopFailure')
    expect(plan.hookSupport).toMatchObject({ support: 'native', adapter: 'claude-hooks' })
  })

  it('installs an OpenCode plugin only in a disposable runtime directory', () => {
    const runtimeDir = runtimeDirectory()
    const plan = createAgentLaunchPlan({
      command: 'opencode',
      provider: provider('opencode'),
      binding,
      emitterCommand: ['/runtime/emitter'],
      runtimeDir,
      inheritedEnv: {},
      platform: 'darwin'
    })
    const configDir = plan.env.OPENCODE_CONFIG_DIR
    if (!configDir) throw new Error('OpenCode adapter did not expose its disposable config directory')
    const plugin = join(configDir, 'plugins', 'runtime-status.js')
    const pluginSource = readFileSync(plugin, 'utf8')

    expect(configDir.startsWith(runtimeDir)).toBe(true)
    expect(pluginSource).toContain("event?.type === 'permission.asked'")
    expect(pluginSource).toContain("ELECTRON_RUN_AS_NODE: '1'")
    expect(plan.hookSupport).toMatchObject({ support: 'native', adapter: 'opencode-plugin' })
    plan.cleanup()
    expect(existsSync(configDir)).toBe(false)
  })

  it('preserves an existing OpenCode config directory and reports hooks unavailable', () => {
    const plan = createAgentLaunchPlan({
      command: 'opencode',
      provider: provider('opencode'),
      binding,
      emitterCommand: ['/runtime/emitter'],
      runtimeDir: runtimeDirectory(),
      inheritedEnv: { OPENCODE_CONFIG_DIR: '/user/existing-opencode' },
      platform: 'darwin'
    })

    expect(plan.env.OPENCODE_CONFIG_DIR).toBeUndefined()
    expect(plan.hookSupport).toMatchObject({
      support: 'unavailable',
      reason: expect.stringContaining('preserved')
    })
  })
})

it('appends native hooks to argv without interpreting user arguments', () => {
  const launch = { executable: '/Applications/My Tools/codex', args: ['--model', 'literal $(value)'] }
  const plan = createAgentLaunchPlan({ command: JSON.stringify(launch), launch, provider: provider('codex'), binding, emitterCommand: ['/runtime/emitter'], runtimeDir: runtimeDirectory(), platform: 'darwin' })
  expect(plan.launch?.executable).toBe(launch.executable)
  expect(plan.launch?.args.slice(0, 2)).toEqual(launch.args)
  expect(plan.launch?.args[2]).toBe('-c')
  expect(plan.hookSupport.support).toBe('native')
  plan.cleanup()
})
