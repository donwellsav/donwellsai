export const OPERATIONAL_OUTPUT_LIMIT = 64 * 1024
export const OPERATIONAL_ERROR_LIMIT = 2 * 1024
export const SCHEDULED_HISTORY_LIMIT = 100
export const PARALLEL_HISTORY_LIMIT = 100
export const MAX_PARALLELISM = 16

export type OperationalTarget =
  | ({ kind: 'local'; root: string; label: string } & Record<string, unknown>)
  | ({ kind: 'remote'; connectionId: string; root: string; label: string } & Record<string, unknown>)

export type ScheduledRunSchedule =
  | ({ kind: 'interval'; minutes: number } & Record<string, unknown>)
  | ({ kind: 'daily'; time: string; timeZone: string } & Record<string, unknown>)

export type ScheduledExecutionStatus =
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unverifiable'
  | 'skipped'
  | 'interrupted'

export type ScheduledRunDefinition = {
  id: string
  name: string
  target: OperationalTarget
  command: string
  schedule: ScheduledRunSchedule
  enabled: boolean
  createdAt: string
  updatedAt: string
  nextRunAt?: string
  lastRunAt?: string
  lastStatus?: ScheduledExecutionStatus
} & Record<string, unknown>

export type ScheduledRunInput = {
  id?: string
  name: string
  target: OperationalTarget
  command: string
  schedule: ScheduledRunSchedule
  enabled?: boolean
}


export type ScheduledExecution = {
  id: string
  scheduledRunId: string
  trigger: 'schedule' | 'manual'
  startedAt: string
  finishedAt?: string
  status: ScheduledExecutionStatus
  sessionId?: string
  exitCode?: number
  output?: string
  error?: string
} & Record<string, unknown>

export type ParallelTaskStatus =
  | 'queued'
  | 'launching'
  | 'running'
  | 'unverifiable'
  | 'succeeded'
  | 'failed'
  | 'cancelling'
  | 'cancelled'

export type ParallelRunStatus =
  | 'queued'
  | 'running'
  | 'unverifiable'
  | 'succeeded'
  | 'failed'
  | 'cancelling'
  | 'cancelled'

export type VerificationSource = { sourceRevision: string | null; contentFingerprint: string; changedFiles: string[] }
export type VerificationOrigin = { kind: 'unattributed' } | { kind: 'agent'; runId: string; sessionId: string; mode: 'native' | 'acp' }
export type VerificationSetup = { outputs: string[]; origin: VerificationOrigin }
export type VerificationRunOptions = { outputs?: string[]; credential?: import('./agent-runtime').AgentSessionCredential }
export type VerificationOutput = { path: string; before: { sha256: string; bytes: number } | null; state: 'pending' | 'created' | 'changed' | 'unchanged' | 'missing' | 'unavailable'; problem?: string }
export type VerificationArtifact = { path: string; sha256: string; bytes: number; attachedAt: string; sourceFingerprint: string | null; relationship: 'attached-reference' | 'observed-during-run' }
export type VerificationEvidence = {
  origin?: VerificationOrigin
  outputs?: VerificationOutput[]
  before: VerificationSource | null
  after: VerificationSource | null
  startedAt: string
  finishedAt?: string
  environment: { platform: string; arch: string; hostNode: string; hostElectron?: string }
  toolVersions: Record<string,string>
  problem?: string
  artifacts: VerificationArtifact[]
}
export type VerificationEntry = { runId: string; task: ParallelRunTask; sourceState: 'current' | 'stale' | 'changed-during-run' | 'unverified' | 'running'; artifacts: Array<VerificationArtifact & {state:'unchecked'|'unchanged'|'changed'|'missing'}> }

export type ParallelRunTask = {
  verificationSetup?: VerificationSetup
  verification?: VerificationEvidence
  id: string
  target: OperationalTarget
  command: string
  status: ParallelTaskStatus
  sessionId?: string
  startedAt?: string
  finishedAt?: string
  exitCode?: number
  error?: string
  output?: string
  retryOfTaskId?: string
} & Record<string, unknown>

