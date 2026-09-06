import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions
} from 'node:child_process'
import { createOutputSink } from './bounded-output-sink'
import { requireLocalExecutionHost } from './execution-host'
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_PROCESS_TIMEOUT_MS,
  ProcessExecutionError,
  type ProcessFailureKind,
  type ProcessResult,
  type ProcessSpec,
  type ResolvedSpawn,
  type SpawnedProcess
} from './process-spec'
import { windowsSystem32Binary } from './windows-system-binary'
import { buildWindowsCmdShimCommandLine, isCmdInterpretedProgram } from './windows-command-line'
import { forceTerminateProcessTree } from './process-tree-termination'

export type {
  ExecutionHost,
  ProcessFailureKind,
  ProcessLiveness,
  ProcessResult,
  ProcessSpec,
  ResolvedSpawn,
  SpawnedProcess
} from './process-spec'
export { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_PROCESS_TIMEOUT_MS, ProcessExecutionError } from './process-spec'

const PROCESS_EXIT_GRACE_MS = 3_000

function validateSpec(spec: ProcessSpec): void {
  requireLocalExecutionHost(spec.executionHost)
  if (!spec.program || spec.program.includes('\0')) {
    throw new ProcessExecutionError('spawn', 'process program must be non-empty and contain no NUL')
  }
  for (const arg of spec.args ?? []) {
    if (arg.includes('\0')) throw new ProcessExecutionError('spawn', 'process arguments cannot contain NUL')
  }
}

/** Pure spawn resolution keeps Windows .cmd/.bat behavior testable on every host. */
export function resolveSpawn(spec: ProcessSpec, platform: NodeJS.Platform): ResolvedSpawn {
  validateSpec(spec)
  const args = spec.args ?? []
  const options: SpawnOptions = {
    cwd: spec.cwd,
    env: spec.env,
    stdio: spec.stdio ?? ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: spec.detached,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
    shell: false
  }
  if (platform !== 'win32' || !isCmdInterpretedProgram(spec.program)) {
    return { file: spec.program, args, options }
  }
  const commandInterpreter = spec.env?.ComSpec ?? process.env.ComSpec ?? windowsSystem32Binary('cmd.exe', spec.env)
  return {
    file: commandInterpreter,
    args: [buildWindowsCmdShimCommandLine(spec.program, args)],
    options: { ...options, windowsVerbatimArguments: true }
  }
}

/** Start a local streaming process. The caller owns its streams and lifecycle. */
export function spawnProcess(spec: ProcessSpec): SpawnedProcess {
  const resolved = resolveSpawn(spec, process.platform)
  return nodeSpawn(resolved.file, [...resolved.args], resolved.options)
}

function resultFor(child: ChildProcess, stdout: string, stderr: string, startedAt: number): ProcessResult {
  return {
    code: child.exitCode,
    signal: child.signalCode,
    stdout,
    stderr,
    durationMs: Date.now() - startedAt
  }
}

/**
 * Run one finite local process without a shell. Spawn, non-zero exit, timeout,
 * output overflow and cancellation reject with a typed error carrying output.
 */
