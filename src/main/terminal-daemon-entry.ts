import { logger } from '@shared/logger'
import { normalizeAgentHookMessage } from '@shared/agent-runtime'
import { resolveSettings } from '@shared/settings'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runAgentHookEmitterFromEnvironment } from './agent-hook'
import { TerminalDaemon, newAuthToken } from './terminal-daemon'

/** The app's persisted-state envelope; the daemon only reads its legacy command. */
const STATE_FILE = 'donwells-data.json'
const DISPLAY_NAME_LIMIT = 256

/**
 * Reads the legacy `agentCommand` the one-time provider migration imports.
 *
 * The daemon is a separate process from the GUI, so it reads the same settings
 * file directly rather than reaching through Electron. A missing file means no
 * legacy command; an unreadable one defers the migration to the next startup
 * instead of failing the daemon, because the migration re-runs every boot.
 */
function readLegacyAgentCommand(userDataDir: string): readonly { command: string; displayName: string }[] {
  let raw: string
  try {
    raw = readFileSync(join(userDataDir, STATE_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn({ err: error }, 'provider-authority:legacy-command-unreadable')
    return []
  }
  try {
    const envelope = JSON.parse(raw) as { settings?: unknown }
    const command = resolveSettings(envelope.settings ?? {}).agentCommand.trim()
    if (!command) return []
    return [{ command, displayName: command.slice(0, DISPLAY_NAME_LIMIT) }]
  } catch (error) {
    logger.warn({ err: error }, 'provider-authority:legacy-command-invalid')
    return []
  }
}

// The daemon must NEVER run as a GUI Electron app — spawned wrong (without
// ELECTRON_RUN_AS_NODE=1) it registers a Dock icon / stray window for the user.
if (process.type !== undefined) {
  logger.fatal('terminal-daemon: refusing GUI-mode start — spawn with ELECTRON_RUN_AS_NODE=1')
  process.exit(1)
}

async function main(): Promise<void> {
  if (process.argv[2] === '--emit-agent-hook') {
    const hook = normalizeAgentHookMessage({ kind: process.argv[3] })
    if (!hook) throw new Error('invalid agent hook event')
    await runAgentHookEmitterFromEnvironment(hook.kind)
    return
  }

  const userDataDir = process.argv[2]
  if (!userDataDir) throw new Error('usage: terminal-daemon-entry <userDataDir>')
  const daemon = new TerminalDaemon({
    userDataDir,
    authToken: process.env['DONWELLS_DAEMON_TOKEN'] ?? newAuthToken(),
    legacyAgentCommand: () => readLegacyAgentCommand(userDataDir)
  })
  await daemon.start()
  if (!daemon.isReady()) throw new Error('terminal daemon start completed without an active listener')
  logger.info('terminal-daemon:ready')
  const handleSignal = (): void => {
    void daemon.stopIfIdle().then((stopped) => {
      if (stopped) process.exit(0)
      else logger.info('terminal-daemon:refuse-shutdown (owned sessions)')
    }).catch((error: unknown) => {
      logger.error({ err: error }, 'terminal-daemon:shutdown-incomplete')
    })
  }
  process.on('SIGTERM', handleSignal)
  process.on('SIGINT', handleSignal)
  if (process.platform !== 'win32') process.on('SIGHUP', handleSignal)
}

void main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'terminal-daemon:start-failed')
  process.exitCode = 1
})