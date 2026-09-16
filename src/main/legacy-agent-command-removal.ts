import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWritePrivate } from './task-authority/task-authority-migration'

/**
 * Atomically removes the legacy `agentCommand` setting from the profile.
 *
 * This is the last step of the provider-instance migration: the Catalog commit
 * makes the instance authoritative, and this publishes that decision to the
 * settings envelope the app and daemon both read. It is deliberately separate
 * from the migration's transaction, because the envelope is a file and no
 * SQLite transaction can span it.
 *
 * The removal is versioned and idempotent:
 *  - a profile with no file, no settings object, or no `agentCommand` is already
 *    published, so this reports `already-removed` without writing;
 *  - a successful removal reports `removed` and returns the exact key so a
 *    resume can verify it rather than guess.
 *
 * Nothing else in the envelope is touched: the write is a read-modify-write of
 * the parsed document with one key deleted, published through the same atomic
 * private write the rest of the profile state uses.
 */

/** The app's persisted-state envelope. */
const STATE_FILE = 'donwells-data.json'

/** The one setting this transfer removes. */
export const LEGACY_AGENT_COMMAND_KEY = 'agentCommand'

export type LegacyCommandPublication = 'removed' | 'already-removed'

/** True when the envelope still names the legacy command. */
export function legacyAgentCommandPresent(userDataDir: string): boolean {
  const document = readEnvelope(userDataDir)
  if (document === null) return false
  const settings = document['settings']
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return false
  return typeof (settings as Record<string, unknown>)[LEGACY_AGENT_COMMAND_KEY] === 'string'
}

/**
 * Removes the legacy setting, returning which case applied. A corrupt or
 * unreadable envelope throws rather than being silently overwritten: rewriting a
 * file this function could not parse would destroy state the user still has.
 */
export function publishLegacyCommandRemoval(userDataDir: string): LegacyCommandPublication {
  const path = join(userDataDir, STATE_FILE)
  const document = readEnvelope(userDataDir)
  if (document === null) return 'already-removed'
  const settings = document['settings']
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return 'already-removed'
  const record = settings as Record<string, unknown>
  if (!Object.hasOwn(record, LEGACY_AGENT_COMMAND_KEY)) return 'already-removed'
  const next = { ...document, settings: { ...record } }
  delete (next.settings as Record<string, unknown>)[LEGACY_AGENT_COMMAND_KEY]
  atomicWritePrivate(path, Buffer.from(JSON.stringify(next), 'utf8'))
  return 'removed'
}

/** The parsed envelope, or null when there is nothing to publish over. */
function readEnvelope(userDataDir: string): Record<string, unknown> | null {
  let raw: string
  try {
    raw = readFileSync(join(userDataDir, STATE_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}
