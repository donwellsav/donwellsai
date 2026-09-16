// @vitest-environment node
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LEGACY_AGENT_COMMAND_KEY, legacyAgentCommandPresent, publishLegacyCommandRemoval } from './legacy-agent-command-removal'

/**
 * The settings publication that finishes the provider-instance migration.
 *
 * The Catalog commit makes an instance authoritative; this removes the legacy
 * command from the envelope both the app and the daemon read, so the profile
 * stops carrying two launch authorities. It is the one step no SQLite
 * transaction can span, so it is idempotent and resumable on its own.
 */

const directories: string[] = []

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true })
})

function profile(document: unknown): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'legacy-removal-')))
  directories.push(directory)
  if (document !== undefined) writeFileSync(join(directory, 'donwells-data.json'), JSON.stringify(document), { mode: 0o600 })
  return directory
}

const STATE = (settings: Record<string, unknown>): unknown => ({ schemaVersion: 2, repos: [{ path: '/work' }], settings })

describe('publishLegacyCommandRemoval', () => {
  it('removes only the legacy command and preserves the rest of the envelope', () => {
    const directory = profile(STATE({ agentCommand: 'claude --print', theme: 'dark', uiScale: 1 }))

    expect(legacyAgentCommandPresent(directory)).toBe(true)
    expect(publishLegacyCommandRemoval(directory)).toBe('removed')

    const after = JSON.parse(readFileSync(join(directory, 'donwells-data.json'), 'utf8')) as Record<string, unknown>
    const settings = after['settings'] as Record<string, unknown>
    expect(Object.hasOwn(settings, LEGACY_AGENT_COMMAND_KEY)).toBe(false)
    // Every other setting and the envelope's own fields survive untouched.
    expect(settings).toEqual({ theme: 'dark', uiScale: 1 })
    expect(after['schemaVersion']).toBe(2)
    expect(after['repos']).toEqual([{ path: '/work' }])
    expect(legacyAgentCommandPresent(directory)).toBe(false)
  })

  it('is idempotent: a second publication reports already-removed and rewrites nothing', () => {
    const directory = profile(STATE({ agentCommand: 'codex', theme: 'dark' }))
    expect(publishLegacyCommandRemoval(directory)).toBe('removed')
    const first = readFileSync(join(directory, 'donwells-data.json'), 'utf8')

    // A resumed run takes the same path and must not disturb the file.
    expect(publishLegacyCommandRemoval(directory)).toBe('already-removed')
    expect(readFileSync(join(directory, 'donwells-data.json'), 'utf8')).toBe(first)
  })

  it('reports already-removed for a profile that never set the command', () => {
    const directory = profile(STATE({ theme: 'dark' }))
    expect(legacyAgentCommandPresent(directory)).toBe(false)
    expect(publishLegacyCommandRemoval(directory)).toBe('already-removed')
  })

  it('reports already-removed when the profile has no envelope at all', () => {
    const directory = profile(undefined)
    expect(legacyAgentCommandPresent(directory)).toBe(false)
    expect(publishLegacyCommandRemoval(directory)).toBe('already-removed')
  })

  it('refuses to rewrite an envelope it cannot parse', () => {
    const directory = profile(undefined)
    writeFileSync(join(directory, 'donwells-data.json'), '{ this is not json', { mode: 0o600 })

    // Overwriting a file this could not parse would destroy state the user still
    // has, so the failure surfaces instead of being silently absorbed.
    expect(() => publishLegacyCommandRemoval(directory)).toThrow()
    expect(readFileSync(join(directory, 'donwells-data.json'), 'utf8')).toBe('{ this is not json')
  })

  it('leaves an envelope whose settings are not an object alone', () => {
    const directory = profile({ schemaVersion: 2, repos: [], settings: null })
    expect(legacyAgentCommandPresent(directory)).toBe(false)
    expect(publishLegacyCommandRemoval(directory)).toBe('already-removed')
  })
})
