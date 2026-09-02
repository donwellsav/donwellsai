import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Store } from '../src/main/store'

let dirs: string[] = []

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'orca-lite-test-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

describe('Store', () => {
  it('round-trips repos and settings through the JSON file', () => {
    const store = new Store(tmp())
    store.addRepo({ id: 'r1', path: '/tmp/one', addedAt: 't1' })
    store.addRepo({ id: 'r2', path: '/tmp/two', addedAt: 't2' })
    store.setAgentCommand('claude')

    const dir = dirname(store.path)
    const again = new Store(dir)
    expect(again.listRepos().map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(again.getAgentCommand()).toBe('claude')
  })

  it('addRepo is idempotent by id', () => {
    const store = new Store(tmp())
    store.addRepo({ id: 'r1', path: '/p', addedAt: 'a' })
    store.addRepo({ id: 'r1', path: '/p', addedAt: 'b' })
    expect(store.listRepos()).toHaveLength(1)
  })

  it('falls back to defaults on corrupt file', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'orca-lite-data.json'), '{not json')
    const store = new Store(dir)
    expect(store.listRepos()).toEqual([])
    expect(store.getAgentCommand()).toBe('codex')
    // file gets healed on next save
    store.addRepo({ id: 'r9', path: '/p9', addedAt: 'a' })
    const raw = JSON.parse(readFileSync(join(dir, 'orca-lite-data.json'), 'utf8'))
    expect(raw.schemaVersion).toBe(1)
    expect(raw.repos).toHaveLength(1)
  })
})