export type ParallelRun = {
  id: string
  name: string
  command: string
  concurrency: number
  status: ParallelRunStatus
  createdAt: string
  startedAt?: string
  finishedAt?: string
  retryOfRunId?: string
  tasks: ParallelRunTask[]
} & Record<string, unknown>

export type ParallelRunInput = {
  name: string
  command: string
  targets: OperationalTarget[]
  concurrency: number
}

/** Canonical renderer/preload/main contract for operational runs. */
export type OperationalRunsApi = {
  verificationScripts(workspacePath: string): Promise<string[]>
  verificationRun(workspacePath: string, script: string, options?: VerificationRunOptions): Promise<ParallelRun>
  verificationList(workspacePath: string, verifyArtifacts?: boolean): Promise<VerificationEntry[]>
  verificationOpen(workspacePath: string, runId: string, taskId: string, path: string): Promise<void>
  verificationAttach(workspacePath: string, runId: string, taskId: string, path: string): Promise<VerificationArtifact>

  scheduledRunsList(): Promise<ScheduledRunDefinition[]>
  scheduledRunSave(input: ScheduledRunInput): Promise<ScheduledRunDefinition>
  scheduledRunSetEnabled(id: string, enabled: boolean): Promise<ScheduledRunDefinition>
  scheduledRunDuplicate(id: string): Promise<ScheduledRunDefinition>
  scheduledRunDelete(id: string): Promise<void>
  scheduledRunRunNow(id: string): Promise<ScheduledExecution>
  scheduledRunCancel(executionId: string): Promise<ScheduledExecution>
  scheduledRunHistory(id: string): Promise<ScheduledExecution[]>
  parallelRunsList(): Promise<ParallelRun[]>
  parallelRunStart(input: ParallelRunInput, options?: VerificationRunOptions): Promise<ParallelRun>
  parallelRunRetry(id: string, taskIds: string[]): Promise<ParallelRun>
  parallelRunCancel(id: string): Promise<ParallelRun>
  parallelRunDelete(id: string): Promise<void>
}

export type ScheduledRunsDocument = {
  schemaVersion: 1
  scheduledRuns: ScheduledRunDefinition[]
} & Record<string, unknown>

export type ScheduledExecutionsDocument = {
  schemaVersion: 1
  executions: ScheduledExecution[]
} & Record<string, unknown>

export type ParallelRunsDocument = {
  schemaVersion: 1
  parallelRuns: ParallelRun[]
} & Record<string, unknown>

export class OperationalRunValidationError extends Error {
  readonly code = 'INVALID_OPERATIONAL_RUN_DATA'

  constructor(readonly field: string, message: string) {
    super(`${field}: ${message}`)
    this.name = 'OperationalRunValidationError'
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationalRunValidationError(field, 'must be an object')
  }
  return value as Record<string, unknown>
}

function stringValue(value: unknown, field: string, maximum: number, trim = false): string {
  if (typeof value !== 'string') throw new OperationalRunValidationError(field, 'must be a string')
  const result = trim ? value.trim() : value
  if (result.length === 0) throw new OperationalRunValidationError(field, 'must not be empty')
  if (result.length > maximum) throw new OperationalRunValidationError(field, `must be at most ${maximum} characters`)
  return result
}

