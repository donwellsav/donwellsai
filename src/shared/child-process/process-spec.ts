import type { ChildProcess, SpawnOptions } from 'node:child_process'

export type ExecutionHost =
  | { kind: 'local' }
  | { kind: 'remote'; id: string }


export type RuntimeFamily = 'donwells-app' | 'terminal-daemon' | 'acp-agent'

export type RuntimeExpectation = {
  family: RuntimeFamily
  executablePath?: string
  generation?: string
}

export type ProcessIdentity = {
  pid: number
  bootId: string
  startedAt: string
  executablePath: string
  family: RuntimeFamily
  capturedAt: string
  generation?: string
}

export type ProcessIdentityVerdict =
  | { status: 'valid'; current: ProcessIdentity }
  | { status: 'stale'; reason: 'not-found' | 'pid-reused' | 'executable-mismatch' }
  | { status: 'indeterminate'; reason: 'legacy-record' | 'access-denied' | 'native-error'; detail: string }

export interface RuntimeIdentityAuthority {
  capture(pid: number, expected: RuntimeExpectation): ProcessIdentity
  verify(identity: ProcessIdentity | null): ProcessIdentityVerdict
}

export type ProcessFailureKind =
  | 'spawn'
  | 'exit'
  | 'timeout'
  | 'output-limit'
  | 'output-handler'
  | 'cancelled'
  | 'termination-unverified'
  | 'unsupported-host'

export type ProcessResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  durationMs: number
}

export class ProcessExecutionError extends Error {
  readonly kind: ProcessFailureKind
  readonly result?: ProcessResult

  constructor(kind: ProcessFailureKind, message: string, options: { cause?: unknown; result?: ProcessResult } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ProcessExecutionError'
    this.kind = kind
    this.result = options.result
  }
}

/** A finite, non-interactive process. This implementation executes locally only. */
export type ProcessSpec = {
  program: string
  args?: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  executionHost?: ExecutionHost
  timeoutMs?: number | null
  input?: string
  maxOutputBytes?: number
  signal?: AbortSignal
  /** Synchronous streaming consumer. Throwing terminates the owned process tree. */
  onStdout?: (chunk: Buffer | string) => void
  detached?: boolean
  windowsVerbatimArguments?: boolean
  stdio?: SpawnOptions['stdio']
  /** Non-zero exit codes are errors unless explicitly accepted. */
  acceptExitCodes?: readonly number[]
}

export type ResolvedSpawn = {
  file: string
  args: readonly string[]
  options: SpawnOptions
}

export type SpawnedProcess = ChildProcess

export const DEFAULT_PROCESS_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
