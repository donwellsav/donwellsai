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
  // supervise: stay alive regardless of stdin (detached spawn)
  process.on('SIGTERM', () => {
    // graceful: stop accepting, but DO NOT kill PTYs — sessions outlive us too
    daemon.stop()
    process.exit(0)
  })
})