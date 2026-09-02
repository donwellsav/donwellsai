#!/usr/bin/env node
/** Terminal daemon entrypoint: `node terminal-daemon-entry.js <userDataDir>`.
 * Detached from the app lifecycle; owns PTYs so agents survive app restarts. */
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { TerminalDaemon, newAuthToken } from './terminal-daemon'

const userDataDir = process.argv[2]
if (!userDataDir) {
  console.error('usage: terminal-daemon-entry <userDataDir>')
  process.exit(1)
}

const daemon = new TerminalDaemon({
  socketPath: join(userDataDir, 'terminal.sock'),
  authToken: process.env['ORCA_LITE_DAEMON_TOKEN'] ?? newAuthToken(),
  runtimeFile: join(userDataDir, 'terminal-runtime.json')
})

daemon.start().then(() => {
  console.log('terminal-daemon:ready', join(userDataDir, 'terminal.sock'))
  // orcad rule: DisconnectDaemon, never ShutdownDaemon. SIGTERM/SIGHUP must not
  // tear the socket down while sessions (agents!) are live — that strands every
  // client. Only exit when no session would be orphaned.
  const handleSignal = (): void => {
    if (daemon.hasLiveSessions()) {
      console.log('terminal-daemon:refuse-shutdown (live sessions)')
      return
    }
    daemon.stop()
    process.exit(0)
  }
  process.on('SIGTERM', handleSignal)
  process.on('SIGINT', handleSignal)
  process.on('SIGHUP', handleSignal)
})