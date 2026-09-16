import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '@shared/logger'

/**
 * Reads the legacy `agentCommand` for the one-time provider-instance migration.
 *
 * This lives outside `store.ts` deliberately: `Store` imports Electron's `app`,
 * and the terminal daemon is a separate, non-GUI process that cannot load it.
 * The daemon reads the same settings envelope directly instead, exactly as
 * `readRegisteredProjects` reads the migration's project registry.
 *
 * It reads the *persisted* value, not `resolveSettings().agentCommand`. That
 * resolved value injects the `codex` default, which would migrate a codex
 * instance for every profile whose user never chose an agent. The migration's
 * contract is narrower: only a command the user actually recorded becomes an
 * instance, and an unset/empty/invalid one stays a visible configuration-required
 * state with no instance and no default.
 */

/** The app's persisted-state envelope. */
const STATE_FILE = 'donwells-data.json'

/** A display name is a catalog label, bounded the same way the catalog bounds it. */
const DISPLAY_NAME_LIMIT = 256

/**
 * A missing file means the user never set a legacy command. An unreadable or
 * invalid one logs and defers: the migration re-runs on every startup, so
 * failing the daemon here would take the whole app down over a bad settings
 * file, and "nothing to migrate yet" is the honest projection of both.
 */
export function readLegacyAgentCommand(userDataDir: string): readonly { command: string; displayName: string }[] {
  let raw: string
  try {
    raw = readFileSync(join(userDataDir, STATE_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ err: error }, 'provider-authority:legacy-command-unreadable')
    }
    return []
  }
  try {
    const envelope = JSON.parse(raw) as { settings?: unknown }
    const settings = envelope.settings
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return []
    const command = (settings as Record<string, unknown>)['agentCommand']
    if (typeof command !== 'string') return []
    const trimmed = command.trim()
    if (!trimmed) return []
    return [{ command: trimmed, displayName: trimmed.slice(0, DISPLAY_NAME_LIMIT) }]
  } catch (error) {
    logger.warn({ err: error }, 'provider-authority:legacy-command-invalid')
    return []
  }
}
