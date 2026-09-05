import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TerminalDaemon } from '../src/main/terminal-daemon'
import { readTerminalRuntime, localRuntimePaths } from '../src/main/local-runtime'
import { DaemonClient } from '../src/main/daemon-client'

const directories: string[] = []
const daemons: TerminalDaemon[] = []

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stopIfIdle()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function permissions(path: string): number {
  return statSync(path).mode & 0o777
}

describe('TerminalDaemon endpoint ownership', () => {
  it.skipIf(process.platform === 'win32')(
    'protects discovery files and refuses to replace a live profile owner',
    async () => {
      const userDataDir = mkdtempSync(join(tmpdir(), 'donwells-daemon-owner-'))
      directories.push(userDataDir)
      const owner = new TerminalDaemon({ userDataDir, authToken: 'owner-token' })
      daemons.push(owner)
      await owner.start()

      const paths = localRuntimePaths(userDataDir, 'terminal')
      expect(permissions(paths.runtimeDir)).toBe(0o700)
      expect(permissions(paths.socketDir)).toBe(0o700)
      expect(permissions(paths.runtimeFile)).toBe(0o600)
      expect(permissions(paths.socketPath)).toBe(0o600)

      const contender = new TerminalDaemon({ userDataDir, authToken: 'contender-token' })
      await expect(contender.start()).rejects.toThrow(/live|unverifiable/)
      expect(existsSync(paths.runtimeFile)).toBe(true)
      expect(existsSync(paths.socketPath)).toBe(true)

      await expect(owner.stopIfIdle()).resolves.toBe(true)
      daemons.splice(daemons.indexOf(owner), 1)
      expect(existsSync(paths.runtimeFile)).toBe(false)
      expect(existsSync(paths.socketPath)).toBe(false)
    }
  )

  it('authenticates status and shuts down only an idle owner', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'donwells-daemon-idle-'))
    directories.push(userDataDir)
    const owner = new TerminalDaemon({ userDataDir, authToken: 'owner-token' })
    daemons.push(owner)
    await owner.start()
    const client = new DaemonClient(
      userDataDir,
      { data: () => {}, exit: () => {}, title: () => {}, agent: () => {}, agentDismissed: () => {} },
      join(userDataDir, 'unused-entry.js')
    )

    await expect(client.status()).resolves.toMatchObject({
      pid: process.pid,
      idle: true,
      sessionCount: 0,
      liveSessionCount: 0
    })
    await expect(client.shutdownIfIdle()).resolves.toBe(true)
    client.disconnect()
    daemons.splice(daemons.indexOf(owner), 1)
    expect(existsSync(localRuntimePaths(userDataDir, 'terminal').runtimeFile)).toBe(false)
  })

  it('does not bypass malformed current ownership with legacy metadata', () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'donwells-daemon-metadata-'))
    directories.push(userDataDir)
    const paths = localRuntimePaths(userDataDir, 'terminal')
    mkdirSync(paths.runtimeDir, { recursive: true })
    writeFileSync(paths.runtimeFile, '{malformed')
    writeFileSync(join(userDataDir, 'terminal-runtime.json'), JSON.stringify({
      socketPath: paths.socketPath,
      authToken: 'legacy-token',
      pid: process.pid
    }))

    expect(readTerminalRuntime(userDataDir)).toBeNull()
  })
})