function optionalString(value: unknown, field: string, maximum: number): string | undefined {
  if (value === undefined) return undefined
  return stringValue(value, field, maximum)
}
function optionalText(value: unknown, field: string, maximum: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new OperationalRunValidationError(field, 'must be a string')
  if (value.length > maximum) throw new OperationalRunValidationError(field, `must be at most ${maximum} characters`)
  return value
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new OperationalRunValidationError(field, 'must be a boolean')
  return value
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || typeof value !== 'number' || value < minimum || value > maximum) {
    throw new OperationalRunValidationError(field, `must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || typeof value !== 'number') {
    throw new OperationalRunValidationError(field, 'must be an integer')
  }
  return value
}

function isoDate(value: unknown, field: string): string {
  const result = stringValue(value, field, 64)
  if (!Number.isFinite(Date.parse(result))) throw new OperationalRunValidationError(field, 'must be an ISO date')
  return result
}

function optionalIsoDate(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  return isoDate(value, field)
}

function oneOf<T extends string>(value: unknown, field: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new OperationalRunValidationError(field, `must be one of ${values.join(', ')}`)
  }
  return value as T
}

function currentTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function timeZone(value: unknown, field: string): string {
  const result = stringValue(value, field, 128)
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: result }).format(0)
  } catch {
    throw new OperationalRunValidationError(field, `unknown IANA time zone ${JSON.stringify(result)}`)
  }
  return result
}

function localRoot(value: unknown, field: string): string {
  const result = stringValue(value, field, 4096, true)
  if (!result.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(result) && !result.startsWith('\\\\')) {
    throw new OperationalRunValidationError(field, 'must be an absolute path')
  }
  return result
}

function targetLabel(root: string): string {
  const parts = root.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts.at(-1) || root
}

export function operationalTargetKey(target: OperationalTarget): string {
  return target.kind === 'local'
    ? `local\u0000${target.root}`
    : `remote\u0000${target.connectionId}\u0000${target.root}`
}

export function parseOperationalTarget(value: unknown, field = 'target'): OperationalTarget {
  const source = record(value, field)
  const kind = oneOf(source.kind, `${field}.kind`, ['local', 'remote'] as const)
  const root = localRoot(source.root, `${field}.root`)
  const label = source.label === undefined
    ? targetLabel(root)
    : stringValue(source.label, `${field}.label`, 256, true)
  if (kind === 'local') return { ...source, kind, root, label }
  return {
    ...source,
    kind,
    root,
    label,
    connectionId: stringValue(source.connectionId, `${field}.connectionId`, 256, true)
  }
}

export function parseScheduledRunSchedule(value: unknown, field = 'schedule'): ScheduledRunSchedule {
  const source = record(value, field)
  const kind = oneOf(source.kind, `${field}.kind`, ['interval', 'daily'] as const)
  if (kind === 'interval') {
    return { ...source, kind, minutes: integer(source.minutes, `${field}.minutes`, 1, 525_600) }
  }
  const time = stringValue(source.time, `${field}.time`, 5)
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new OperationalRunValidationError(`${field}.time`, 'must use 24-hour HH:MM')
  }
  return {
    ...source,
    kind,
    time,
    timeZone: timeZone(source.timeZone ?? currentTimeZone(), `${field}.timeZone`)
  }
}

export function parseScheduledRunInput(value: unknown, field = 'scheduledRun'): ScheduledRunInput {
  const source = record(value, field)
  return {
    id: source.id === undefined ? undefined : stringValue(source.id, `${field}.id`, 256, true),
    name: stringValue(source.name, `${field}.name`, 256, true),
    target: parseOperationalTarget(source.target, `${field}.target`),
    command: stringValue(source.command, `${field}.command`, 32_768, true),
    schedule: parseScheduledRunSchedule(source.schedule, `${field}.schedule`),
    enabled: source.enabled === undefined ? undefined : booleanValue(source.enabled, `${field}.enabled`)
  }
}


const SCHEDULED_EXECUTION_STATUSES = [
  'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'unverifiable', 'skipped', 'interrupted'
] as const

function migratedScheduledStatus(value: unknown, field: string): ScheduledExecutionStatus {
  if (value === 'ok') return 'succeeded'
  return oneOf(value, field, SCHEDULED_EXECUTION_STATUSES)
}

export function parseScheduledRunDefinition(value: unknown, field = 'scheduledRun'): ScheduledRunDefinition {
  const source = record(value, field)
  const legacyRoot = source.worktreePath
  const target = source.target === undefined && legacyRoot !== undefined
    ? parseOperationalTarget({ kind: 'local', root: legacyRoot }, `${field}.target`)
    : parseOperationalTarget(source.target, `${field}.target`)
  const createdAt = isoDate(source.createdAt, `${field}.createdAt`)
  return {
    ...source,
    id: stringValue(source.id, `${field}.id`, 256, true),
    name: stringValue(source.name, `${field}.name`, 256, true),
    target,
    command: stringValue(source.command, `${field}.command`, 32_768, true),
    schedule: parseScheduledRunSchedule(source.schedule, `${field}.schedule`),
    enabled: booleanValue(source.enabled, `${field}.enabled`),
    createdAt,
    updatedAt: source.updatedAt === undefined ? createdAt : isoDate(source.updatedAt, `${field}.updatedAt`),
    nextRunAt: optionalIsoDate(source.nextRunAt, `${field}.nextRunAt`),
    lastRunAt: optionalIsoDate(source.lastRunAt, `${field}.lastRunAt`),
    lastStatus: source.lastStatus === undefined ? undefined : migratedScheduledStatus(source.lastStatus, `${field}.lastStatus`)
  }
}

export function parseScheduledExecution(value: unknown, field = 'execution'): ScheduledExecution {
  const source = record(value, field)
  const output = source.output ?? source.tail
  return {
    ...source,
    id: stringValue(source.id, `${field}.id`, 256, true),
    scheduledRunId: stringValue(source.scheduledRunId ?? source.automationId, `${field}.scheduledRunId`, 256, true),
    trigger: source.trigger === undefined ? 'schedule' : oneOf(source.trigger, `${field}.trigger`, ['schedule', 'manual'] as const),
    startedAt: isoDate(source.startedAt, `${field}.startedAt`),
    finishedAt: optionalIsoDate(source.finishedAt, `${field}.finishedAt`),
    status: migratedScheduledStatus(source.status, `${field}.status`),
    sessionId: optionalString(source.sessionId, `${field}.sessionId`, 256),
    exitCode: optionalInteger(source.exitCode, `${field}.exitCode`),
    output: optionalText(output, `${field}.output`, OPERATIONAL_OUTPUT_LIMIT),
    error: optionalString(source.error, `${field}.error`, OPERATIONAL_ERROR_LIMIT)
  }
}

const PARALLEL_TASK_STATUSES = [
  'queued', 'launching', 'running', 'unverifiable', 'succeeded', 'failed', 'cancelling', 'cancelled'
] as const
const PARALLEL_RUN_STATUSES = [
  'queued', 'running', 'unverifiable', 'succeeded', 'failed', 'cancelling', 'cancelled'
] as const

function migratedParallelTaskStatus(value: unknown, field: string): ParallelTaskStatus {
  if (value === 'pending') return 'queued'
  if (value === 'done') return 'succeeded'
  return oneOf(value, field, PARALLEL_TASK_STATUSES)
}

function migratedParallelRunStatus(value: unknown, field: string): ParallelRunStatus {
  if (value === 'done') return 'succeeded'
  return oneOf(value, field, PARALLEL_RUN_STATUSES)
}

export function parseParallelRunInput(value: unknown, field = 'parallelRun'): ParallelRunInput {
  const source = record(value, field)
  if (!Array.isArray(source.targets)) throw new OperationalRunValidationError(`${field}.targets`, 'must be an array')
  if (source.targets.length === 0 || source.targets.length > 256) {
    throw new OperationalRunValidationError(`${field}.targets`, 'must contain from 1 to 256 targets')
  }
  const targets = source.targets.map((target, index) => parseOperationalTarget(target, `${field}.targets[${index}]`))
  const keys = new Set<string>()
  for (const target of targets) {
    const key = operationalTargetKey(target)
    if (keys.has(key)) throw new OperationalRunValidationError(`${field}.targets`, `contains duplicate target ${target.label}`)
    keys.add(key)
  }
  return {
    name: stringValue(source.name, `${field}.name`, 256, true),
    command: stringValue(source.command, `${field}.command`, 32_768, true),
    targets,
    concurrency: integer(source.concurrency, `${field}.concurrency`, 1, MAX_PARALLELISM)
  }
}

export function parseParallelRunTask(value: unknown, field = 'task'): ParallelRunTask {
  const source = record(value, field)
  const legacyRoot = source.worktreePath
  const target = source.target === undefined && legacyRoot !== undefined
    ? parseOperationalTarget({ kind: 'local', root: legacyRoot }, `${field}.target`)
    : parseOperationalTarget(source.target, `${field}.target`)
  return {
    ...source,
    id: stringValue(source.id, `${field}.id`, 256, true),
    target,
    command: stringValue(source.command ?? source.prompt, `${field}.command`, 32_768, true),
    status: migratedParallelTaskStatus(source.status, `${field}.status`),
    sessionId: optionalString(source.sessionId, `${field}.sessionId`, 256),
    startedAt: optionalIsoDate(source.startedAt, `${field}.startedAt`),
    finishedAt: optionalIsoDate(source.finishedAt, `${field}.finishedAt`),
    exitCode: optionalInteger(source.exitCode, `${field}.exitCode`),
    error: optionalString(source.error, `${field}.error`, OPERATIONAL_ERROR_LIMIT),
    output: optionalText(source.output, `${field}.output`, OPERATIONAL_OUTPUT_LIMIT),
    retryOfTaskId: optionalString(source.retryOfTaskId, `${field}.retryOfTaskId`, 256),
    verificationSetup: source.verificationSetup === undefined ? undefined : parseVerificationSetup(source.verificationSetup),
    verification: source.verification===undefined?undefined:parseVerificationEvidence(source.verification)
  }
}

export function parseParallelRun(value: unknown, field = 'parallelRun'): ParallelRun {
  const source = record(value, field)
  if (!Array.isArray(source.tasks) || source.tasks.length === 0 || source.tasks.length > 256) {
    throw new OperationalRunValidationError(`${field}.tasks`, 'must contain from 1 to 256 tasks')
  }
  const tasks = source.tasks.map((task, index) => parseParallelRunTask(task, `${field}.tasks[${index}]`))
  const targetKeys = new Set<string>()
  for (const task of tasks) {
    const key = operationalTargetKey(task.target)
    if (targetKeys.has(key)) throw new OperationalRunValidationError(`${field}.tasks`, `contains duplicate target ${task.target.label}`)
    targetKeys.add(key)
  }
  return {
    ...source,
    id: stringValue(source.id, `${field}.id`, 256, true),
    name: stringValue(source.name, `${field}.name`, 256, true),
    command: stringValue(source.command, `${field}.command`, 32_768, true),
    concurrency: integer(source.concurrency ?? source.parallel, `${field}.concurrency`, 1, MAX_PARALLELISM),
    status: migratedParallelRunStatus(source.status, `${field}.status`),
    createdAt: isoDate(source.createdAt, `${field}.createdAt`),
    startedAt: optionalIsoDate(source.startedAt, `${field}.startedAt`),
    finishedAt: optionalIsoDate(source.finishedAt, `${field}.finishedAt`),
    retryOfRunId: optionalString(source.retryOfRunId, `${field}.retryOfRunId`, 256),
    tasks
  }
}

export function parseScheduledRunsDocument(value: unknown): ScheduledRunsDocument {
  if (Array.isArray(value)) {
    return { schemaVersion: 1, scheduledRuns: value.map((item, index) => parseScheduledRunDefinition(item, `scheduledRuns[${index}]`)) }
  }
  const source = record(value, 'scheduledRunsDocument')
  if (source.schemaVersion !== 1) throw new OperationalRunValidationError('scheduledRunsDocument.schemaVersion', 'must be 1')
  if (!Array.isArray(source.scheduledRuns)) throw new OperationalRunValidationError('scheduledRunsDocument.scheduledRuns', 'must be an array')
  return {
    ...source,
    schemaVersion: 1,
    scheduledRuns: source.scheduledRuns.map((item, index) => parseScheduledRunDefinition(item, `scheduledRuns[${index}]`))
  }
}

export function parseScheduledExecutionsDocument(value: unknown): ScheduledExecutionsDocument {
  if (Array.isArray(value)) {
    return { schemaVersion: 1, executions: value.map((item, index) => parseScheduledExecution(item, `executions[${index}]`)) }
  }
  const source = record(value, 'scheduledExecutionsDocument')
  if (source.schemaVersion !== 1) throw new OperationalRunValidationError('scheduledExecutionsDocument.schemaVersion', 'must be 1')
  if (!Array.isArray(source.executions)) throw new OperationalRunValidationError('scheduledExecutionsDocument.executions', 'must be an array')
  return {
    ...source,
    schemaVersion: 1,
    executions: source.executions.map((item, index) => parseScheduledExecution(item, `executions[${index}]`))
  }
}

export function parseParallelRunsDocument(value: unknown): ParallelRunsDocument {
  if (Array.isArray(value)) {
    return { schemaVersion: 1, parallelRuns: value.map((item, index) => parseParallelRun(item, `parallelRuns[${index}]`)) }
  }
  const source = record(value, 'parallelRunsDocument')
  if (source.schemaVersion !== 1) throw new OperationalRunValidationError('parallelRunsDocument.schemaVersion', 'must be 1')
  if (!Array.isArray(source.parallelRuns)) throw new OperationalRunValidationError('parallelRunsDocument.parallelRuns', 'must be an array')
  return {
    ...source,
    schemaVersion: 1,
    parallelRuns: source.parallelRuns.map((item, index) => parseParallelRun(item, `parallelRuns[${index}]`))
  }
}

export function parseVerificationEvidence(value: unknown): VerificationEvidence {
  const input=record(value,'verification')
  const hash=(value:unknown,prefix='')=>{const parsed=stringValue(value,'fingerprint',80);if(!new RegExp('^'+prefix+'[a-f0-9]{64}$').test(parsed))throw new Error('Invalid evidence fingerprint');return parsed}
  const source=(value:unknown):VerificationSource|null=>{
    if(value===null)return null
    const input=record(value,'source')
    if(!Array.isArray(input.changedFiles)||input.changedFiles.length>200)throw new Error('Invalid changed source files')
    return {sourceRevision:input.sourceRevision===null?null:stringValue(input.sourceRevision,'revision',128),contentFingerprint:hash(input.contentFingerprint,'sha256:'),changedFiles:input.changedFiles.map(path=>stringValue(path,'path',4096))}
  }
  const environment=record(input.environment,'environment'),versions=record(input.toolVersions,'versions'),toolVersions:Record<string,string>={}
  for(const [name,version] of Object.entries(versions)){if(!['node','npm','pnpm','yarn','bun'].includes(name))throw new Error('Unknown tool version');toolVersions[name]=stringValue(version,'version',128)}
  if(!Array.isArray(input.artifacts)||input.artifacts.length>32)throw new Error('Too many verification artifacts')
  return {origin: input.origin === undefined ? undefined : parseVerificationOrigin(input.origin), outputs: input.outputs === undefined ? undefined : parseVerificationOutputs(input.outputs), before:source(input.before),after:source(input.after),startedAt:isoDate(input.startedAt,'startedAt'),finishedAt:optionalIsoDate(input.finishedAt,'finishedAt'),environment:{platform:stringValue(environment.platform,'platform',32),arch:stringValue(environment.arch,'arch',32),hostNode:stringValue(environment.hostNode,'hostNode',128),hostElectron:optionalString(environment.hostElectron,'hostElectron',128)},toolVersions,problem:optionalString(input.problem,'problem',2048),artifacts:input.artifacts.map(value=>{const artifact=record(value,'artifact');if(!['attached-reference','observed-during-run'].includes(String(artifact.relationship)))throw new Error('Invalid artifact relationship');return {path:stringValue(artifact.path,'path',4096),sha256:hash(artifact.sha256),bytes:integer(artifact.bytes,'bytes',0,512*1024*1024),attachedAt:isoDate(artifact.attachedAt,'attachedAt'),sourceFingerprint:artifact.sourceFingerprint===null?null:hash(artifact.sourceFingerprint,'sha256:'),relationship:artifact.relationship as VerificationArtifact['relationship']}})}
}

export function parseVerificationOutputPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 16 || value.some(path => typeof path !== 'string' || !path || path.length > 4096 || /[\\\x00-\x1f\x7f]/.test(path) || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..'))) throw new Error('Declare up to16 unique checkout-relative output files without traversal')
  if (new Set(value).size !== value.length) throw new Error('Duplicate declared output path')
  return [...value]
}

export function parseVerificationRunOptions(value: unknown, field = 'verificationOptions'): VerificationRunOptions | undefined {
  if (value === undefined) return undefined
  const source = record(value, field)
  for (const key of Object.keys(source)) if (!['outputs', 'credential'].includes(key)) throw new OperationalRunValidationError(field, `unknown key "${key}"`)
  const credential = source.credential === undefined ? undefined : record(source.credential, `${field}.credential`)
  if (credential && (Object.keys(credential).some(key => !['runId', 'sessionId', 'token'].includes(key)) || ['runId', 'sessionId', 'token'].some(key => typeof credential[key] !== 'string' || !(credential[key] as string) || (credential[key] as string).length > 256))) throw new OperationalRunValidationError(`${field}.credential`, 'must contain only bounded runId, sessionId, and token strings')
  return {
    ...(source.outputs === undefined ? {} : { outputs: parseVerificationOutputPaths(source.outputs) }),
    ...(credential === undefined ? {} : { credential: { runId: credential.runId as string, sessionId: credential.sessionId as string, token: credential.token as string } })
  }
}
function parseVerificationOrigin(value: unknown): VerificationOrigin {
  const input = record(value, 'verification origin')
  if (input.kind === 'unattributed') return {kind:'unattributed'}
  if (input.kind !== 'agent' || !['native','acp'].includes(String(input.mode))) throw new Error('Invalid verification origin')
  return {kind:'agent',runId:stringValue(input.runId,'runId',256),sessionId:stringValue(input.sessionId,'sessionId',256),mode:input.mode as 'native'|'acp'}
}
export function parseVerificationSetup(value: unknown): VerificationSetup {
  const input = record(value, 'verification setup')
  return {outputs:parseVerificationOutputPaths(input.outputs),origin:parseVerificationOrigin(input.origin)}
}
function parseVerificationOutputs(value: unknown): VerificationOutput[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error('Too many observed outputs')
  return value.map(value => { const input=record(value,'output'),before=input.before===null?null:record(input.before,'before output'); if(before && (typeof before.sha256!=='string'||!/^[a-f0-9]{64}$/.test(before.sha256)))throw new Error('Invalid output hash');return {path:stringValue(input.path,'path',4096),before:before?{sha256:before.sha256 as string,bytes:integer(before.bytes,'bytes',0,512*1024*1024)}:null,state:oneOf(input.state,'output state',['pending','created','changed','unchanged','missing','unavailable'] as const),problem:optionalString(input.problem,'output problem',2048)} })
}
