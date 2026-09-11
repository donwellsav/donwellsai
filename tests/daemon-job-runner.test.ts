import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDaemonJobRunner } from '../src/main/autonomous/daemon-job-runner'
import type { DaemonClient } from '../src/main/daemon-client'
import type { AutonomousJobRequest } from '../src/main/autonomous/autonomous-agent'

interface FakeTerminals {
  openJob: ReturnType<typeof vi.fn>
  jobResult: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  seen: Array<{ cwd: string; command: string }>
}

function fakeTerminals(results: Array<{ exited: boolean; exitCode?: number; output: string }>): FakeTerminals {
  const seen: FakeTerminals['seen'] = []
  const queue = [...results]
  return {
    seen,
    openJob: vi.fn(async (cwd: string, command: string) => {
      seen.push({ cwd, command })
      return { id: 'job-1' }
    }),
    jobResult: vi.fn(async () => queue.shift() ?? { exited: false, output: '', sequence: 0 }),
    close: vi.fn(async () => {})
  } as unknown as FakeTerminals
}

function request(overrides: Partial<AutonomousJobRequest> = {}): AutonomousJobRequest {
  return {
    prompt: 'hi there',
    workspacePath: '/tmp/unused',
    command: 'my-agent',
    iteration: 0,
    ...overrides
  }
}

const EXITED = { exited: true, exitCode: 0, output: 'GOAL: achieved\nSUMMARY: s' }

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true })
  }
})

describe('daemon job runner (R2.1)', () => {
  it('passes short prompts inline with shell quoting and closes the job', async () => {
    const terminals = fakeTerminals([EXITED])
    const runner = createDaemonJobRunner(terminals as unknown as DaemonClient, {
      pollIntervalMs: 1,
      maxPollMs: 200
    })
    const outcome = await runner(request())
    expect(terminals.seen).toHaveLength(1)
    expect(terminals.seen[0].command).toBe("my-agent 'hi there'")
    expect(terminals.close).toHaveBeenCalledWith('job-1')
    expect(outcome).toEqual({ output: 'GOAL: achieved\nSUMMARY: s', exitCode: 0, tokensUsed: null })
  })

  it('escapes single quotes in prompts', async () => {
    const terminals = fakeTerminals([EXITED])
    const runner = createDaemonJobRunner(terminals as unknown as DaemonClient, {
      pollIntervalMs: 1,
      maxPollMs: 200
    })
    await runner(request({ prompt: "it's fine" }))
    expect(terminals.seen[0].command).toBe("my-agent 'it'\\''s fine'")
  })

  it('routes oversized prompts through a 0600 file inside the workspace', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'donwells-autonomous-'))
    dirs.push(workspace)
    const prompt = 'a'.repeat(20000)
    const terminals = fakeTerminals([EXITED])
    const runner = createDaemonJobRunner(terminals as unknown as DaemonClient, {
      pollIntervalMs: 1,
      maxPollMs: 200
    })
    await runner(request({ prompt, workspacePath: workspace, iteration: 2 }))
    const command = terminals.seen[0].command
    expect(command.startsWith('my-agent $(cat ')).toBe(true)
    const match = /\$\(cat '([^']+)'\)/.exec(command)
    expect(match).not.toBeNull()
    const filePath = join(workspace, match![1])
    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath, 'utf8')).toBe(prompt)
    expect(match![1]).toContain(join('.donwells', 'autonomous'))
    expect(match![1]).toContain('prompt-3.md')
  })

  it('polls until the job exits', async () => {
    const terminals = fakeTerminals([
      { exited: false, output: '', sequence: 1 },
      EXITED
    ])
    const runner = createDaemonJobRunner(terminals as unknown as DaemonClient, {
      pollIntervalMs: 1,
      maxPollMs: 200
    })
    const outcome = await runner(request())
    expect(terminals.jobResult).toHaveBeenCalledTimes(2)
    expect(outcome.exitCode).toBe(0)
    expect(terminals.close).toHaveBeenCalledTimes(1)
  })

  it('gives up at the deadline but still closes the job', async () => {
    const terminals = fakeTerminals([])
    const runner = createDaemonJobRunner(terminals as unknown as DaemonClient, {
      pollIntervalMs: 1,
      maxPollMs: 5
    })
    await expect(runner(request())).rejects.toThrow(/without exiting/)
    expect(terminals.close).toHaveBeenCalledWith('job-1')
  })

  it('swallows close failures', async () => {
    const terminals = fakeTerminals([EXITED])
    terminals.close = vi.fn(async () => {
      throw new Error('socket gone')
    })
    const runner = createDaemonJobRunner(terminals as unknown as DaemonClient, {
      pollIntervalMs: 1,
      maxPollMs: 200
    })
    await expect(runner(request())).resolves.toEqual({
      output: 'GOAL: achieved\nSUMMARY: s',
      exitCode: 0,
      tokensUsed: null
    })
  })
})
