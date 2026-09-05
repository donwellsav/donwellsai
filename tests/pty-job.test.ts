import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PtyManager, REAP_EXITED_MS } from '../src/main/pty'
import { DaemonClient } from '../src/main/daemon-client'
import { TerminalDaemon } from '../src/main/terminal-daemon'

const directories: string[] = []
type ExitSignal = {
  promise: Promise<number>
  resolve: (exitCode: number) => void
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function worktree(): string {
  const directory = mkdtempSync(join(tmpdir(), 'donwells-pty-job-'))
  directories.push(directory)
  return directory
}

describe('daemon-owned PTY command jobs', () => {
  it('runs finite commands with sanitized daemon env and preserves real exit codes', async () => {
    vi.stubEnv('DONWELLS_DAEMON_TOKEN', 'must-not-leak')
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    vi.stubEnv('TERM_PROGRAM', 'OuterHarness')
    vi.stubEnv('OUTERHARNESS_AGENT_HOOK_TOKEN', 'outer-private')
    vi.stubEnv('OUTERHARNESS_WORKSPACE_ID', 'foreign-workspace')
    vi.stubEnv('USER_PROCESS_SETTING', 'keep-me')
    const output = new Map<string, string>()
    const exits = new Map<string, ExitSignal>()
    const manager = new PtyManager({
      data: (sessionId, data) => output.set(sessionId, (output.get(sessionId) ?? '') + data),
      exit: (sessionId, exitCode) => exits.get(sessionId)?.resolve(exitCode),
      title: () => {}
    })

    const successful = manager.openJob(
      worktree(),
      `printf 'TOKEN=<%s> NODE=<%s> OUTER=<%s> WORKSPACE=<%s> USER=<%s> TERM=<%s>\n' "$DONWELLS_DAEMON_TOKEN" "$ELECTRON_RUN_AS_NODE" "$OUTERHARNESS_AGENT_HOOK_TOKEN" "$OUTERHARNESS_WORKSPACE_ID" "$USER_PROCESS_SETTING" "$TERM_PROGRAM"`,
      80,
      24
    )
    const success = Promise.withResolvers<number>()
    exits.set(successful.id, success)
    await expect(success.promise).resolves.toBe(0)
    expect(output.get(successful.id)).toContain('TOKEN=<> NODE=<> OUTER=<> WORKSPACE=<> USER=<keep-me> TERM=<donwells.ai>')

    const failing = manager.openJob(worktree(), 'printf failure; exit 7', 80, 24)
    const failure = Promise.withResolvers<number>()
    exits.set(failing.id, failure)
    await expect(failure.promise).resolves.toBe(7)
    expect(output.get(failing.id)).toContain('failure')
  })

  it.skipIf(process.platform === 'win32')('reports signal-terminated jobs as failures', async () => {
    const completion = Promise.withResolvers<number>()
    const manager = new PtyManager({
      data: () => {},
      exit: (_sessionId, exitCode) => completion.resolve(exitCode),
      title: () => {}
    })
    const session = manager.openJob(worktree(), 'kill -TERM $$', 80, 24)

    try {
      await expect(completion.promise).resolves.toBe(143)
    } finally {
      await manager.close(session.id)
    }
  })

  it('rejects excess admission without dropping retained jobs', async () => {
    const manager = new PtyManager(
      { data: () => {}, exit: () => {}, title: () => {} },
      undefined,
      2
    )
    const first = manager.openJob(worktree(), 'sleep 30', 80, 24)
    const second = manager.openJob(worktree(), 'sleep 30', 80, 24)

    expect(() => manager.openJob(worktree(), 'sleep 30', 80, 24)).toThrow(/job capacity reached/)
    expect(manager.has(first.id)).toBe(true)
    expect(manager.has(second.id)).toBe(true)

    await Promise.all([manager.close(first.id), manager.close(second.id)])
  })

  it('retains a completed job beyond the interactive reaping interval until close acknowledges it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const manager = new PtyManager({ data: () => {}, exit: () => {}, title: () => {} })
    const session = manager.openJob(worktree(), 'exit 4', 80, 24)

    while (!session.exited) await new Promise<void>((resolve) => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(250 + REAP_EXITED_MS + 1)

    expect(manager.jobResult(session.id)).toEqual({ exited: true, exitCode: 4 })
    await manager.close(session.id)
    expect(() => manager.jobResult(session.id)).toThrow(/unknown job/)
  })

  it('retains daemon-owned output beyond the reaping interval until the owner closes it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const userData = worktree()
    const daemon = new TerminalDaemon({
      userDataDir: userData,
      authToken: 'retention-token'
    })
    await daemon.start()
    const client = new DaemonClient(
      userData,
      { data: () => {}, exit: () => {}, title: () => {}, agent: () => {}, agentDismissed: () => {} },
      join(userData, 'unused-entry.js')
    )

    try {
      const session = await client.openJob(userData, 'printf retained-output; exit 6')
      while (daemon.hasLiveSessions()) await new Promise<void>((resolve) => setImmediate(resolve))
      await vi.advanceTimersByTimeAsync(250 + REAP_EXITED_MS + 1)

      await expect(client.jobResult(session.id)).resolves.toMatchObject({
        exited: true,
        exitCode: 6,
        output: expect.stringContaining('retained-output')
      })
      await client.close(session.id)
      await expect(client.jobResult(session.id)).rejects.toThrow(/unknown job/)
    } finally {
      await daemon.stopIfIdle()
    }
  })

  it('acknowledges daemon-client close only after a cancellable job can no longer continue', async () => {
    const userData = worktree()
    const marker = join(userData, 'late-marker')
    const daemon = new TerminalDaemon({ userDataDir: userData, authToken: 'cancel-token' })
    await daemon.start()
    const client = new DaemonClient(
      userData,
      { data: () => {}, exit: () => {}, title: () => {}, agent: () => {}, agentDismissed: () => {} },
      join(userData, 'unused-entry.js')
    )

    try {
      const session = await client.openJob(
        userData,
        'sleep 2; printf late > ' + JSON.stringify(marker)
      )
      await client.close(session.id)
      // Platform-process integration proof: deterministic fake time cannot prove
      // that a real child fails to continue after its OS process is killed.
      await new Promise<void>((resolve) => setTimeout(resolve, 2200))
      expect(existsSync(marker)).toBe(false)
      await expect(client.close(session.id)).rejects.toThrow(/exit is unverifiable/)
    } finally {
      await daemon.stopIfIdle()
    }
  }, 10000)
})
