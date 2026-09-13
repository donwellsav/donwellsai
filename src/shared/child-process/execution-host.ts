import { ProcessExecutionError, type ExecutionHost } from './process-spec'

export const LOCAL_EXECUTION_HOST: ExecutionHost = { kind: 'local' }

/** Fail closed: this boundary has no remote transport and never substitutes a local run. */
export function requireLocalExecutionHost(host: ExecutionHost = LOCAL_EXECUTION_HOST): void {
  if (host.kind === 'local') return
  throw new ProcessExecutionError(
    'unsupported-host',
    `execution host ${host.id} is remote; no remote process provider is registered`
  )
}
