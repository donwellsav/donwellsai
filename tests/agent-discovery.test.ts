import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_PROVIDER_IDS, agentProviderForCommand, agentProviderForExecutable, parseAgentExecutable } from '../src/shared/agent-runtime'
import { AgentRegistry } from '../src/main/agents/registry'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('agent registry discovery', () => {
  it('reports every supported preset while resolving only executable PATH entries', () => {
    const bin = mkdtempSync(join(tmpdir(), 'donwells-agent-bin-'))
    directories.push(bin)
    for (const name of ['codex', 'omp', 'hermes', 'kimi', 'dsh']) {
      const executable = join(bin, name)
      writeFileSync(executable, '#!/bin/sh\nexit 99\n', 'utf8')
      chmodSync(executable, 0o755)
    }

    const presets = new AgentRegistry({ env: { PATH: bin }, platform: 'darwin' }).list()
    expect(presets.map((preset) => preset.id)).toEqual(AGENT_PROVIDER_IDS)
    expect(presets.find((preset) => preset.id === 'codex')).toMatchObject({
      available: true,
      executablePath: join(bin, 'codex'),
      hookSupport: { support: 'native', adapter: 'codex-hooks' },
      skillConsumer: { supported: true, root: '.agents/skills', discovery: 'native' }
    })
    expect(presets.find((preset) => preset.id === 'omp')).toMatchObject({
      available: true,
      hookSupport: { support: 'unavailable' },
      skillConsumer: { supported: false }
    })
    expect(presets.find((preset) => preset.id === 'claude')).toMatchObject({ available: false })
    for (const id of ['hermes', 'kimi', 'deepseek-harness']) expect(presets.find(preset => preset.id === id)).toMatchObject({ readiness: { installed: true, launchable: 'unverified', authenticated: 'unknown', memoryConnected: false } })
  })

  it('only assigns provider authority to an exact preset command', () => {
    expect(agentProviderForCommand('opencode')?.id).toBe('opencode')
    expect(agentProviderForCommand('opencode --continue')).toBeUndefined()
    expect(agentProviderForCommand('opencode; echo unsafe')).toBeUndefined()
  })
})

it('validates literal argument lists and identifies executables in spaced paths', () => {
  const launch = { executable: '/tools/agent bins/名字/kimi', args: ['', 'two words', '$(never executed)', '; literal', 'é'] }
  expect(parseAgentExecutable(launch)).toEqual(launch)
  expect(agentProviderForExecutable(launch.executable)?.id).toBe('kimi')
  for (const invalid of [{ executable: '' }, { executable: 'kimi', args: [1] }, { executable: 'kimi', args: ['bad\0'] }, { executable: 'kimi', env: {} }]) expect(() => parseAgentExecutable(invalid)).toThrow()
})
