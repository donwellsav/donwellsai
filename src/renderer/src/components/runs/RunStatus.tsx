import type { OperationalTarget, ParallelRunStatus, ParallelTaskStatus, ScheduledExecutionStatus } from '@shared/operational-runs'

type Status = ParallelRunStatus | ParallelTaskStatus | ScheduledExecutionStatus

const LABELS: Record<Status, string> = {
  queued: 'Queued',
  launching: 'Launching',
  running: 'Running',
  unverifiable: 'Unverifiable',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelling: 'Cancelling',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
  interrupted: 'Interrupted'
}

export function RunStatus({ status }: { status: Status }) {
  return <span className={`op-status op-status-${status}`}>{LABELS[status]}</span>
}

export function localOperationalTarget(root: string): OperationalTarget {
  const parts = root.replace(/[\\/]+$/, '').split(/[\\/]/)
  return { kind: 'local', root, label: parts.at(-1) || root }
}

export function formatRunTime(value: string | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value
}

export function targetDescription(kind: 'local' | 'remote', root: string, connectionId?: string): string {
  return kind === 'remote' ? `${connectionId ?? 'remote'} · ${root}` : root
}
