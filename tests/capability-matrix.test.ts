import { describe, expect, it } from 'vitest'
import { buildCapabilityRows } from '../src/shared/capability-matrix'

function preset(overrides: Partial<Parameters<typeof buildCapabilityRows>[0][number]> = {}) {
  return {
    name: 'Codex',
    available: true,
    hookSupport: { support: 'native' },
    skillConsumer: { supported: true },
    memorySupport: 'direct',
    ...overrides
  }
}

describe('capability matrix builder (R3)', () => {
  it('marks a fully wired installed provider as supported across the board', () => {
    const [row] = buildCapabilityRows([preset()])
    expect(row).toEqual({
      provider: 'Codex',
      installed: true,
      hooks: true,
      skills: true,
      memory: true
    })
  })

  it('labels a missing binary as not installed, distinct from unsupported', () => {
    const [row] = buildCapabilityRows([preset({ available: false })])
    expect(row.installed).toBe(false)
    expect(row.note).toBe('not installed')
  })

  it('counts ACP-delivered memory as real wiring with an honest note', () => {
    const [row] = buildCapabilityRows([preset({ name: 'OpenCode', memorySupport: 'acp' })])
    expect(row.memory).toBe(true)
    expect(row.note).toBe('memory via ACP session')
  })

  it('reports memory as unsupported when no wiring exists', () => {
    const [explicit] = buildCapabilityRows([preset({ memorySupport: 'none' })])
    expect(explicit.memory).toBe(false)
    expect(explicit.note).toBeUndefined()
    const [legacy] = buildCapabilityRows([
      { name: 'Old', available: true, hookSupport: { support: 'unavailable' }, skillConsumer: { supported: false } }
    ])
    expect(legacy.memory).toBe(false)
    expect(legacy.hooks).toBe(false)
    expect(legacy.skills).toBe(false)
  })
})
