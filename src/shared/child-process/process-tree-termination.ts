import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { windowsSystem32Binary } from './windows-system-binary'

const PROBE_INTERVAL_MS = 25
const TERMINATION_TIMEOUT_MS = 2_000
const MAX_PS_OUTPUT_BYTES = 8 * 1024 * 1024

/**
 * Force-stop a process tree and resolve only after the termination mechanism is
 * complete. POSIX children must have been spawned detached so their pid owns a
 * private process group.
 */
export async function forceTerminateProcessTree(child: ChildProcess): Promise<boolean> {
  if (!child.pid) {
    killRoot(child, 'SIGKILL')
    return true
  }
  if (process.platform === 'win32') return taskkillTree(child, child.pid)

  const processGroupId = child.pid
  try {
    process.kill(-processGroupId, 'SIGKILL')
  } catch {
    return !processGroupExists(processGroupId)
  }
  return waitForPosixProcessGroupQuiescence(processGroupId)
}

function taskkillTree(child: ChildProcess, rootPid: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(false)
  const { promise, resolve } = Promise.withResolvers<boolean>()
  let killer: ChildProcess
  try {
    killer = nodeSpawn(
      windowsSystem32Binary('taskkill.exe'),
      ['/pid', String(rootPid), '/t', '/f'],
      { stdio: 'ignore', windowsHide: true, shell: false }
    )
  } catch {
    killRoot(child, 'SIGKILL')
    resolve(false)
    return promise
  }
  let settled = false
  let timer: ReturnType<typeof setTimeout>
  const finish = (verified: boolean): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (!verified) killRoot(child, 'SIGKILL')
    resolve(verified)
  }
  killer.once('error', () => finish(false))
  killer.once('close', (code) => finish(code === 0))
  timer = setTimeout(() => {
    killer.kill()
    finish(false)
  }, TERMINATION_TIMEOUT_MS)
  timer.unref?.()
  return promise
}

async function waitForPosixProcessGroupQuiescence(processGroupId: number): Promise<boolean> {
  const deadline = Date.now() + TERMINATION_TIMEOUT_MS
  while (true) {
    const states = await readPosixProcessGroupStates(processGroupId)
    if (states ? states.every((state) => state.startsWith('Z')) : !processGroupExists(processGroupId)) {
      return true
    }
    if (Date.now() >= deadline) return false
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, PROBE_INTERVAL_MS)
    await promise
  }
}

function readPosixProcessGroupStates(processGroupId: number): Promise<string[] | null> {
  const { promise, resolve } = Promise.withResolvers<string[] | null>()
  let probe: ChildProcess
  try {
    probe = nodeSpawn('/bin/ps', ['-axo', 'pgid=,state='], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      shell: false
    })
  } catch {
    resolve(null)
    return promise
  }
  let output = ''
  let truncated = false
  let settled = false
  let timer: ReturnType<typeof setTimeout>
  const finish = (states: string[] | null): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    resolve(states)
  }
  probe.stdout?.on('data', (chunk: Buffer | string) => {
    const text = chunk.toString()
    if (output.length + text.length > MAX_PS_OUTPUT_BYTES) {
      truncated = true
      return
    }
    output += text
  })
  probe.stdout?.on('error', () => {})
  probe.once('error', () => finish(null))
  probe.once('close', (code) => {
    if (code !== 0 || truncated) {
      finish(null)
      return
    }
    const states = output.split('\n').flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\S+)/)
      return match && Number(match[1]) === processGroupId ? [match[2]] : []
    })
    finish(states)
  })
  timer = setTimeout(() => {
    probe.kill()
    finish(null)
  }, TERMINATION_TIMEOUT_MS)
  timer.unref?.()
  return promise
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function killRoot(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal)
  } catch {
    // A close/error event remains the root process proof.
  }
}