export function runProcess(spec: ProcessSpec): Promise<ProcessResult> {
  try {
    validateSpec(spec)
  } catch (error) {
    return Promise.reject(error)
  }
  if (spec.signal?.aborted) {
    return Promise.reject(new ProcessExecutionError('cancelled', 'process cancelled before spawn'))
  }
  const timeoutMs = spec.timeoutMs === undefined ? DEFAULT_PROCESS_TIMEOUT_MS : spec.timeoutMs
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
    return Promise.reject(new RangeError('timeoutMs must be null or a non-negative finite number'))
  }
  const maxOutputBytes = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0) {
    return Promise.reject(new RangeError('maxOutputBytes must be a non-negative safe integer'))
  }
  const startedAt = Date.now()
  const { promise, resolve, reject } = Promise.withResolvers<ProcessResult>()
  let child: ChildProcess
  let settled = false
  let stopping: ProcessFailureKind | null = null
  let closeResult: ProcessResult | null = null
  let terminationBarrier: Promise<boolean> | null = null
  let exitGraceTimer: ReturnType<typeof setTimeout> | undefined
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined

  const finish = (act: () => void): void => {
    if (settled) return
    settled = true
    clearTimeout(exitGraceTimer)
    clearTimeout(timeoutTimer)
    spec.signal?.removeEventListener('abort', onAbort)
    act()
  }
  const stoppedMessage = (kind: ProcessFailureKind): string => kind === 'timeout'
    ? `process timed out after ${timeoutMs}ms`
    : kind === 'output-limit'
      ? `process output exceeded ${maxOutputBytes} bytes`
      : kind === 'output-handler'
        ? 'process output consumer failed'
      : 'process cancelled'
  const reportStopped = async (): Promise<void> => {
    const kind = stopping
    const result = closeResult
    const barrier = terminationBarrier
    if (!kind || !result || !barrier || settled) return
    const verified = await barrier
    if (settled) return
    finish(() => reject(new ProcessExecutionError(
      verified ? kind : 'termination-unverified',
      verified ? stoppedMessage(kind) : `process ${kind} but tree termination could not be verified`,
      { result }
    )))
  }
  const terminate = (kind: ProcessFailureKind): void => {
    if (stopping || settled) return
    stopping = kind
    terminationBarrier = forceTerminateProcessTree(child)
    void terminationBarrier.then(() => reportStopped())
    exitGraceTimer = setTimeout(() => {
      const result = closeResult ?? resultFor(child, stdout.text(), stderr.text(), startedAt)
      finish(() => reject(new ProcessExecutionError(
        'termination-unverified',
        `process ${kind} but tree termination could not be verified`,
        { result }
      )))
    }, PROCESS_EXIT_GRACE_MS)
    exitGraceTimer.unref?.()
  }
  const stdout = createOutputSink(maxOutputBytes, () => terminate('output-limit'))
  const stderr = createOutputSink(maxOutputBytes, () => terminate('output-limit'))
  const onAbort = (): void => terminate('cancelled')

  try {
    child = spawnProcess({
      ...spec,
      detached: process.platform === 'win32' ? spec.detached : true,
      stdio: spec.stdio ?? ['pipe', 'pipe', 'pipe']
    })
  } catch (cause) {
    finish(() => reject(new ProcessExecutionError('spawn', `failed to spawn ${spec.program}`, { cause })))
    return promise
  }

  child.stdout?.on('data', (chunk: Buffer | string) => {
    stdout.write(chunk)
    if (stopping || settled) return
    try { spec.onStdout?.(chunk) }
    catch { terminate('output-handler') }
  })
  child.stderr?.on('data', (chunk: Buffer | string) => stderr.write(chunk))
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on('error', () => {})

  child.once('error', (cause) => {
    const result = resultFor(child, stdout.text(), stderr.text(), startedAt)
    finish(() => reject(new ProcessExecutionError('spawn', `failed to spawn ${spec.program}: ${cause.message}`, {
      cause,
      result
    })))
  })
  child.once('close', () => {
    const result = resultFor(child, stdout.text(), stderr.text(), startedAt)
    if (stopping) {
      closeResult = result
      void reportStopped()
      return
    }
    const accepted = spec.acceptExitCodes ?? [0]
    if (result.code === null || !accepted.includes(result.code)) {
      finish(() => reject(new ProcessExecutionError(
        'exit',
        `process exited with ${result.code === null ? `signal ${result.signal ?? 'unknown'}` : `code ${result.code}`}`,
        { result }
      )))
      return
    }
    finish(() => resolve(result))
  })

  spec.signal?.addEventListener('abort', onAbort, { once: true })
  if (timeoutMs !== null) {
    timeoutTimer = setTimeout(() => terminate('timeout'), timeoutMs)
    timeoutTimer.unref?.()
  }
  if (child.stdin) {
    if (spec.input !== undefined) child.stdin.write(spec.input)
    child.stdin.end()
  }
  return promise
}
