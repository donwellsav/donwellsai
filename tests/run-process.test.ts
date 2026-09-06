import { describe, expect, it, vi } from 'vitest'
import { forceTerminatePosixProcessGroup } from '../src/shared/child-process/process-tree-termination'
import { execFileSync } from 'node:child_process'
import {
  ProcessExecutionError,
  resolveSpawn,
  runProcess
} from '../src/shared/child-process/run-process'

function expectProcessError(error: unknown, kind: ProcessExecutionError['kind']): ProcessExecutionError {
  expect(error).toBeInstanceOf(ProcessExecutionError)
  const processError = error as ProcessExecutionError
  expect(processError.kind).toBe(kind)
  return processError
}
describe('safe child-process boundary', () => {
  it.skipIf(process.platform === 'win32')('verifies quiescence when a group disappears during signalling', async () => {
    const original = process.kill.bind(process)
    const group = 2147483647
    const probe = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid !== -group) return original(pid, signal)
      if (signal === 'SIGKILL') throw Object.assign(new Error('Group exited'), { code: 'ESRCH' })
      return true
    })
    try { expect(await forceTerminatePosixProcessGroup(group)).toBe(true) }
    finally { probe.mockRestore() }
  })
  it('streams output before exit and terminates safely when the consumer cancels or throws', async () => {
    for (const throws of [false, true]) {
      const controller = new AbortController()
      let observed = ''
      const error = await runProcess({
        program: process.execPath,
        args: ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
        signal: controller.signal,
        timeoutMs: 1000,
        onStdout: chunk => {
          observed += chunk.toString()
          if (throws) throw new Error('consumer failed')
          controller.abort()
        }
      }).catch(error => error)
      expect(observed).toBe('ready')
      expectProcessError(error, throws ? 'output-handler' : 'cancelled')
    }
  })

  it('passes adversarial argv literally without shell interpretation', async () => {
    const values = ['space value', 'quote"value', '$HOME', 'semi;colon', 'amp&ersand', 'line1\nline2']
    const result = await runProcess({
      program: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...values]
    })
    expect(JSON.parse(result.stdout)).toEqual(values)
  })

  it('surfaces the real non-zero exit and captured stderr', async () => {
    const error = await runProcess({
      program: process.execPath,
      args: ['-e', "process.stderr.write('reason'); process.exit(17)"]
    }).catch((caught: unknown) => caught)
    const processError = expectProcessError(error, 'exit')
    expect(processError.result).toMatchObject({ code: 17, stderr: 'reason' })
  })

  it('bounds output and terminates the producer', async () => {
    const error = await runProcess({
      program: process.execPath,
      args: ['-e', "process.stdout.write('x'.repeat(8192)); setInterval(() => {}, 1000)"],
      maxOutputBytes: 128,
      timeoutMs: 5000
    }).catch((caught: unknown) => caught)
    const processError = expectProcessError(error, 'output-limit')
    expect(Buffer.byteLength(processError.result?.stdout ?? '')).toBe(128)
  })

  it('returns rejected promises for invalid finite-run bounds', async () => {
    const pending = runProcess({ program: process.execPath, maxOutputBytes: -1 })
    expect(pending).toBeInstanceOf(Promise)
    await expect(pending).rejects.toThrow(/maxOutputBytes/)
  })

  it('distinguishes timeout from a normal exit', async () => {
    const error = await runProcess({
      program: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 30
    }).catch((caught: unknown) => caught)
    expectProcessError(error, 'timeout')
  })

  it('does not resolve cancellation until process exit is observed', async () => {
    const controller = new AbortController()
    const run = runProcess({
      program: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      signal: controller.signal,
      timeoutMs: 5000
    })
    controller.abort()
    const error = await run.catch((caught: unknown) => caught)
    const processError = expectProcessError(error, 'cancelled')
    expect(processError.result?.signal ?? processError.result?.code).not.toBeNull()
  })

  it.skipIf(process.platform === 'win32')('cancels descendants in the owned process group', async () => {
    let descendantPid = 0, output = ''
    const descendant = `process.stdout.write(process.pid + '\\n'); setInterval(() => {}, 1000)`
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'inherit', 'ignore'] }); setInterval(() => {}, 1000)`
    const controller = new AbortController()
    try {
      const error = await runProcess({
        program: process.execPath,
        args: ['-e', parent],
        signal: controller.signal,
        timeoutMs: 5000,
        onStdout: chunk => {
          output += chunk.toString()
          if (output.includes('\n')) { descendantPid = Number(output.trim()); controller.abort() }
        }
      }).catch((caught: unknown) => caught)
      expectProcessError(error, 'cancelled')
      expect(descendantPid).toBeGreaterThan(1)
      const states = execFileSync('/bin/ps', ['-axo', 'pid=,state='], { encoding: 'utf8' })
        .split('\n').map(line => line.trim().split(/\s+/)).filter(([pid]) => Number(pid) === descendantPid)
      expect(states.every(([, state]) => state.startsWith('Z'))).toBe(true)
    } finally {
      if (descendantPid > 1) { try { process.kill(descendantPid, 'SIGKILL') } catch {} }
    }
  })

  it('refuses remote execution instead of silently substituting local', async () => {
    const error = await runProcess({
      program: process.execPath,
      executionHost: { kind: 'remote', id: 'ssh-prod' }
    }).catch((caught: unknown) => caught)
    expectProcessError(error, 'unsupported-host')
  })

  it('always disables shell mode and hides Windows consoles', () => {
    const resolved = resolveSpawn({ program: 'tool.exe', args: ['a&b'] }, 'win32')
    expect(resolved.options.shell).toBe(false)
    expect(resolved.options.windowsHide).toBe(true)
    expect(resolved.args).toEqual(['a&b'])
  })
})
