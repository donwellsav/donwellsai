import { logger } from '@shared/logger'
import { normalizeAgentHookMessage } from '@shared/agent-runtime'
import { runAgentHookEmitterFromEnvironment } from './agent-hook'
import { TerminalDaemon, newAuthToken } from './terminal-daemon'

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
    authToken: process.env['DONWELLS_DAEMON_TOKEN'] ?? newAuthToken()
  })
  await daemon.start()
  if (!daemon.isReady()) throw new Error('terminal daemon start completed without an active listener')
  logger.info('terminal-daemon:ready')
  const handleSignal = (): void => {
    void daemon.stopIfIdle().then((stopped) => {
      if (stopped) process.exit(0)
      else logger.info('terminal-daemon:refuse-shutdown (owned sessions)')
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