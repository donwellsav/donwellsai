import { ProcessExecutionError, type ExecutionHost, type ProcessLiveness } from './process-spec'

export const LOCAL_EXECUTION_HOST: ExecutionHost = { kind: 'local' }

/** Fail closed: this boundary has no remote transport and never substitutes a local run. */
export function requireLocalExecutionHost(host: ExecutionHost = LOCAL_EXECUTION_HOST): void {
  if (host.kind === 'local') return
  throw new ProcessExecutionError(
    'unsupported-host',
    `execution host ${host.id} is remote; no remote process provider is registered`
  )
}

/** Probe only a process owned by this local host. Transport loss is never an exit proof. */
export function probeLocalProcessLiveness(pid: number): ProcessLiveness {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unverifiable'
  try {
    process.kill(pid, 0)
    return 'live'
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return 'exited'
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') return 'live'
    return 'unverifiable'
  }
}
