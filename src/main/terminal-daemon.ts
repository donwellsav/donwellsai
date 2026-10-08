import type { McpServer } from '@agentclientprotocol/sdk'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { abandonRuntimeOwner, claimRuntimeOwner, publishRuntimeOwner, reconcileRuntimeOwner, releaseRuntimeOwner, republishRuntimeOwner, type RuntimePublication, type RuntimeReleaseResult } from './runtime-ownership'
import { runtimeIdentityAuthority } from './runtime-identity'
import { chmodSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { logger } from '@shared/logger'
import {
  assertAuthorityUuid,
  parseTaskExecutionSpecification,
  parseVerificationArtifact,
  TASK_AUTHORITY_MAX_ERROR_TEXT,
  TASK_AUTHORITY_MAX_PAGE,
  TASK_AUTHORITY_MAX_USER_TEXT,
  TASK_STATUSES,
  TaskAuthorityError,
  TaskAuthorityValidationError,
  type AuthenticatedAuthorityConnection,
  type ClaimResult,
  type LeaseToken,
  type TaskExecutionSpecificationInput,
  type TaskScheduleCadence,
  type TaskScheduleSpec,
  type TaskStatus
} from '@shared/task-authority'
import type { ProcessIdentity } from '@shared/child-process/process-spec'
import { forceTerminatePosixProcessGroup } from '@shared/child-process/process-tree-termination'
import { SqliteTaskAuthority } from './task-authority/task-authority'
import { DaemonTaskEvidencePort } from './task-authority/task-evidence-port'
import { readRegisteredProjects, TaskAuthorityMigration, TaskAuthorityMigrationError } from './task-authority/task-authority-migration'
import { resolveInteractiveWorkspace } from './interactive-workspace'
import type { BacklogMigrationReadPort, BacklogWorkspaceIdentity } from './task-authority/backlog-migration-reader'
import { SqliteProfileMaintenanceGate } from './profile-maintenance-gate'
import type { AuthenticatedProfileMaintenanceMigrationContext, AuthenticatedProfileMaintenanceParticipantContext } from '@shared/profile-maintenance'
import {
  ProfileMaintenanceError,
  ProfileMaintenanceValidationError,
  parseProfileMaintenanceAbortInput,
  parseProfileMaintenanceFailure,
  parseProfileMaintenanceLease,
  parseProfileMaintenanceOwnerStage,
  parseProfileMaintenanceParticipant,
  parseProfileMaintenanceParticipantSet,
  parseProfileMaintenanceReceipt,
  parseProfileMaintenanceResumeInput,
  parseProfileMaintenanceRetirement,
  parseProfileMaintenanceTransitionIntent,
  type ProfileMaintenanceParticipant
} from '@shared/profile-maintenance'
import { SqliteProviderCatalog, ProviderCatalogError } from './provider-catalog'
import { ProviderMaintenanceMigration, type MigrateCommandInput } from './provider-maintenance-migration'
import { readLegacyAgentCommand } from './legacy-agent-command'
import { TaskExecutionCoordinator, TaskSchedulerPump, type TaskChildRuntime } from './task-authority/task-execution-coordinator'
import {
  AGENT_PROVIDER_DEFINITIONS,
  AGENT_HOOK_CAPABILITY,
  ACP_DAEMON_CAPABILITY,
  agentProviderForExecutable,
  parseAgentExecutable,
  parseAgentTaskIntent,
  type AgentExecutable,
  normalizeAgentHookMessage,
  type AgentTaskIntent,
  type RunningAgent
} from '@shared/agent-runtime'
import { isAgentDriverId, parseProviderInstanceInput, AGENT_PROVIDER_CATALOG_CAPABILITY, type ProviderSelection } from '@shared/provider-authority'
import { asCredentialRef, PROVIDER_SECRET_BROKER_CAPABILITY, type ProviderLaunchAuthorization, type ProviderLaunchSecrets } from '@shared/provider-secret-broker'
import { ProviderSecretBrokerHost, SECRET_BROKER_REGISTER_OP, SECRET_BROKER_RESPOND_OP, SecretBrokerError } from './provider-secret-broker'
import { AgentRegistry } from './agents/registry'
import { sanitizedProcessEnv, sanitizedTemplateEnvironment } from '@shared/child-process/process-environment'
import { SecretOutputBoundary } from './secret-output-redactor'
import {
  ATTENTION_INBOX_CAPABILITY,
  parseAttentionAcknowledgeRequest
} from '@shared/attention-inbox'
import type { RuntimeIdentityAuthority } from '@shared/child-process/process-spec'
import type { TerminalSession } from '@shared/types'
import { AttentionInboxService } from './attention-inbox-service'
import { AttentionInboxStore } from './attention-inbox-store'
import { PtyManager, REAP_EXITED_MS } from './pty'
import {
  createAgentLaunchPlan,
  type AgentHookBinding,
  type AgentLaunchPlan,
  type ResolvedProviderInvocation
} from './agents/provider-hooks'
import { localRuntimePaths, readRuntimeRecord, type LocalRuntimePaths } from './local-runtime'
import { canonicalPrivateDirectory } from '@shared/runtime-file-security'
import { RuntimeOwnershipError, RuntimeOwnershipStore } from '@shared/runtime-ownership'
import { AcpSessions } from './agents/acp-sessions'
export const TASK_AUTHORITY_CAPABILITY = 'task-authority-v1'
export const PROVIDER_CATALOG_CAPABILITY = AGENT_PROVIDER_CATALOG_CAPABILITY

export const SCROLLBACK_MAX = 512 * 1024
export const DAEMON_PROTOCOL_VERSION = 3
export const DAEMON_CAPABILITIES = [
  'sequenced-output',
  'oneshot-jobs',
  'daemon-status',
  'idle-shutdown',
  'agent-runs-v1',
  'agent-argv-v1',
  'agent-task-intent-v1',
  'agent-stop-v1',
  'agent-hooks-v1',
  'agent-session-auth-v1',
  'agent-input-v1',
  ACP_DAEMON_CAPABILITY,
  'runtime-identity-v1',
  ATTENTION_INBOX_CAPABILITY,
  TASK_AUTHORITY_CAPABILITY,
  PROVIDER_CATALOG_CAPABILITY,
  PROVIDER_SECRET_BROKER_CAPABILITY
] as const
const MAX_FRAME_BYTES = 1024 * 1024
const MAX_CLIENT_QUEUED_BYTES = 8 * 1024 * 1024
const MAX_AGENT_COMMAND_BYTES = 16 * 1024
const MAX_HOOK_EVENTS_PER_MINUTE = 120
const TASK_SCHEDULER_TICK_MS = 15_000

type AgentRecord = {
  run: RunningAgent
  hookToken?: string
  hookWindowStartedAt: number
  hookWindowCount: number
  launchPlan: AgentLaunchPlan
}

type HookClientBinding = {
  record: AgentRecord
  token: string
}

export function newAuthToken(): string {
  return randomUUID() + randomUUID().slice(0, 8)
}

function sameToken(actual: string | undefined, supplied: unknown): boolean {
  if (!actual || typeof supplied !== 'string') return false
  const actualBytes = Buffer.from(actual)
  const suppliedBytes = Buffer.from(supplied)
  return actualBytes.byteLength === suppliedBytes.byteLength && timingSafeEqual(actualBytes, suppliedBytes)
}

function cloneRun(run: RunningAgent): RunningAgent {
  return structuredClone(run)
}

/** Stops a detached task child through its recorded Stage 1 process identity. */
function stopProcessByIdentity(identity: ProcessIdentity): Promise<void> {
  if (process.platform === 'win32') {
    return Promise.reject(new Error('process-group stop by identity is unavailable on this platform'))
  }
  return forceTerminatePosixProcessGroup(identity.pid).then(terminated => {
    if (!terminated) throw new Error('task child process group exit is unverifiable after cancellation')
  })
}

function taskWireString(value: unknown, field: string, maximum = 128): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
    throw new TaskAuthorityValidationError(field, `must be a non-empty string of at most ${maximum} characters`)
  }
  return value
}

function taskWireRequiredString(value: unknown, field: string, maximum = 128): string {
  const parsed = taskWireString(value, field, maximum)
  if (parsed === undefined) throw new TaskAuthorityValidationError(field, 'is required')
  return parsed
}

function taskWireUuid(value: unknown, field: string): string {
  const parsed = taskWireRequiredString(value, field, 128)
  return assertAuthorityUuid(parsed, field)
}

function taskWireInteger(value: unknown, field: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TaskAuthorityValidationError(field, `must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

function taskWireEntityVersion(value: unknown, field = 'expectedEntityVersion'): number {
  const parsed = taskWireInteger(value, field, 1, Number.MAX_SAFE_INTEGER)
  if (parsed === undefined) throw new TaskAuthorityValidationError(field, 'is required')
  return parsed
}

function taskWireBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new TaskAuthorityValidationError(field, 'must be a boolean')
  return value
}

function taskWireMemberList(value: unknown, field: string): readonly { projectId: string; taskId: string; specification?: TaskExecutionSpecificationInput }[] {
  if (!Array.isArray(value)) throw new TaskAuthorityValidationError(field, 'must be an array of members')
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new TaskAuthorityValidationError(`${field}[${index}]`, 'must be an object')
    const record = entry as Record<string, unknown>
    return {
      projectId: taskWireRequiredString(record['projectId'], `${field}[${index}].projectId`),
      taskId: taskWireUuid(record['taskId'], `${field}[${index}].taskId`),
      ...(record['specification'] === undefined ? {} : { specification: parseTaskExecutionSpecification(record['specification'], `${field}[${index}].specification`) })
    }
  })
}

function taskWireLeaseToken(value: unknown): LeaseToken {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TaskAuthorityValidationError('token', 'must be a lease token object')
  }
  const record = value as Record<string, unknown>
  return {
    projectId: taskWireRequiredString(record['projectId'], 'token.projectId'),
    taskId: taskWireUuid(record['taskId'], 'token.taskId'),
    attemptId: taskWireUuid(record['attemptId'], 'token.attemptId'),
    ownerId: taskWireUuid(record['ownerId'], 'token.ownerId'),
    leaseId: taskWireUuid(record['leaseId'], 'token.leaseId'),
    generation: taskWireEntityVersion(record['generation'], 'token.generation'),
    expiresAt: taskWireRequiredString(record['expiresAt'], 'token.expiresAt', 64)
  }
}

const WORKER_TASK_OPS = new Set(['task.claim', 'task.write', 'task.handoff.offer', 'task.handoff.cancel', 'task.handoff.accept', 'task.takeover', 'task.mailbox.append'])

/**
 * Profile maintenance and task-migration ops, named once. `handleMaintenanceOp`
 * dispatches this exact set; routing through the set keeps the outer switch from
 * carrying a second, drift-prone copy of the list.
 */
const MAINTENANCE_OPS = new Set([
  'maintenance.state', 'maintenance.admit.affected', 'maintenance.complete.affected',
  'task.migration.status', 'task.migration.import', 'task.migration.shadow', 'task.migration.export',
  'maintenance.acquire', 'maintenance.freeze', 'maintenance.drained', 'maintenance.cutover',
  'maintenance.transition.prepare', 'maintenance.transition.complete', 'maintenance.transition.visibility', 'maintenance.transitions',
  'maintenance.fence', 'maintenance.fail', 'maintenance.resume', 'maintenance.abort', 'maintenance.release'
])

function taskWireScheduleCadence(value: unknown): TaskScheduleCadence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TaskAuthorityValidationError('spec.cadence', 'must be an object')
  }
  const record = value as Record<string, unknown>
  if (record['kind'] === 'interval') {
    const minutes = taskWireInteger(record['minutes'], 'spec.cadence.minutes', 1, 60 * 24 * 31)
    if (minutes === undefined) throw new TaskAuthorityValidationError('spec.cadence.minutes', 'is required')
    return { kind: 'interval', minutes }
  }
  if (record['kind'] === 'daily') {
    const time = taskWireRequiredString(record['time'], 'spec.cadence.time', 5)
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new TaskAuthorityValidationError('spec.cadence.time', 'must be HH:MM')
    const timeZone = taskWireRequiredString(record['timeZone'], 'spec.cadence.timeZone', 128)
    try {
      Intl.DateTimeFormat(undefined, { timeZone })
    } catch {
      throw new TaskAuthorityValidationError('spec.cadence.timeZone', 'must be an IANA time zone name')
    }
    return { kind: 'daily', time, timeZone }
  }
  throw new TaskAuthorityValidationError('spec.cadence.kind', 'must be "interval" or "daily"')
}

function taskWireScheduleSpec(value: unknown): TaskScheduleSpec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TaskAuthorityValidationError('spec', 'must be a schedule specification object')
  }
  const record = value as Record<string, unknown>
  const profileId = taskWireRequiredString(record['profileId'], 'spec.profileId')
  const taskTitle = taskWireRequiredString(record['taskTitle'], 'spec.taskTitle', 512)
  const cadence = taskWireScheduleCadence(record['cadence'])
  const specification = parseTaskExecutionSpecification({ command: record['command'], target: record['target'], verification: record['verification'] }, 'spec')
  return { profileId, taskTitle, cadence, command: specification.command, target: specification.target, verification: specification.verification }
}
/** Detached local execution owner. Client disconnect is never process-exit evidence. */
export class TerminalDaemon {
  private server: Server | null = null
  private boundIno: number | null = null
  private lifecycleGeneration = 0
  private readonly pty: PtyManager
  private readonly attention: AttentionInboxService
  private readonly authToken: string
  private publication: RuntimePublication | null = null
  private readonly paths: LocalRuntimePaths
  /** The profile directory, used to read the published project registry directly. */
  private readonly userDataDir: string
  /** Test seam for the published project registry; production reads the profile file. */
  private readonly projectRegistry?: () => Promise<readonly BacklogWorkspaceIdentity[]>
  private readonly baseEndpointPath: string
  private readonly emitterCommand: readonly string[]
  private readonly scrollback = new Map<string, string>()
  private readonly replay = new Map<string, Array<{ data: string; cols: number; rows: number }>>()
  private readonly truncated = new Set<string>()
  private readonly sequence = new Map<string, number>()
  private readonly clients = new Set<Socket>()
  private readonly connections = new Set<Socket>()
  private readonly connectionClosures = new Map<Socket, Promise<void>>()
  private readonly agentsBySession = new Map<string, AgentRecord>()
  private readonly agentsByRun = new Map<string, AgentRecord>()
  /** One managed-output redactor per session; empty for external launches. */
  private readonly providerBoundary: SecretOutputBoundary
  /** Run records for admitted provider children, keyed by daemon session id. */
  private readonly providerRuns = new Map<string, RunningAgent>()
  /**
   * The lifecycle pump for each provider child.
   *
   * Dismissal must join this before releasing the child's state: the pump reads
   * the PTY's settled exit and final output, and deleting them first would let a
   * clean exit be recorded as a failure with its trailing output dropped.
   */
  private readonly providerPumps = new Map<string, Promise<unknown>>()
  /** The driver registry: the only source of a driver's exact executable. */
  private readonly registry = new AgentRegistry()
  private readonly acp: AcpSessions
  private readonly identity: RuntimeIdentityAuthority
  private readonly taskAuthority: SqliteTaskAuthority
  private readonly providerCatalog: SqliteProviderCatalog
  private readonly migration: TaskAuthorityMigration
  private readonly maintenanceGate: SqliteProfileMaintenanceGate
  private readonly providerMaintenanceMigration: ProviderMaintenanceMigration
  private readonly legacyAgentCommand: () => Promise<readonly MigrateCommandInput[]>
  private readonly taskCoordinator: TaskExecutionCoordinator
  private taskSchedulerPump!: TaskSchedulerPump
  private readonly taskWorkerCredentials = new Map<string, { token: string; ownerId: string; connectionKey: string; projectIds: readonly string[] }>()
  private readonly taskConnections = new Map<Socket, string>()
  /**
   * The one authenticated credential broker. It is registered only after
   * Runtime Identity verifies the current app owner, and it is deliberately
   * reachable from no ordinary op: secret-bearing frames travel only over the
   * dedicated broker channel.
   */
  private readonly secretBroker: ProviderSecretBrokerHost
  private taskPumpTimer: NodeJS.Timeout | null = null
  constructor(opts: {
    userDataDir: string
    authToken: string
    shell?: string
    emitterCommand?: readonly string[]
    identity?: RuntimeIdentityAuthority
    /**
     * Registered projects the migration covers, resolved by the app process
     * that owns the repository registry. Absent (or empty) means the migration
     * has no Backlog sources to freeze on this profile.
     */
    projectRegistry?: () => Promise<readonly BacklogWorkspaceIdentity[]>
    /**
     * Test seam for the managed-output redactor. Production owns exactly one
     * boundary per daemon, shared by every launch it settles.
     */
    providerBoundary?: SecretOutputBoundary
    /** Migration-only Backlog reader bound to the app's pinned CLI. */
    backlogPort?: () => BacklogMigrationReadPort
    /**
     * The legacy `agentCommand` this one-time migration imports. Absent, the
     * daemon reads the app's own settings file — the same shape as
     * `readRegisteredProjects` below, so production never depends on an
     * injected port and the migration is available on a real first boot.
     */
    legacyAgentCommand?: () => Promise<readonly MigrateCommandInput[]> | readonly MigrateCommandInput[]
  }) {
    const userDataDir = canonicalPrivateDirectory(opts.userDataDir, { create: true, requireCanonical: true })
    this.userDataDir = userDataDir
    this.projectRegistry = opts.projectRegistry
    this.authToken = opts.authToken
    this.identity = opts.identity ?? runtimeIdentityAuthority()
    this.providerBoundary = opts.providerBoundary ?? new SecretOutputBoundary()
    this.paths = localRuntimePaths(userDataDir, 'terminal')
    this.baseEndpointPath = this.paths.socketPath
    this.secretBroker = new ProviderSecretBrokerHost({
      verifyOwner: identity => this.verifiesAppOwner(identity)
    })
    this.acp = new AcpSessions(userDataDir, { changed: snapshot => this.broadcast({ event: 'acp', snapshot }), identity: this.identity })
    this.emitterCommand = opts.emitterCommand ?? [
      process.execPath,
      process.argv[1] ?? '',
      '--emit-agent-hook'
    ]
    this.pty = new PtyManager(
      {
        data: (sessionId, data) => this.handlePtyData(sessionId, data),
        exit: (sessionId, exitCode) => this.handlePtyExit(sessionId, exitCode),
        // Titles arrive settled: PtyManager runs `settleProviderTitle` before it
        // stores the record's title, so this event and the record agree.
        title: (sessionId, title) => this.broadcast({ event: 'title', sessionId, title })
      },
      opts.shell,
      undefined,
      this.identity,
      (sessionId, title) => this.settleProviderTitle(sessionId, title)
    )
    this.attention = new AttentionInboxService(new AttentionInboxStore(opts.userDataDir), {
      resolveContact: (sessionId) => ({
        currentLiveness: this.agentsBySession.get(sessionId)?.run.liveness ?? 'unknown',
        terminalAvailability: this.pty.has(sessionId) ? 'retained' : 'unavailable'
      })
    })
    this.taskAuthority = SqliteTaskAuthority.open({ userDataDirectory: this.paths.runtimeDir })
    this.providerCatalog = new SqliteProviderCatalog({ database: this.taskAuthority.database })
    this.migration = new TaskAuthorityMigration({
      authority: this.taskAuthority,
      database: this.taskAuthority.database,
      profileId: opts.userDataDir,
      userDataDirectory: opts.userDataDir,
      readers: {
        parallelRuns: async () => [],
        scheduledRuns: async () => [],
        scheduledExecutions: async () => [],
        projects: () => (opts.projectRegistry ?? (async () => readRegisteredProjects(opts.userDataDir)))(),
        projectTaskSummaries: async () => ({})
      },
      backlog: opts.backlogPort?.() ?? {
        run: async () => { throw new TaskAuthorityError('MIGRATION_REQUIRED', 'the migration-only Backlog reader is not configured in this daemon') },
        readWorkspaceFile: async () => { throw new TaskAuthorityError('MIGRATION_REQUIRED', 'the migration-only Backlog reader is not configured in this daemon') }
      }
    })
    // An operator abort through the gate must do the whole job: clear the lease
    // *and* discard the candidate rows and return the migration to legacy. The
    // gate owns the lease, the migration owns the rows, and this seam joins
    // them so a wire `maintenance.abort` leaves neither behind.
    this.maintenanceGate = new SqliteProfileMaintenanceGate({
      database: this.taskAuthority.database,
      profileId: opts.userDataDir,
      onDiscardCandidateState: migrationId => this.discardAbortedMigration(migrationId)
    })
    // The legacy `agentCommand` → provider-instance cutover runs under the very
    // same gate, on the very same database, as the Stage 2 task authority.
    this.providerMaintenanceMigration = new ProviderMaintenanceMigration({
      gate: this.maintenanceGate,
      catalog: this.providerCatalog,
      profileId: opts.userDataDir,
      // The settings publication removes the legacy command once the Catalog is
      // authoritative, so the profile stops carrying two launch authorities.
      userDataDir: opts.userDataDir
    })
    const legacyAgentCommand = opts.legacyAgentCommand
    // Default to reading the app's settings file: a constructor that fell back to
    // "no commands" would record an empty migration as complete on a real first
    // boot, permanently no-op'ing every later startup and stranding the user's
    // actual agent command.
    this.legacyAgentCommand = legacyAgentCommand === undefined
      ? async () => readLegacyAgentCommand(opts.userDataDir)
      : async () => legacyAgentCommand()
    this.taskCoordinator = new TaskExecutionCoordinator({
      authority: this.taskAuthority,
      evidence: new DaemonTaskEvidencePort(),
      verifyIdentity: identity => this.identity.verify(identity),
      ports: {
        jobs: {
          openJob: (cwd, command, cols, rows) => {
            const session = this.pty.openJob(cwd, command, cols ?? 100, rows ?? 30)
            return { sessionId: session.id, processIdentity: this.pty.processIdentity(session.id) }
          },
          stop: sessionId => this.pty.stop(sessionId),
          stopProcess: identity => stopProcessByIdentity(identity),
          output: (sessionId, afterOffset) => {
            const scrollback = this.scrollback.get(sessionId) ?? ''
            let exited = false
            let exitCode: number | undefined
            try {
              const result = this.pty.jobResult(sessionId)
              exited = result.exited
              exitCode = result.exitCode
            } catch {
              exited = false
            }
            return { output: scrollback.slice(afterOffset), totalBytes: scrollback.length, exited, exitCode }
          }
        },
        agents: {
          openAgent: (cwd, _command, launch) => {
            if (!launch) throw new Error('task agent launches require a resolvable agent provider executable')
            const snapshot = this.acp.start(cwd, randomUUID(), launch, [])
            return { sessionId: snapshot.id, processIdentity: snapshot.processIdentity }
          },
          stop: async sessionId => {
            const workspacePath = this.acp.list().find(snapshot => snapshot.id === sessionId)?.workspacePath
            if (!workspacePath) throw new Error('unknown ACP task session: ' + sessionId)
            await this.acp.control(workspacePath, sessionId, 'stop')
          },
          stopProcess: identity => stopProcessByIdentity(identity),
          output: sessionId => {
            const snapshot = this.acp.list().find(candidate => candidate.id === sessionId)
            const exited = snapshot?.state === 'exited'
            return { output: '', totalBytes: 0, exited, exitCode: exited ? 0 : undefined }
          }
        }
      },
      /**
       * The provider-backed launch seam, live.
       *
       * Until Task 4 this was deliberately absent, so `launchProviderBacked`
       * returned a rejection and no production caller could reach it. Every port
       * below is the daemon's own machinery: the shared maintenance gate, the
       * daemon-owned Catalog, the driver registry, and the PTY that owns the
       * child. Managed materialization still requires the Electron Secret
       * Authority broker to be registered; without it a managed launch fails
       * closed with `SECRET_AUTHORITY_UNAVAILABLE` and spawns nothing.
       */
      provider: {
        maintenance: {
          admit: async (participant, operationId) => {
            const admission = await this.maintenanceGate.admit({ connectionId: 'daemon-launch' }, participant, operationId)
            return { operationId: admission.operationId, epoch: admission.epoch, ownerConnectionId: admission.ownerConnectionId }
          },
          complete: async (operationId, epoch, ownerConnectionId, outcome) => {
            await this.maintenanceGate.complete(
              { connectionId: 'daemon-launch' },
              { participant: 'provider-authority', operationId, epoch, ownerConnectionId },
              outcome
            )
          }
        },
        catalog: { prepareLaunch: input => this.providerCatalog.prepareLaunch(input) },
        driverExecutable: driverId => {
          const definition = AGENT_PROVIDER_DEFINITIONS.find(candidate => candidate.id === driverId)
          return definition === undefined ? undefined : this.registry.findExecutable(definition.command)
        },
        createIsolationRoot: sessionId => {
          const root = join(this.paths.runtimeDir, 'provider-isolation', sessionId)
          mkdirSync(root, { recursive: true, mode: 0o700 })
          return root
        },
        removeIsolationRoot: root => { rmSync(root, { recursive: true, force: true }) },
        secrets: {
          materialize: authorization => this.secretBroker.materialize({
            ...authorization,
            // The coordinator carries the ref as opaque text; the broker is the
            // one place that brands it for the Secret Authority.
            credentialRef: asCredentialRef(authorization.credentialRef)
          })
        },
        boundary: this.providerBoundary,
        child: {
          open: input => {
            // A managed/none launch supplies a complete allowlist environment
            // and is used exactly. An external launch inherits the process
            // environment — that is what external authentication means — but
            // must not inherit THIS app's authority: the daemon runs with a
            // private token and the Electron runtime-mode variable, and the
            // coordinator builds the external environment from `process.env`.
            // Sanitizing here (rather than relying on the PTY's merge, which
            // applies its additions after stripping) is what actually removes
            // them, and both modes then supply a complete environment.
            const environment = input.credentialMode === 'external'
              // The ordinary PTY merge would re-add anything this sanitizer just
              // removed, because the coordinator's external environment IS a copy
              // of `process.env`. Sanitizing the additions themselves and using
              // them exactly is what actually strips the daemon's authority,
              // while keeping the terminal variables an interactive CLI needs.
              ? sanitizedProcessEnv(input.environment, { TERM: 'xterm-256color', TERM_PROGRAM: 'donwells.ai' })
              : input.environment
            const session = this.pty.openAgent(input.workspaceRoot, '', input.cols, input.rows, {
              id: input.sessionId,
              env: environment,
              launch: { executable: input.invocation.program, args: [...input.invocation.args] },
              exactEnv: true
            })
            this.sequence.set(session.id, 0)
            this.publishProviderRun(input.sessionId, input.selection, input.workspaceRoot, input.invocation, input.task)
            return { sessionId: session.id, processIdentity: this.pty.processIdentity(session.id) }
          },
          stop: sessionId => this.pty.stop(sessionId),
          stopProcess: identity => stopProcessByIdentity(identity),
          output: sessionId => {
            // The settled fact, not raw liveness: `liveness` reports an exit as
            // soon as the OS does, but the code and trailing output only become
            // complete at the deferred settlement. Reading liveness here would
            // let the pump record "exited with code null" for a clean exit.
            const settled = this.pty.settledExit(sessionId)
            return {
              stdout: this.scrollback.get(sessionId) ?? '',
              stderr: '',
              exited: settled.exited,
              exitCode: settled.exitCode
            }
          }
        }
      }
    })
  }

  /**
   * Stops one provider child through the PTY the daemon owns it with.
   *
   * Provider runs carry no `AgentRecord`, so they take the same PTY operations
   * as an ordinary agent but none of its launch-plan bookkeeping.
   */
  private async stopProviderRun(sessionId: string, run: RunningAgent): Promise<RunningAgent> {
    if (run.liveness !== 'exited') {
      const stopping: RunningAgent = { ...run, activity: 'stopping', stopRequestedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      this.providerRuns.set(sessionId, stopping)
      this.broadcast({ event: 'agent', run: stopping })
    }
    await this.pty.stop(sessionId)
    return cloneRun(this.providerRuns.get(sessionId) ?? run)
  }

  /** Sends an interrupt to one live provider child; liveness still comes from the PTY. */
  private interruptProviderRun(sessionId: string, run: RunningAgent): RunningAgent {
    if (run.liveness === 'exited') return cloneRun(run)
    if (!this.pty.has(sessionId)) {
      const unverifiable: RunningAgent = { ...run, liveness: 'unverifiable', updatedAt: new Date().toISOString() }
      this.providerRuns.set(sessionId, unverifiable)
      this.broadcast({ event: 'agent', run: unverifiable })
      throw new Error('agent process ownership is unverifiable')
    }
    this.pty.interrupt(sessionId)
    const stopRequestedAt = new Date().toISOString()
    const interrupted: RunningAgent = {
      ...run,
      detail: 'Interrupt sent; the native process may remain open.',
      stopRequestedAt,
      updatedAt: stopRequestedAt
    }
    this.providerRuns.set(sessionId, interrupted)
    this.broadcast({ event: 'agent', run: interrupted })
    return cloneRun(interrupted)
  }

  /** Releases one exited provider run and everything the daemon retains for it. */
  private async dismissProviderRun(sessionId: string): Promise<void> {
    // Join the lifecycle pump first: it reads the PTY's settled exit and final
    // output, so releasing either before it finishes would let a clean exit be
    // recorded as a failure with its trailing output dropped.
    await this.providerPumps.get(sessionId)?.catch(() => undefined)
    this.providerPumps.delete(sessionId)
    this.pty.dismissExited(sessionId)
    this.providerRuns.delete(sessionId)
    this.providerPumps.delete(sessionId)
    // Terminal teardown: the PTY is dismissed and the pump joined, so the
    // launch's registration can be dropped rather than only zeroized.
    this.providerBoundary.forget(sessionId)
    this.scrollback.delete(sessionId); this.replay.delete(sessionId)
    this.truncated.delete(sessionId)
    this.sequence.delete(sessionId)
    this.broadcast({ event: 'agent-dismissed', sessionId })
  }

  /**
   * Publishes the run record for one admitted provider child, so the renderer
   * shows the exact driver/instance identity the launch was admitted for rather
   * than a command family. Identity and display facts only: no credential ref,
   * generation, or environment value is recorded here.
   */
  private publishProviderRun(sessionId: string, selection: ProviderSelection, workspaceRoot: string, invocation: ResolvedProviderInvocation, task?: AgentTaskIntent): void {
    const now = new Date().toISOString()
    const run: RunningAgent = {
      id: randomUUID(),
      sessionId,
      workspacePath: workspaceRoot,
      command: [invocation.program, ...invocation.args].join(' '),
      ...(task === undefined ? {} : { task: parseAgentTaskIntent(task) }),
      provider: {
        driverId: selection.driverId,
        providerInstanceId: selection.providerInstanceId,
        providerInstanceRevision: selection.instanceRevision,
        accountId: selection.accountId,
        providerAccountRevision: selection.accountRevision
      },
      startedAt: now,
      updatedAt: now,
      liveness: 'live',
      activity: 'working',
      hook: { support: 'unavailable', events: [], reason: 'Provider-backed launches report liveness from the PTY only.', connected: false }
    }
    this.providerRuns.set(sessionId, run)
    this.broadcast({ event: 'agent', run })
  }

  hasLiveSessions(): boolean {
    return this.pty.list().some((session) => !session.exited) || this.acp.hasOwnedSessions()
  }
  /** True only after the server is listening and its ownership row is active. */
  isReady(): boolean {
    return this.server?.listening === true && this.publication?.owner.state === 'active'
  }

  hasOwnedSessions(): boolean {
    return this.pty.list().length > 0 || this.acp.hasOwnedSessions()
  }

  async stopIfIdle(): Promise<boolean> {
    ++this.lifecycleGeneration
    if (this.hasOwnedSessions()) return false
    if (this.server && this.endpointPathState() === 'foreign') throw new Error('terminal daemon endpoint path changed; refusing to close it')
    if (this.taskPumpTimer) {
      clearInterval(this.taskPumpTimer)
      this.taskPumpTimer = null
    }
    const server = this.server
    this.server = null
    const connectionClosures = [...this.connectionClosures.values()]
    for (const client of this.connections) client.destroy()
    this.clients.clear()
    let released: RuntimeReleaseResult | 'no-owner' = 'no-owner'
    try {
      if (server) {
        const closed = Promise.withResolvers<void>()
        server.close(() => closed.resolve())
        await closed.promise
      }
      await Promise.all(connectionClosures)
    } finally {
      this.removeOwnedEndpoint()
      this.boundIno = null
      released = this.releaseRuntimeOwner()
    }
    if (released === 'cleanup-failed') throw new Error('terminal daemon shutdown could not verify ownership cleanup: ' + released)
    return true
  }

  async start(): Promise<void> {
    if (this.server) throw new Error('Terminal daemon is already started')
    const lifecycleGeneration = ++this.lifecycleGeneration
    this.prepareRuntimeDirectory()
    const authority = runtimeIdentityAuthority()
    const reconciliation = await reconcileRuntimeOwner({
      userDataDir: dirname(this.paths.runtimeDir),
      kind: 'terminal-daemon',
      authority,
      store: this.publication?.store,
      candidate: this.publication ?? undefined
    })
    if (reconciliation.action === 'reconnect-legacy') throw new RuntimeOwnershipError('OWNER_LIVE', 'legacy runtime endpoint is reachable; explicit recovery is required before replacement')
    const publication = reconciliation.action === 'claim'
      ? claimRuntimeOwner({
          userDataDir: dirname(this.paths.runtimeDir),
          kind: 'terminal-daemon',
          endpoint: this.baseEndpointPath,
          authToken: this.authToken,
          captureIdentity: generation => authority.capture(process.pid, { family: 'terminal-daemon', executablePath: process.execPath, generation }),
          authority
        })
      : reconciliation.publication
    this.publication = publication
    this.paths.socketPath = publication.owner.endpoint
    let server: Server | null = null
    try {
      if (lifecycleGeneration !== this.lifecycleGeneration) throw new Error('Terminal daemon start was cancelled before bind')
      server = createServer(socket => this.handleClient(socket))
      this.server = server
      const listening = Promise.withResolvers<void>()
      const onError = (error: Error): void => {
        server?.removeListener('listening', onListening)
        listening.reject(error)
      }
      const onListening = (): void => {
        server?.removeListener('error', onError)
        listening.resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.paths.socketPath)
      await listening.promise
      if (lifecycleGeneration !== this.lifecycleGeneration) throw new Error('Terminal daemon start was cancelled before publication')
      if (process.platform !== 'win32') {
        this.boundIno = statSync(this.paths.socketPath).ino
        chmodSync(this.paths.socketPath, 0o600)
      }
      if (reconciliation.action === 'republish-active') republishRuntimeOwner(publication, publication.owner.locatorSha256)
      else await publishRuntimeOwner(publication, () => undefined)
      // Startup resolves the persisted maintenance phase before any affected
      // handler registers. A `failed` migration registers no scheduler or
      // launch handler at all: the durable phase must be resumed or aborted
      // explicitly before affected work may restart.
      this.resolveMaintenancePhaseAtStartup()
      // The one-time provider-authority cutover runs here — after the durable
      // phase is resolved but before any affected handler registers — so the
      // Catalog is migrated before provider selection can be observed or used.
      // A completed migration is a no-op; an interrupted one resumes its lease.
      await this.runProviderMaintenanceMigration()
      this.taskSchedulerPump = new TaskSchedulerPump(this.taskAuthority, this.daemonWorkerOwnerId(), { connectionId: 'daemon-scheduler' })
      await this.reconcileTaskAuthority()
      this.scheduleTaskSchedulerTick()
      this.taskPumpTimer = setInterval(() => {
        this.scheduleTaskSchedulerTick()
      }, TASK_SCHEDULER_TICK_MS)
      this.taskPumpTimer.unref?.()
    } catch (error) {
      let failure: unknown = error
      if (server?.listening && this.endpointPathState() === 'foreign') {
        failure = new Error('terminal daemon endpoint path changed during startup; refusing to close it', { cause: error })
      }
      if (server?.listening) {
        const closed = Promise.withResolvers<void>()
        server.close(() => closed.resolve())
        await closed.promise
      }
      this.server = null
      this.removeOwnedEndpoint()
      this.boundIno = null
      if (lifecycleGeneration !== this.lifecycleGeneration && this.publication === publication && publication.owner.state === 'preparing') {
        const released = this.releaseRuntimeOwner()
        if (released !== 'released') failure = new Error('Terminal daemon startup cleanup failed: ' + released, { cause: failure })
      }
      throw failure
    }
  }

  private prepareRuntimeDirectory(): void {
    mkdirSync(this.paths.runtimeDir, { recursive: true, mode: 0o700 })
    mkdirSync(this.paths.socketDir, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') {
      chmodSync(this.paths.runtimeDir, 0o700)
      chmodSync(this.paths.socketDir, 0o700)
    }
  }

  private endpointPathState(): 'owned' | 'missing' | 'foreign' {
    if (process.platform === 'win32') return 'owned'
    if (this.boundIno === null || !this.publication || this.publication.owner.endpoint !== this.paths.socketPath) return 'foreign'
    try {
      const endpoint = lstatSync(this.paths.socketPath)
      return endpoint.isSocket() && endpoint.ino === this.boundIno && (endpoint.mode & 0o777) === 0o600
        && (!process.getuid || endpoint.uid === process.getuid()) ? 'owned' : 'foreign'
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'foreign'
    }
  }

  private removeOwnedEndpoint(): void {
    if (this.endpointPathState() !== 'owned') return
    try { rmSync(this.paths.socketPath) } catch {}
  }
  private releaseRuntimeOwner(): RuntimeReleaseResult | 'no-owner' {
    const publication = this.publication
    if (!publication) return 'no-owner'
    const result = publication.owner.state === 'active'
      ? releaseRuntimeOwner(publication)
      : abandonRuntimeOwner(publication)
    if (result === 'released') {
      this.publication = null
      publication.store.close()
    }
    return result
  }

  /**
   * Redacts a managed session's window title. A title is a discrete string
   * rather than a stream chunk, so it is settled through the stream the PTY does
   * not use for data and its carry is released immediately. PtyManager runs this
   * before it stores the title, so the session record served by `session.list`
   * and `session.attach` carries the same bytes as the title event.
   */
  private settleProviderTitle(sessionId: string, title: string): string {
    if (!this.providerBoundary.has(sessionId)) return title
    return this.providerBoundary.push(sessionId, 'stderr', title) + this.providerBoundary.flush(sessionId, 'stderr')
  }

  private handlePtyData(sessionId: string, data: string): void {
    if (data.length === 0) return
    // A managed provider launch's exact credential values are settled here,
    // before the bytes reach any sink: scrollback, replay, and the live
    // data event the renderer, native terminals, and operational runs share.
    // A PTY exposes one merged stream, which is the `stdout` stream the
    // coordinator's output port reports. `push` already encodes both policies a
    // caller would re-derive: a session with no registered redactor passes
    // through unchanged, and a closed one returns nothing, so every later byte
    // is dropped rather than emitted unredacted.
    const settled = this.providerBoundary.push(sessionId, 'stdout', data)
    if (settled.length === 0) return
    this.sinkSessionBytes(sessionId, settled)
  }

  /** Writes one chunk of already-settled bytes to scrollback, replay, and the live event. */
  private sinkSessionBytes(sessionId: string, data: string): void {
    const sequence = (this.sequence.get(sessionId) ?? 0) + 1
    this.sequence.set(sessionId, sequence)
    let current = (this.scrollback.get(sessionId) ?? '') + data
    const size = this.pty.dimensions(sessionId)
    const replay = this.replay.get(sessionId) ?? []
    if (size) {
      const last = replay.at(-1)
      if (last?.cols === size.cols && last.rows === size.rows) last.data += data
      else replay.push({ ...size, data })
      let excess = Math.max(0, current.length - SCROLLBACK_MAX)
      while (replay.length && excess > 0) {
        const first = replay[0]!
        if (first.data.length <= excess) { excess -= first.data.length; replay.shift() }
        else { first.data = first.data.slice(excess); excess = 0 }
      }
      if (replay.length > 4096) {
        replay.splice(0, replay.length - 4096)
        current = replay.map(chunk => chunk.data).join('')
        this.truncated.add(sessionId)
      }
      this.replay.set(sessionId, replay)
    }
    if (current.length > SCROLLBACK_MAX) this.truncated.add(sessionId)
    this.scrollback.set(
      sessionId,
      current.length > SCROLLBACK_MAX ? current.slice(current.length - SCROLLBACK_MAX) : current
    )
    this.broadcast({ event: 'data', sessionId, data, sequence })
  }

  private handlePtyExit(sessionId: string, exitCode: number): void {
    // The child's output pipes have closed, so the redactor's undecided carry is
    // safe to emit: flush it into the same sinks before the exit is announced.
    if (this.providerBoundary.has(sessionId)) {
      const residual = this.providerBoundary.flush(sessionId, 'stdout') + this.providerBoundary.flush(sessionId, 'stderr')
      if (residual.length > 0) this.sinkSessionBytes(sessionId, residual)
    }
    this.broadcast({ event: 'exit', sessionId, exitCode })
    // A provider child's exit is a daemon-owned fact: the coordinator's output
    // port reports it rather than inferring exit from transport loss.
    const providerRun = this.providerRuns.get(sessionId)
    if (providerRun) {
      const updated: RunningAgent = {
        ...providerRun,
        liveness: 'exited',
        activity: exitCode === 0 ? 'completed' : 'failed',
        exitCode,
        updatedAt: new Date().toISOString()
      }
      this.providerRuns.set(sessionId, updated)
      this.broadcast({ event: 'agent', run: updated })
    }
    const record = this.agentsBySession.get(sessionId)
    if (record) {
      delete record.hookToken
      this.agentsByRun.delete(record.run.id)
      record.launchPlan.cleanup()
      const updatedAt = new Date().toISOString()
      const stopped = record.run.stopRequestedAt !== undefined
      record.run = {
        ...record.run,
        liveness: 'exited',
        activity: stopped || exitCode === 0 ? 'completed' : 'failed',
        detail: stopped
          ? 'Stopped by user'
          : exitCode === 0 ? 'Process exited successfully' : `Process exited with code ${exitCode}`,
        exitCode,
        updatedAt
      }
      this.publishAgent(record.run)
      return
    }
    if (this.pty.isRetained(sessionId)) return
    setTimeout(() => {
      this.scrollback.delete(sessionId); this.replay.delete(sessionId)
      this.truncated.delete(sessionId)
      this.sequence.delete(sessionId)
      this.providerRuns.delete(sessionId)
      this.providerPumps.delete(sessionId)
      this.providerBoundary.forget(sessionId)
    }, REAP_EXITED_MS).unref()
  }

  private publishAgent(run: RunningAgent): void {
    this.attention.observe(run)
    this.broadcast({ event: 'agent', run: cloneRun(run) })
  }

  private send(socket: Socket, frame: Buffer): void {
    if (socket.destroyed) return
    // ponytail: bound each client's queue, not PTY production. 8 MiB accommodates an escaped
    // 512 KiB terminal snapshot or 2 MiB ACP replay; a lagging reader must reconnect/reattach.
    if (socket.writableLength + frame.byteLength > MAX_CLIENT_QUEUED_BYTES) {
      socket.destroy(new Error('terminal daemon client output queue exceeded limit'))
      return
    }
    socket.write(frame)
  }

  private broadcast(frame: Record<string, unknown>): void {
    const line = Buffer.from(`${JSON.stringify(frame)}\n`)
    for (const client of this.clients) this.send(client, line)
  }

  private authenticateHook(message: Record<string, unknown>): HookClientBinding | undefined {
    const runId = String(message['runId'] ?? '')
    const sessionId = String(message['sessionId'] ?? '')
    const token = typeof message['hookToken'] === 'string' ? message['hookToken'] : ''
    const record = this.agentsByRun.get(runId)
    if (!record || record.run.sessionId !== sessionId || record.run.liveness !== 'live') return undefined
    if (!sameToken(record.hookToken, token)) return undefined
    return { record, token }
  }

  private activePublication(): RuntimePublication | null {
    const publication = this.publication
    if (!publication || publication.owner.state !== 'active' || publication.owner.locatorSha256 === null) return null
    const locator = readRuntimeRecord(publication.paths.runtimeFile)
    if (locator.status !== 'current' || locator.sha256 !== publication.owner.locatorSha256) return null
    try {
      const owner = publication.store.resolveActive('terminal-daemon', locator.record, locator.sha256)
      if (owner.ownerId !== publication.owner.ownerId || owner.generation !== publication.owner.generation
        || owner.endpoint !== publication.owner.endpoint || owner.authToken !== publication.owner.authToken
        || JSON.stringify(owner.identity) !== JSON.stringify(publication.owner.identity)) return null
      return publication
    } catch {
      return null
    }
  }

  private handleClient(socket: Socket): void {
    let privileged = false
    let hookBinding: HookClientBinding | undefined
    let buffer = ''
    const decoder = new StringDecoder('utf8')
    this.connections.add(socket)
    const closed = Promise.withResolvers<void>()
    this.connectionClosures.set(socket, closed.promise)
    socket.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk)
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
        socket.destroy(new Error('terminal daemon frame exceeded limit'))
        return
      }
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        let message: Record<string, unknown>
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (!privileged && !hookBinding) {
          const active = this.activePublication()
          if (active && message['op'] === 'hello'
            && sameToken(active.owner.authToken, message['authToken'])
            && typeof message['id'] === 'string'
            && message['id'].length > 0
            && message['id'].length <= 256) {
            privileged = true
            this.clients.add(socket)
            this.taskConnections.set(socket, randomUUID())
            this.reply(socket, message['id'], true, {
              protocolVersion: DAEMON_PROTOCOL_VERSION,
              runtimeIdentityContractVersion: 1,
              capabilities: DAEMON_CAPABILITIES,
              ownerId: active.owner.ownerId,
              generation: active.owner.generation,
              processIdentity: active.owner.identity
            })
            continue
          }
          if (active && message['op'] === 'hook.hello') {
            hookBinding = this.authenticateHook(message)
            if (hookBinding) {
              this.reply(socket, message['id'], true, { capabilities: [AGENT_HOOK_CAPABILITY] })
              continue
            }
          }
          socket.destroy()
          return
        }
        if (hookBinding) this.handleHookOp(socket, hookBinding, message)
        else if (message['op'] === SECRET_BROKER_REGISTER_OP || message['op'] === SECRET_BROKER_RESPOND_OP) this.handleBrokerOp(socket, message)
        else void this.handleOp(socket, message)
      }
    })
    socket.on('close', async () => {
      this.clients.delete(socket)
      // A disconnect invalidates every pending materialization request for this
      // connection, and late responses are dropped as no-longer-pending.
      this.secretBroker.invalidate(socket)
      const connectionKey = this.taskConnections.get(socket)
      this.taskConnections.delete(socket)
      if (connectionKey !== undefined) {
        for (const [credentialId, binding] of this.taskWorkerCredentials) {
          if (binding.connectionKey === connectionKey) this.taskWorkerCredentials.delete(credentialId)
        }
        // A disconnect marks that connection's ordinary admissions
        // indeterminate; only the same participant can reconcile them later.
        await this.maintenanceGate.markConnectionDisconnected(connectionKey).catch(error => {
          logger.warn({ err: error }, 'profile maintenance disconnect bookkeeping failed')
        })
      }
      this.connections.delete(socket)
      this.connectionClosures.delete(socket)
      closed.resolve()
    })
    socket.on('error', () => socket.destroy())
  }

  private reply(
    socket: Socket,
    idValue: unknown,
    ok: boolean,
    result: Record<string, unknown>
  ): void {
    const id = String(idValue ?? '')
    if (id) this.send(socket, Buffer.from(`${JSON.stringify({ id, ok, ...result })}\n`))
  }

  private handleHookOp(
    socket: Socket,
    binding: HookClientBinding,
    message: Record<string, unknown>
  ): void {
    const id = message['id']
    if (message['op'] !== 'hook.emit') {
      this.reply(socket, id, false, { error: 'hook clients may only emit bounded status events' })
      return
    }
    const record = binding.record
    if (record.run.liveness !== 'live' || !sameToken(record.hookToken, binding.token)) {
      this.reply(socket, id, false, { error: 'agent hook binding expired' })
      return
    }
    const now = Date.now()
    if (now - record.hookWindowStartedAt >= 60_000) {
      record.hookWindowStartedAt = now
      record.hookWindowCount = 0
    }
    if (record.hookWindowCount >= MAX_HOOK_EVENTS_PER_MINUTE) {
      this.reply(socket, id, false, { error: 'agent hook rate limit exceeded' })
      return
    }
    const hook = normalizeAgentHookMessage({ kind: message['kind'], detail: message['detail'] })
    if (!hook) {
      this.reply(socket, id, false, { error: 'invalid agent hook event' })
      return
    }
    record.hookWindowCount++
    const updatedAt = new Date(now).toISOString()
    const activity = record.run.activity === 'stopping' ? 'stopping' : hook.kind
    record.run = {
      ...record.run,
      activity,
      updatedAt,
      hook: {
        ...record.run.hook,
        connected: true,
        lastEventAt: updatedAt
      }
    }
    if (hook.detail) record.run.detail = hook.detail
    else delete record.run.detail
    this.publishAgent(record.run)
    this.reply(socket, id, true, {})
  }

  private nativeOwnsHistory(workspacePath: string, history: string): boolean {
    // Identity comes from the run's explicit launch executable, not from a
    // recorded `presetId`: the native open records no provider identity, so
    // reading one here would always be undefined and the ownership guard would
    // never fire, letting two sessions own one history.
    return [...this.agentsBySession.values()].some(({ run }) => run.workspacePath === workspacePath && agentProviderForExecutable(run.launch?.executable ?? '')?.id === 'opencode' && run.launch?.args.some((arg, index, args) => (arg === '--session' || arg === '-s') ? args[index + 1] === history : arg === '--session=' + history) && this.pty.liveness(run.sessionId) !== 'exited')
  }

  private async stopAgent(record: AgentRecord): Promise<RunningAgent> {
    if (record.run.liveness !== 'exited') {
      record.run = { ...record.run, activity: 'stopping', stopRequestedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      this.publishAgent(record.run)
    }
    await this.pty.stop(record.run.sessionId)
    return cloneRun(record.run)
  }

  /**
   * Opens a native PTY for one explicitly addressed local tool.
   *
   * This is not a provider launch and carries no provider authority: the caller
   * names an exact executable and its arguments, and the run records no driver
   * or instance identity. Provider identity is never inferred from an executable
   * name or a command string here. It exists for the dynamic-arity native flows
   * that cannot be an instance's static command spec — resuming an indexed
   * conversation (`omp --resume <file>`, `dsh --profile tui --resume <id>`) and
   * the ACP-to-native mode switch that resumes a protocol session.
   */
  private openNativeTerminal(
    cwd: string,
    requestedLaunch: AgentExecutable,
    cols: number,
    rows: number,
    task?: AgentTaskIntent,
    requestedEnv?: Record<string, string>
  ): { run: RunningAgent; session: TerminalSession } {
    const launch = parseAgentExecutable(requestedLaunch)
    const command = [launch.executable, ...launch.args].join(' ').trim()
    if (!command || command.includes('\0') || Buffer.byteLength(command) > MAX_AGENT_COMMAND_BYTES) {
      throw new Error('native terminal command is empty or invalid')
    }
    // Matching an exact executable to its hook adapter is not launch authority:
    // it only decides which provider's hooks to install. No identity is recorded.
    const provider = agentProviderForExecutable(launch.executable)
    const historyArg = launch.args.findIndex(arg => arg === '--session' || arg === '-s' || arg.startsWith('--session='))
    const history = historyArg < 0 ? undefined : launch.args[historyArg].startsWith('--session=') ? launch.args[historyArg].slice(10) : launch.args[historyArg + 1]
    // Two sessions must never own one OpenCode history: an unverifiable or live
    // owner refuses a second native open rather than racing it.
    if (provider?.id === 'opencode' && history && (this.acp.ownsHistory(cwd, history) || this.nativeOwnsHistory(cwd, history))) throw new Error('OpenCode history already has an active or unverifiable owner')
    const runId = randomUUID()
    const sessionId = randomUUID()
    const hookToken = newAuthToken()
    const binding: AgentHookBinding = {
      socketPath: this.paths.socketPath,
      runId,
      sessionId,
      token: hookToken
    }
    const launchPlan = createAgentLaunchPlan({
      command,
      launch,
      provider,
      binding,
      emitterCommand: this.emitterCommand,
      runtimeDir: this.paths.runtimeDir,
      inheritedEnv: process.env
    })
    // A session template's environment arrives from the trusted main client,
    // which resolved the template. The sanitized template is merged BEFORE the
    // hook-plan values so the daemon's authority keys (the hook socket, run
    // id, session id, and token) always win: a template can add variables but
    // can never retarget the hook channel or strip daemon authority.
    const env = { ...sanitizedTemplateEnvironment(requestedEnv), ...launchPlan.env }
    const now = new Date().toISOString()
    const run: RunningAgent = {
      ...(task ? { task: parseAgentTaskIntent(task) } : {}),
      launch: structuredClone(launch),
      id: runId,
      sessionId,
      workspacePath: cwd,
      command,
      startedAt: now,
      updatedAt: now,
      liveness: 'live',
      activity: 'starting',
      hook: {
        ...launchPlan.hookSupport,
        events: [...launchPlan.hookSupport.events],
        connected: false
      }
    }
    const record: AgentRecord = {
      run,
      hookToken,
      hookWindowStartedAt: Date.now(),
      hookWindowCount: 0,
      launchPlan
    }
    this.agentsBySession.set(sessionId, record)
    this.agentsByRun.set(runId, record)
    try {
      const session = this.pty.openAgent(cwd, launchPlan.command, cols, rows, {
        id: sessionId,
        env,
        launch: launchPlan.launch
      })
      this.sequence.set(session.id, 0)
      record.run = { ...record.run, activity: 'working', updatedAt: new Date().toISOString() }
      this.publishAgent(record.run)
      return { run: cloneRun(record.run), session }
    } catch (error) {
      this.agentsBySession.delete(sessionId)
      this.agentsByRun.delete(runId)
      launchPlan.cleanup()
      throw error
    }
  }

  private interruptAgent(record: AgentRecord): RunningAgent {
    if (record.run.liveness === 'exited') return cloneRun(record.run)
    if (!this.pty.has(record.run.sessionId)) {
      record.run = {
        ...record.run,
        liveness: 'unverifiable',
        updatedAt: new Date().toISOString()
      }
      this.publishAgent(record.run)
      throw new Error('agent process ownership is unverifiable')
    }
    this.pty.interrupt(record.run.sessionId)
    const stopRequestedAt = new Date().toISOString()
    record.run = {
      ...record.run,
      detail: 'Interrupt sent; the native process may remain open.',
      stopRequestedAt,
      updatedAt: stopRequestedAt
    }
    this.publishAgent(record.run)
    return cloneRun(record.run)
  }

  private async handleOp(socket: Socket, message: Record<string, unknown>): Promise<void> {
    const id = message['id']
    const op = String(message['op'] ?? '')
    const reply = (ok: boolean, result: Record<string, unknown>): void => this.reply(socket, id, ok, result)
    try {
      if (MAINTENANCE_OPS.has(op)) {
        void this.handleMaintenanceOp(socket, message).then(
          result => reply(true, result as Record<string, unknown>),
          error => reply(false, {
            error: error instanceof Error ? error.message : String(error),
            ...(error instanceof TaskAuthorityError ? { code: error.code } : {}),
            ...(error instanceof ProviderCatalogError ? { code: error.code } : {}),
            ...(error instanceof TaskAuthorityMigrationError ? { code: error.code } : {}),
            ...(error instanceof ProfileMaintenanceError ? { code: error.code } : {}),
            // A malformed gate input is a coded maintenance failure, not an
            // uncoded daemon error: callers branch on it like any other.
            ...(error instanceof ProfileMaintenanceValidationError ? { code: 'GATE_INPUT_INVALID', field: error.field } : {})
          })
        )
        return
      }
      switch (op) {
        case 'agent.switch.get':
          reply(true, { receipt: this.acp.switchResult(String(message['workspacePath']), String(message['requestId'])) })
          break
        case 'agent.switch': {
          const workspacePath = String(message['workspacePath']), sessionId = String(message['sessionId']), requestId = String(message['requestId'])
          const target = message['target']
          if (target !== 'native' && target !== 'acp') throw new Error('Invalid target mode')
          const executable = String(message['executable'])
          if (agentProviderForExecutable(executable)?.id !== 'opencode') throw new Error('Mode switching requires OpenCode')
          const servers = message['mcpServers']
          if (!Array.isArray(servers) || servers.length > 16) throw new Error('Invalid ACP MCP configuration')
          reply(true, { receipt: this.acp.switchMode(workspacePath, sessionId, requestId, target, message['context'] as string | undefined, async () => {
            if (target === 'native') {
              const prior = this.acp.observe(workspacePath, sessionId).snapshot
              if (!['ready', 'exited'].includes(prior.state) || !prior.protocolSessionId) throw new Error('Finish or stop the current ACP turn before switching')
              const stopped = await this.acp.control(workspacePath, sessionId, 'stop')
              if (this.identity.verify(stopped.processIdentity).status !== 'stale') throw new Error('ACP process stop could not be verified')
              return { native: this.openNativeTerminal(workspacePath, { executable, args: [workspacePath, '--session', prior.protocolSessionId] }, 100, 30) }
            }
            const native = this.agentsBySession.get(sessionId)
            if (!native || native.run.workspacePath !== workspacePath) throw new Error('Native session is not owned by this workspace')
            if (native.run.liveness !== 'exited' && !['waiting', 'completed'].includes(native.run.activity)) throw new Error('Finish or stop the current native turn before switching to a new ACP session')
            await this.stopAgent(native)
            if (this.pty.liveness(sessionId) !== 'exited') throw new Error('Native process stop could not be verified')
            return { acp: this.acp.start(workspacePath, randomUUID(), { executable, args: ['acp', '--cwd', workspacePath, '--hostname', '127.0.0.1', '--port', '0'] }, servers as McpServer[], undefined, message['context'] as string | undefined) }
          }) })
          break
        }
        case 'acp.open': {
          const servers = message['mcpServers']
          if (!Array.isArray(servers) || servers.length > 16) throw new Error('Invalid ACP MCP configuration')
          if (message['loadRunId']) {
            const prior = this.acp.observe(String(message['workspacePath']), String(message['loadRunId'])).snapshot
            if (prior.protocolSessionId && this.nativeOwnsHistory(prior.workspacePath, prior.protocolSessionId)) throw new Error('OpenCode history is owned by a native session')
          }
          reply(true, { snapshot: this.acp.start(String(message['workspacePath']), String(message['sessionId']), parseAgentExecutable(message['launch']), servers as McpServer[], message['loadRunId'] === undefined ? undefined : String(message['loadRunId'])) })
          break
        }
        case 'acp.list':
          reply(true, { sessions: this.acp.list(String(message['workspacePath'])) })
          break
        case 'acp.observe':
          reply(true, this.acp.observe(String(message['workspacePath']), String(message['sessionId']), Number(message['afterSequence'] ?? 0)))
          break
        case 'acp.prompt':
          reply(true, { request: this.acp.prompt(String(message['workspacePath']), String(message['sessionId']), String(message['requestId']), message['text'] as string) })
          break
        case 'acp.stop': case 'acp.cancel': case 'acp.permission': case 'acp.dismiss':
          reply(true, { snapshot: await this.acp.control(String(message['workspacePath']), String(message['sessionId']), op.slice(4) as 'stop' | 'cancel' | 'permission' | 'dismiss', message['permissionId'] as string | undefined, message['optionId'] as string | undefined) })
          break
        case 'attention.list':
          reply(true, { snapshot: this.attention.list() })
          break
        case 'attention.ack': {
          const request = parseAttentionAcknowledgeRequest({
            eventId: message['eventId'],
            eventVersion: message['eventVersion']
          })
          const result = this.attention.acknowledge(request)
          reply(true, result)
          break
        }
        case 'session.open': {
          const session = this.pty.open(String(message['cwd']), Number(message['cols'] ?? 100), Number(message['rows'] ?? 30))
          this.sequence.set(session.id, 0)
          reply(true, { session })
          break
        }
        case 'job.open': {
          const session = this.pty.openJob(
            String(message['cwd']),
            String(message['command'] ?? ''),
            Number(message['cols'] ?? 100),
            Number(message['rows'] ?? 30)
          )
          this.sequence.set(session.id, 0)
          reply(true, { session })
          break
        }
        case 'job.result': {
          const sessionId = String(message['sessionId'])
          reply(true, {
            ...this.pty.jobResult(sessionId),
            output: this.scrollback.get(sessionId) ?? '',
            truncated: this.truncated.has(sessionId),
            sequence: this.sequence.get(sessionId) ?? 0
          })
          break
        }
        case 'agent.native.open': {
          // An explicitly addressed local tool, not a provider launch: the caller
          // supplies the exact executable and argv, and no provider identity is
          // inferred or recorded. Used by the dynamic-arity native flows (resume
          // an indexed conversation, ACP-to-native switch) that cannot be an
          // instance's static command spec.
          const rawTask = message['task']
          const task = rawTask === undefined ? undefined : parseAgentTaskIntent(rawTask)
          if (task?.externalId !== undefined) throw new TaskAuthorityError('AUTHORIZATION_DENIED', 'task-linked native opens must use the task coordinator claim and launch-intent path')
          const rawEnv = message['env']
          if (rawEnv !== undefined && (typeof rawEnv !== 'object' || rawEnv === null || Array.isArray(rawEnv) || Object.entries(rawEnv).some(([key, value]) => key.length > 256 || key.includes('\0') || typeof value !== 'string' || value.length > 4096 || value.includes('\0')))) {
            throw new TaskAuthorityError('AUTHORIZATION_DENIED', 'invalid native-open environment')
          }
          const requestedEnv = rawEnv === undefined ? undefined : Object.fromEntries(Object.entries(rawEnv as Record<string, unknown>).map(([key, value]) => [key, String(value)]))
          const rawLaunch = message['launch']
          if (rawLaunch === undefined) throw new Error('native opens require an explicit launch')
          const result = this.openNativeTerminal(
            String(message['cwd']),
            parseAgentExecutable(rawLaunch),
            Number(message['cols'] ?? 100),
            Number(message['rows'] ?? 30),
            task,
            requestedEnv
          )
          reply(true, result)
          break
        }
        case 'agent.list':
          reply(true, { runs: [...this.agentsBySession.values()].map((record) => cloneRun(record.run)).concat([...this.providerRuns.values()].map(cloneRun)) })
          break
        case 'agent.providers':
          reply(true, { snapshot: this.providerCatalog.snapshot() })
          break
        case 'agent.providers.launch': {
          // The renderer names an instance; the daemon derives the worker
          // identity, lease, preparation, and admission itself. Nothing about a
          // credential, lease, or preparation crosses this boundary.
          const workspacePath = taskWireRequiredString(message['workspacePath'], 'workspacePath', 4096)
          const providerInstanceId = taskWireRequiredString(message['providerInstanceId'], 'providerInstanceId')
          const rawTask = message['task']
          const rawDriverArgs = message['driverArguments']
          const rawEnv = message['env']
          if (rawEnv !== undefined && (typeof rawEnv !== 'object' || rawEnv === null || Array.isArray(rawEnv) || Object.entries(rawEnv).some(([key, value]) => key.length > 256 || key.includes('\0') || typeof value !== 'string' || value.length > 4096 || value.includes('\0')))) {
            throw new TaskAuthorityError('AUTHORIZATION_DENIED', 'invalid provider-launch environment')
          }
          const requestedEnv = rawEnv === undefined ? undefined : Object.fromEntries(Object.entries(rawEnv as Record<string, unknown>).map(([key, value]) => [key, String(value)]))
          const run = await this.launchProviderInstance(
            socket,
            workspacePath,
            providerInstanceId,
            rawTask === undefined ? undefined : parseAgentTaskIntent(rawTask),
            Array.isArray(rawDriverArgs) ? rawDriverArgs.map(String) : undefined,
            requestedEnv
          )
          reply(true, { run })
          break
        }
        case 'agent.providers.create': {
          const input = parseProviderInstanceInput(message['input'])
          this.providerCatalog.create(input)
          reply(true, { snapshot: this.providerCatalog.snapshot() })
          break
        }
        case 'agent.providers.update': {
          // The transport reserves the envelope's `id` for request correlation,
          // so the instance is named by its own field.
          const instanceId = taskWireRequiredString(message['instanceId'], 'instanceId')
          const expectedRevision = taskWireEntityVersion(message['expectedRevision'], 'expectedRevision')
          const input = parseProviderInstanceInput({ ...(message['input'] as Record<string, unknown>), id: instanceId })
          this.providerCatalog.update(instanceId, expectedRevision, input)
          reply(true, { snapshot: this.providerCatalog.snapshot() })
          break
        }
        case 'agent.providers.remove': {
          const instanceId = taskWireRequiredString(message['instanceId'], 'instanceId')
          const expectedRevision = taskWireEntityVersion(message['expectedRevision'], 'expectedRevision')
          this.providerCatalog.remove(instanceId, expectedRevision)
          reply(true, { snapshot: this.providerCatalog.snapshot() })
          break
        }
        case 'agent.providers.default': {
          const instanceId = message['instanceId'] === null ? null : taskWireRequiredString(message['instanceId'], 'instanceId')
          const expectedRevision = taskWireEntityVersion(message['expectedRevision'], 'expectedRevision')
          reply(true, { snapshot: this.providerCatalog.setDefault(instanceId, expectedRevision) })
          break
        }
        case 'agent.providers.account.create': {
          const input = message['input']
          if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TaskAuthorityValidationError('input', 'must be an account object')
          const record = input as Record<string, unknown>
          if (Object.keys(record).some(key => key !== 'driverId' && key !== 'displayLabel')) throw new TaskAuthorityValidationError('input', 'contains an unknown field')
          const driverId = taskWireRequiredString(record['driverId'], 'input.driverId')
          const displayLabel = taskWireRequiredString(record['displayLabel'], 'input.displayLabel', 256)
          if (!isAgentDriverId(driverId)) throw new TaskAuthorityValidationError('input.driverId', 'must identify a known provider driver')
          this.providerCatalog.createAccount({ driverId, displayLabel })
          reply(true, { snapshot: this.providerCatalog.snapshot() })
          break
        }
        case 'agent.providers.account.update': {
          const input = message['input']
          if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TaskAuthorityValidationError('input', 'must be an account update object')
          const record = input as Record<string, unknown>
          if (Object.keys(record).some(key => key !== 'id' && key !== 'expectedRevision' && key !== 'displayLabel')) throw new TaskAuthorityValidationError('input', 'contains an unknown field')
          this.providerCatalog.updateAccount({ id: taskWireRequiredString(record['id'], 'input.id'), expectedRevision: taskWireEntityVersion(record['expectedRevision'], 'input.expectedRevision'), displayLabel: taskWireRequiredString(record['displayLabel'], 'input.displayLabel', 256) })
          reply(true, { snapshot: this.providerCatalog.snapshot() })
          break
        }
        case 'agent.providers.account.remove': {
          const input = message['input']
          if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TaskAuthorityValidationError('input', 'must be an account removal object')
          const record = input as Record<string, unknown>
          if (Object.keys(record).some(key => key !== 'id' && key !== 'expectedRevision')) throw new TaskAuthorityValidationError('input', 'contains an unknown field')
          this.providerCatalog.removeAccount({ id: taskWireRequiredString(record['id'], 'input.id'), expectedRevision: taskWireEntityVersion(record['expectedRevision'], 'input.expectedRevision') })
          reply(true, { snapshot: this.providerCatalog.snapshot() })
          break
        }
        // -- credential-operation saga surface -------------------------------
        // Trusted main orchestrates the saga because it owns credential
        // material, but the Catalog facts live here. These ops expose only the
        // saga's own steps over the authenticated daemon connection; they are
        // never reachable from renderer/runtime RPC, the CLI, or plugins, and a
        // sanitized projection never contains a ref or a generation.
        case 'provider.credential.scope': {
          const providerInstanceId = taskWireRequiredString(message['providerInstanceId'], 'providerInstanceId')
          const accountId = taskWireRequiredString(message['accountId'], 'accountId')
          reply(true, { scope: this.providerCatalog.credentialScope(providerInstanceId, accountId) })
          break
        }
        case 'provider.credential.binding': {
          const providerInstanceId = taskWireRequiredString(message['providerInstanceId'], 'providerInstanceId')
          const accountId = taskWireRequiredString(message['accountId'], 'accountId')
          reply(true, { binding: this.providerCatalog.credentialBinding(providerInstanceId, accountId) })
          break
        }
        case 'provider.credential.incomplete':
          reply(true, { operations: this.providerCatalog.incompleteCredentialOperations() })
          break
        case 'provider.credential.operation': {
          const operationId = taskWireRequiredString(message['operationId'], 'operationId')
          reply(true, { operation: this.providerCatalog.credentialOperation(operationId) })
          break
        }
        case 'provider.credential.stage-replace': {
          const input = message['input']
          if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TaskAuthorityValidationError('input', 'must be a credential intent')
          const record = input as Record<string, unknown>
          reply(true, { operation: this.providerCatalog.stageCredentialReplace({
            operationId: taskWireRequiredString(record['operationId'], 'input.operationId'),
            providerInstanceId: taskWireRequiredString(record['providerInstanceId'], 'input.providerInstanceId'),
            accountId: taskWireRequiredString(record['accountId'], 'input.accountId'),
            expectedInstanceRevision: taskWireEntityVersion(record['expectedInstanceRevision'], 'input.expectedInstanceRevision'),
            expectedAccountRevision: taskWireEntityVersion(record['expectedAccountRevision'], 'input.expectedAccountRevision'),
            stagedCredentialRef: taskWireRequiredString(record['stagedCredentialRef'], 'input.stagedCredentialRef', 512)
          }) })
          break
        }
        case 'provider.credential.bind': {
          const input = message['input']
          if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TaskAuthorityValidationError('input', 'must be a credential bind')
          const record = input as Record<string, unknown>
          const bound = this.providerCatalog.bindStagedCredential({
            operationId: taskWireRequiredString(record['operationId'], 'input.operationId'),
            providerInstanceId: taskWireRequiredString(record['providerInstanceId'], 'input.providerInstanceId'),
            accountId: taskWireRequiredString(record['accountId'], 'input.accountId'),
            expectedInstanceRevision: taskWireEntityVersion(record['expectedInstanceRevision'], 'input.expectedInstanceRevision'),
            expectedAccountRevision: taskWireEntityVersion(record['expectedAccountRevision'], 'input.expectedAccountRevision'),
            targetCredentialRef: taskWireRequiredString(record['targetCredentialRef'], 'input.targetCredentialRef', 512),
            targetBindingGeneration: taskWireInteger(record['targetBindingGeneration'], 'input.targetBindingGeneration', 1, Number.MAX_SAFE_INTEGER) ?? 1,
            expectedBindingGeneration: taskWireInteger(record['expectedBindingGeneration'], 'input.expectedBindingGeneration', 0, Number.MAX_SAFE_INTEGER) ?? 0
          })
          reply(true, { bound })
          break
        }
        case 'provider.credential.stage-revoke': {
          const input = message['input']
          if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TaskAuthorityValidationError('input', 'must be a credential revoke intent')
          const record = input as Record<string, unknown>
          reply(true, { operation: this.providerCatalog.stageCredentialRevoke({
            operationId: taskWireRequiredString(record['operationId'], 'input.operationId'),
            providerInstanceId: taskWireRequiredString(record['providerInstanceId'], 'input.providerInstanceId'),
            accountId: taskWireRequiredString(record['accountId'], 'input.accountId'),
            expectedInstanceRevision: taskWireEntityVersion(record['expectedInstanceRevision'], 'input.expectedInstanceRevision'),
            expectedAccountRevision: taskWireEntityVersion(record['expectedAccountRevision'], 'input.expectedAccountRevision')
          }) })
          break
        }
        case 'provider.credential.close': {
          const state = message['state']
          if (state !== 'pending' && state !== 'catalog-bound' && state !== 'complete' && state !== 'aborted') throw new TaskAuthorityValidationError('state', 'must be a known credential operation state')
          reply(true, { operation: this.providerCatalog.closeCredentialOperation({ operationId: taskWireRequiredString(message['operationId'], 'operationId'), state }) })
          break
        }
        case 'provider.credential.retire': {
          const input = message['input']
          if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TaskAuthorityValidationError('input', 'must be a credential retirement')
          const record = input as Record<string, unknown>
          this.providerCatalog.retireCredentialBindingForOperation({
            providerInstanceId: taskWireRequiredString(record['providerInstanceId'], 'input.providerInstanceId'),
            accountId: taskWireRequiredString(record['accountId'], 'input.accountId'),
            expectedInstanceRevision: taskWireEntityVersion(record['expectedInstanceRevision'], 'input.expectedInstanceRevision'),
            expectedAccountRevision: taskWireEntityVersion(record['expectedAccountRevision'], 'input.expectedAccountRevision'),
            expectedBindingGeneration: taskWireInteger(record['expectedBindingGeneration'], 'input.expectedBindingGeneration', 1, Number.MAX_SAFE_INTEGER) ?? 1,
            credentialOperationId: taskWireRequiredString(record['credentialOperationId'], 'input.credentialOperationId')
          })
          // The projection is carried on the wire so both the in-process and the
          // wire-seam form of this call report the same retired binding.
          reply(true, { snapshot: this.providerCatalog.snapshot() })
          break
        }
        case 'agent.authenticate': {
          const binding = this.authenticateHook(message)
          if (binding && this.pty.liveness(binding.record.run.sessionId) === 'live') reply(true, { run: cloneRun(binding.record.run) })
          else {
            const run = this.acp.authenticate(String(message['runId'] ?? ''), String(message['sessionId'] ?? ''), typeof message['hookToken'] === 'string' ? message['hookToken'] : '')
            if (!run) throw new Error('Invalid agent session credential')
            reply(true, { run })
          }
          break
        }
        case 'agent.get': {
          const sessionId = String(message['sessionId'])
          const record = this.agentsBySession.get(sessionId)
          if (record) { reply(true, { run: cloneRun(record.run) }); break }
          const provider = this.providerRuns.get(sessionId)
          if (!provider) throw new Error('unknown agent session')
          reply(true, { run: cloneRun(provider) })
          break
        }
        case 'agent.write': {
          const sessionId = String(message['sessionId'])
          // A provider child is a PTY the daemon owns, so input reaches it the
          // same way; only the bookkeeping differs, since provider runs have no
          // AgentRecord.
          const provider = this.providerRuns.get(sessionId)
          if (provider) {
            const ownerLiveness = this.pty.liveness(sessionId)
            if (provider.liveness !== 'live' || ownerLiveness !== 'live') {
              throw new Error('agent input rejected because process liveness is ' + ownerLiveness)
            }
            const data = message['data']
            if (typeof data !== 'string' || data.length === 0) throw new Error('agent input must be a non-empty string')
            this.pty.writeAgent(sessionId, data)
            reply(true, {})
            break
          }
          const record = this.agentsBySession.get(sessionId)
          if (!record) throw new Error('unknown agent session')
          if (this.acp.isSwitching(sessionId)) throw new Error('Agent is switching modes')
          const ownerLiveness = this.pty.liveness(sessionId)
          if (record.run.liveness !== 'live' || ownerLiveness !== 'live') {
            throw new Error('agent input rejected because process liveness is ' + ownerLiveness)
          }
          if (record.run.activity !== 'working' && record.run.activity !== 'waiting') {
            throw new Error('agent input rejected while agent activity is ' + record.run.activity)
          }
          const data = message['data']
          if (typeof data !== 'string' || data.length === 0) {
            throw new Error('agent input must be a non-empty string')
          }
          this.pty.writeAgent(sessionId, data)
          reply(true, {})
          break
        }
        case 'agent.stop': {
          const sessionId = String(message['sessionId'])
          const provider = this.providerRuns.get(sessionId)
          if (provider) { reply(true, { run: await this.stopProviderRun(sessionId, provider) }); break }
          const record = this.agentsBySession.get(sessionId)
          if (!record) throw new Error('unknown agent session')
          reply(true, { run: await this.stopAgent(record) })
          break
        }
        case 'agent.interrupt': {
          const sessionId = String(message['sessionId'])
          const provider = this.providerRuns.get(sessionId)
          if (provider) { reply(true, { run: this.interruptProviderRun(sessionId, provider) }); break }
          const record = this.agentsBySession.get(sessionId)
          if (!record) throw new Error('unknown agent session')
          reply(true, { run: this.interruptAgent(record) })
          break
        }
        case 'agent.dismiss': {
          const sessionId = String(message['sessionId'])
          const provider = this.providerRuns.get(sessionId)
          if (provider) {
            if (provider.liveness !== 'exited' || this.pty.liveness(sessionId) !== 'exited') {
              throw new Error('agent session is still live or unverifiable and cannot be dismissed')
            }
            await this.dismissProviderRun(sessionId)
            reply(true, {})
            break
          }
          const record = this.agentsBySession.get(sessionId)
          if (!record) throw new Error('unknown agent session')
          if (record.run.liveness !== 'exited' || this.pty.liveness(sessionId) !== 'exited') {
            throw new Error('agent session is still live or unverifiable and cannot be dismissed')
          }
          this.pty.dismissExited(sessionId)
          this.agentsBySession.delete(sessionId)
          this.agentsByRun.delete(record.run.id)
          record.launchPlan.cleanup()
          this.scrollback.delete(sessionId); this.replay.delete(sessionId)
          this.truncated.delete(sessionId)
          this.sequence.delete(sessionId)
          this.broadcast({ event: 'agent-dismissed', sessionId })
          reply(true, {})
          break
        }
        case 'session.write':
          this.pty.write(String(message['sessionId']), String(message['data'] ?? ''))
          reply(true, {})
          break
        case 'session.resize':
          this.pty.resize(String(message['sessionId']), Number(message['cols'] ?? 100), Number(message['rows'] ?? 30))
          reply(true, {})
          break
        case 'session.interrupt': {
          const sessionId = String(message['sessionId'])
          const agent = this.agentsBySession.get(sessionId)
          if (agent) this.interruptAgent(agent)
          else this.pty.interrupt(sessionId)
          reply(true, {})
          break
        }
        case 'session.close': {
          const sessionId = String(message['sessionId'])
          if (this.agentsBySession.has(sessionId)) {
            throw new Error('agent sessions require interrupt followed by dismiss after confirmed exit')
          }
          // A provider session's lifecycle pump owns its retained state and reads
          // its settled exit; closing the session underneath it would record a
          // clean exit as a failure with its trailing output dropped. A run that
          // is still live, or whose exit is not yet settled, must go through
          // `agent.stop` and then `agent.dismiss`. An exited one is dismissed
          // here, which is the same teardown: it joins the pump before releasing
          // anything the pump still reads.
          const provider = this.providerRuns.get(sessionId)
          if (provider) {
            if (provider.liveness !== 'exited' || this.pty.liveness(sessionId) !== 'exited') {
              throw new Error('provider sessions require agent.stop followed by agent.dismiss after confirmed exit')
            }
            await this.dismissProviderRun(sessionId)
            reply(true, {})
            break
          }
          await this.pty.close(sessionId)
          this.scrollback.delete(sessionId); this.replay.delete(sessionId)
          this.truncated.delete(sessionId)
          this.sequence.delete(sessionId)
          reply(true, {})
          break
        }
        case 'session.list':
          reply(true, { sessions: this.pty.list() })
          break
        case 'session.attach': {
          const sessionId = String(message['sessionId'])
          const session = this.pty.list().find((candidate) => candidate.id === sessionId)
          if (!session) {
            reply(false, { error: `unknown session: ${sessionId}` })
            break
          }
          let offset = 0
          reply(true, {
            session,
            scrollback: this.scrollback.get(sessionId) ?? '',
            replay: (this.replay.get(sessionId) ?? []).map(({ data, ...grid }) => {
              const result = { ...grid, offset }; offset += data.length; return result
            }),
            truncated: this.truncated.has(sessionId),
            sequence: this.sequence.get(sessionId) ?? 0
          })
          break
        }
        case 'daemon.status':
          reply(true, {
            pid: process.pid,
            idle: !this.hasOwnedSessions(),
            sessionCount: this.pty.list().length,
            liveSessionCount: this.pty.list().filter((session) => !session.exited).length
          })
          break
        case 'daemon.shutdown':
          if (this.hasOwnedSessions()) {
            reply(false, { error: 'terminal daemon owns sessions and refuses shutdown' })
            break
          }
          reply(true, { stopped: true })
          setImmediate(() => void this.stopIfIdle())
          break
        case 'task.credential.issue':
        case 'task.query':
        case 'task.create':
        case 'task.update':
        case 'task.dependencies.set':
        case 'task.schedule.create':
        case 'task.schedule.update':
        case 'task.schedule.duplicate':
        case 'task.schedule.delete':
        case 'task.schedule.execution.enqueue':
        case 'task.schedule.executions.list':
        case 'task.schedule.list':
        case 'task.run-group.list':
        case 'task.schedule.execution.cancel':
        case 'task.run-group.create':
        case 'task.run-group.cancel':
        case 'task.run-group.delete':
        case 'task.run-group.retry':
        case 'task.cancel':
        case 'task.retry':
        case 'task.adopt-artifact':
        case 'task.claim':
        case 'task.write':
        case 'task.handoff.offer':
        case 'task.handoff.cancel':
        case 'task.handoff.accept':
        case 'task.takeover':
        case 'task.mailbox.append':
        case 'task.mailbox.acknowledge':
          reply(true, this.handleTaskOp(socket, message))
          break
        case 'ping':
          reply(true, { pong: Date.now() })
          break
        default:
          reply(false, { error: `unknown op: ${op}` })
      }
    } catch (error) {
      reply(false, {
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof TaskAuthorityError ? { code: error.code } : {}),
        ...(error instanceof ProviderCatalogError ? { code: error.code } : {})
      })
    }
  }

  // -- task authority command surface -----------------------------------------
  // Every mutation routes through the single in-process Task Authority.
  // Worker identity always comes from a daemon-issued per-session credential
  // bound to the authenticated connection; the profile-global runtime token
  // never upgrades itself into worker authority.

  private taskConnectionKey(socket: Socket): string {
    const key = this.taskConnections.get(socket)
    if (key === undefined) throw new TaskAuthorityError('AUTHORIZATION_DENIED', 'task commands require an authenticated daemon connection')
    return key
  }

  private taskAdminConnection(socket: Socket): AuthenticatedAuthorityConnection {
    return { connectionId: this.taskConnectionKey(socket), role: 'administrator' }
  }

  private daemonWorkerOwnerId(): string {
    return this.publication?.owner.ownerId ?? '00000000-0000-4000-8000-000000000000'
  }

  /**
   * Verifies that the registering process is the current application owner: the
   * Stage 1 ownership row for `donwells-app` must be active, its recorded
   * identity must be exactly the presented one, and Runtime Identity must still
   * observe that live process. A second process therefore cannot claim the
   * broker by presenting a plausible-looking identity.
   */
  private verifiesAppOwner(identity: ProcessIdentity): boolean {
    const paths = localRuntimePaths(dirname(this.paths.runtimeDir), 'app')
    let store: RuntimeOwnershipStore | null = null
    try {
      store = new RuntimeOwnershipStore(paths.ownershipDatabasePath, { readOnly: true })
      const observed = store.observe('donwells-app')
      if (observed.status !== 'present' || observed.owner.state !== 'active') return false
      if (observed.owner.identity.family !== 'donwells-app') return false
      if (JSON.stringify(observed.owner.identity) !== JSON.stringify(identity)) return false
      return this.identity.verify(identity).status === 'valid'
    } catch {
      return false
    } finally {
      store?.close()
    }
  }

  /**
   * The dedicated broker op surface. Secret-bearing responses are reachable
   * only here, never through `handleOp`'s ordinary command dispatch, so
   * `DaemonClient.call`, renderer/runtime RPC, CLI, plugins, event replay, and
   * debug serializers cannot obtain one.
   */
  private handleBrokerOp(socket: Socket, message: Record<string, unknown>): void {
    const op = message['op']
    try {
      if (op === SECRET_BROKER_REGISTER_OP) {
        const registration = this.secretBroker.register(socket, ProviderSecretBrokerHost.parseIdentity(message['identity']))
        this.reply(socket, message['id'], true, { epoch: registration.epoch, deadlineMs: registration.deadlineMs })
        return
      }
      if (op === SECRET_BROKER_RESPOND_OP) {
        this.secretBroker.respond(socket, message)
        this.reply(socket, message['id'], true, {})
        return
      }
      this.reply(socket, message['id'], false, { error: 'unknown broker op: ' + String(op) })
    } catch (error) {
      this.reply(socket, message['id'], false, {
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof SecretBrokerError ? { code: error.code } : {})
      })
    }
  }

  /** One materialization round trip; the caller is the trusted launch path. */
  materializeProviderLaunch(authorization: ProviderLaunchAuthorization): Promise<ProviderLaunchSecrets> {
    return this.secretBroker.materialize(authorization)
  }

  /**
   * Starts one interactive agent from a selected provider instance.
   *
   * This is the production provider-backed launch. The renderer names an
   * instance; it never sees a lease, preparation, broker frame, credential ref,
   * or maintenance admission. The daemon derives the authenticated worker
   * identity and the full lease itself:
   *
   *   resolve project → create the launch's own task → claim it with the exact
   *   selection → prepare the Catalog launch → admit it (which consumes the
   *   preparation in one transaction) → run the coordinator's provider path.
   *
   * A caller-resolved session-template environment may accompany the launch; it
   * is validated at the wire boundary and merged by the coordinator after the
   * hook and credential values.
   */
  private async launchProviderInstance(socket: Socket, workspacePath: string, providerInstanceId: string, task?: AgentTaskIntent, driverArgs?: readonly string[], requestedEnv?: Record<string, string>): Promise<RunningAgent> {
    // An interactive launch mints its own task, so it cannot adopt a caller's
    // task reference. Silently dropping one would start an agent the user
    // believes is linked to a daemon task, so this refuses instead — the same
    // invariant the command path enforced with TaskLinkedAgentOpenError.
    if (task?.externalId !== undefined) {
      throw new TaskAuthorityError('AUTHORIZATION_DENIED', 'a task-linked launch must use the task coordinator claim and launch-intent path; it cannot be started as an interactive session')
    }
    // Driver-owned arguments (the project-memory MCP patch) come from the trusted
    // main process, never from the renderer: the renderer names an instance and
    // nothing else. They are applied only to a `driver` command, and only after
    // this daemon has bounded them, so they cannot become an argv channel.
    if (driverArgs !== undefined) {
      if (!Array.isArray(driverArgs) || driverArgs.length > 32 || driverArgs.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) {
        throw new TaskAuthorityError('AUTHORIZATION_DENIED', 'invalid driver arguments')
      }
    }
    const snapshot = this.providerCatalog.snapshot()
    const instance = snapshot.instances.find(candidate => candidate.id === providerInstanceId)
    if (!instance) throw new ProviderCatalogError('INSTANCE_NOT_FOUND', 'the selected provider instance no longer exists')
    if (!instance.enabled) throw new ProviderCatalogError('INSTANCE_DISABLED', 'the selected provider instance is disabled')
    if (instance.availability !== 'available') throw new ProviderCatalogError('DRIVER_UNAVAILABLE', 'the selected provider instance is unavailable')

    const canonicalWorkspace = realpathSync.native(workspacePath)
    const project = this.projectRegistry
      ? (await this.projectRegistry()).find(candidate => realpathSync.native(candidate.workspaceRoot) === canonicalWorkspace)
      : await resolveInteractiveWorkspace(this.userDataDir, canonicalWorkspace)
    if (!project) throw new TaskAuthorityError('AUTHORIZATION_DENIED', 'the workspace is not a registered project')
    const projectId = project.projectId

    const selection: ProviderSelection = {
      driverId: (instance.driver.kind === 'known' ? instance.driver.id : 'custom-command'),
      providerInstanceId: instance.id,
      instanceRevision: instance.revision,
      accountId: instance.account?.id ?? null,
      accountRevision: instance.account?.revision ?? null
    }

    // The launch's own task: an interactive run is still an admitted attempt, so
    // the immutable selection and the launch admission have a durable owner.
    const connection = this.daemonWorkerConnection(projectId)
    const externalTaskId = `interactive-${randomUUID()}`
    this.taskAuthority.createTask({
      connection: this.taskAdminConnection(socket),
      projectId,
      ...(project.repositoryId === undefined ? {} : { repositoryId: project.repositoryId }),
      workspaceRoot: canonicalWorkspace,
      externalTaskId,
      title: `Interactive agent (${instance.displayName})`
    })
    const specification: TaskExecutionSpecificationInput = {
      command: { program: instance.displayName, args: [], cwd: canonicalWorkspace },
      target: { kind: 'local', root: canonicalWorkspace, label: project.repositoryId },
      verification: { requiredArtifacts: [] }
    }
    const claim = this.taskAuthority.claim({ connection, projectId, externalTaskId, specification, providerSelection: selection })

    const sessionId = randomUUID()
    const outcome = await this.taskCoordinator.launchProviderBacked({
      lease: claim.token,
      attemptId: claim.attempt.attemptId,
      sessionId,
      workspaceRoot: canonicalWorkspace,
      ...(driverArgs === undefined ? {} : { driverArguments: driverArgs }),
      ...(requestedEnv === undefined ? {} : { requestedEnvironment: requestedEnv }),
      selection,
      connection,
      // An interactive agent outlives the launch call.
      interactive: true,
      ...(task === undefined ? {} : { task })
    })
    if (outcome.disposition !== 'launched' || outcome.sessionId === null) {
      throw new TaskAuthorityError('AUTHORIZATION_DENIED', outcome.reason ?? 'the provider-backed launch was refused')
    }
    const run = this.providerRuns.get(outcome.sessionId)
    if (!run) throw new TaskAuthorityError('AUTHORIZATION_DENIED', 'the provider launch produced no run record')
    // Retain the pump so dismissal can join it before releasing the child's
    // PTY state and scrollback.
    if (outcome.completion !== undefined) this.providerPumps.set(outcome.sessionId, outcome.completion)
    return cloneRun(run)
  }

  private daemonWorkerConnection(projectId: string): AuthenticatedAuthorityConnection {
    return { connectionId: 'daemon-worker', role: 'worker', ownerId: this.daemonWorkerOwnerId(), authorizedProjectIds: [projectId] }
  }

  private issueTaskWorkerCredential(socket: Socket, message: Record<string, unknown>): Record<string, unknown> {
    const projectId = taskWireRequiredString(message['projectId'], 'projectId')
    const credentialId = randomUUID()
    const token = newAuthToken()
    const ownerId = randomUUID()
    this.taskWorkerCredentials.set(credentialId, { token, ownerId, connectionKey: this.taskConnectionKey(socket), projectIds: [projectId] })
    return { credentialId, ownerId, token }
  }

  private bindTaskWorker(socket: Socket, message: Record<string, unknown>, projectId: string): AuthenticatedAuthorityConnection {
    const rawCredential = message['credential']
    if (typeof rawCredential !== 'object' || rawCredential === null || Array.isArray(rawCredential)) {
      throw new TaskAuthorityError('AUTHORIZATION_DENIED', 'a daemon-issued task worker credential is required')
    }
    const credential = rawCredential as Record<string, unknown>
    const credentialId = taskWireUuid(credential['credentialId'], 'credential.credentialId')
    const token = taskWireRequiredString(credential['token'], 'credential.token', 256)
    const binding = this.taskWorkerCredentials.get(credentialId)
    if (!binding || !sameToken(binding.token, token)) {
      throw new TaskAuthorityError('AUTHORIZATION_DENIED', 'task worker credential is missing, stale, or invalid')
    }
    if (binding.connectionKey !== this.taskConnectionKey(socket)) {
      throw new TaskAuthorityError('AUTHORIZATION_DENIED', 'task worker credential belongs to a different authenticated session')
    }
    if (!binding.projectIds.includes(projectId)) {
      throw new TaskAuthorityError('PROJECT_SCOPE_MISMATCH', 'task worker credential is not authorized for this project')
    }
    return { connectionId: credentialId, role: 'worker', ownerId: binding.ownerId, authorizedProjectIds: [projectId] }
  }

  private launchClaimedTask(claim: ClaimResult, specification: TaskExecutionSpecificationInput, runtime: TaskChildRuntime, connection: AuthenticatedAuthorityConnection): void {
    void this.taskCoordinator.launch(claim, specification, connection, runtime).catch(error => {
      logger.warn({ err: error, taskId: claim.task.taskId, attemptId: claim.attempt.attemptId }, 'task launch coordination failed')
    })
  }

  private resumeClaimedTask(claim: ClaimResult, connection: AuthenticatedAuthorityConnection): void {
    try {
      const specification = this.taskAuthority.readExecutionSpecification(claim.task.projectId, claim.attempt.specificationId)
      this.launchClaimedTask(claim, specification, 'finite-job', connection)
    } catch (error) {
      logger.warn({ err: error, taskId: claim.task.taskId }, 'task resume after transfer failed')
    }
  }

  /**
   * Resolves the durable gate phase before affected handlers exist.
   *
   * `open` starts affected work normally, a leased phase keeps admissions
   * frozen (the coordinator owns the resume), and `failed` refuses to register
   * any launch or scheduler handler until an authenticated migration
   * coordinator authorizes a resume or abort.
   */
  private resolveMaintenancePhaseAtStartup(): void {
    const state = this.maintenanceGate.readState()
    if (state.phase === 'failed') {
      throw new TaskAuthorityError('MIGRATION_REQUIRED', `profile maintenance is failed (${state.failureCode ?? 'unknown'}); an authorized migration coordinator must resume or abort before affected work restarts`)
    }
    if (state.phase !== 'open') {
      logger.warn({ phase: state.phase, migrationId: state.lease?.migrationId ?? null }, 'profile maintenance lease is held; affected admissions stay frozen')
    }
  }

  /**
   * Runs the one-time legacy `agentCommand` → provider-instance cutover.
   *
   * The app process resolves the legacy command; the daemon owns the Catalog and
   * the gate, so the migration is driven here, under the same durable lease as
   * the Stage 2 task authority. A completed migration is a pure no-op, and an
   * interrupted cutover resumes its own lease rather than starting a new one.
   */
  private async runProviderMaintenanceMigration(): Promise<void> {
    const commands = await this.legacyAgentCommand()
    if (commands.length === 0 && this.providerCatalog.completedMigration() === null) {
      // Nothing to migrate and no committed migration: a profile that never set
      // a legacy command must not acquire an empty lease or a spurious default.
      return
    }
    const result = await this.providerMaintenanceMigration.migrate({ commands })
    logger.info({ instances: result.instanceIds, defaultInstanceId: result.defaultInstanceId }, 'provider-authority:startup-migrated')
  }

  private async reconcileTaskAuthority(): Promise<void> {
    const events = await this.taskCoordinator.reconcileStartup(identity => this.identity.verify(identity))
    for (const event of events) logger.info({ taskAuthority: event }, 'task-authority:startup-reconciled')
  }

  /**
   * One scheduler tick, fenced by a durable admission.
   *
   * Enqueuing a due occurrence and claiming a task both mutate authority state
   * that a migration may be about to freeze, so the tick registers an affected
   * admission first. While the gate is open the admission is skipped entirely,
   * so ordinary operation pays no extra database work.
   */
  private async runTaskSchedulerTick(): Promise<void> {
    const pump = this.taskSchedulerPump
    if (!pump) return
    const admission = await this.admitDaemonWork('task-authority', `scheduler-tick:${Date.now()}`)
    let outcome: 'completed' | 'cancelled' = 'completed'
    try {
      const result = pump.tick()
      for (const failure of result.failures) logger.warn({ scope: failure.scope, error: failure.error }, 'task scheduler tick rejected one enqueue or claim')
      for (const entry of result.claimed) {
        this.launchClaimedTask(entry.claim, entry.specification, 'finite-job', this.daemonWorkerConnection(entry.claim.task.projectId))
      }
    } catch (error) {
      outcome = 'cancelled'
      throw error
    } finally {
      await this.completeDaemonWork(admission, 'task-authority', outcome)
    }
  }

  /** Fire-and-forget tick for timers: a rejected tick is logged, never fatal. */
  private scheduleTaskSchedulerTick(): void {
    void this.runTaskSchedulerTick().catch(error => logger.warn({ err: error }, 'task scheduler tick failed'))
  }

  // -- profile maintenance gate -----------------------------------------------
  // The gate persists one profile-wide migration lease, its epoch/revision,
  // the frozen participant set, acknowledgements, bounded ordinary admissions,
  // and migration-transition receipts. Startup resolves the persisted phase
  // before any affected handler registers.

  /**
   * Authenticated connection identity for ordinary affected work.
   *
   * A participant-bound context is created only when the daemon authenticated
   * that exact connection as a maintenance participant; nothing here decodes a
   * participant name from the request body.
   */
  private maintenanceCaller(socket: Socket): { connectionId: string; participant?: ProfileMaintenanceParticipant } {
    return { connectionId: this.taskConnectionKey(socket) }
  }

  /**
   * Daemon-internal admission for the daemon's own affected work (scheduler
   * ticks, launches). Returns null when the profile has no migration in flight,
   * so ordinary operation pays no extra work.
   */
  private async admitDaemonWork(participant: ProfileMaintenanceParticipant, operationId: string): Promise<string | null> {
    const state = this.maintenanceGate.readState()
    if (state.phase === 'open') return null
    const admission = await this.maintenanceGate.admit({ connectionId: 'daemon-internal' }, participant, operationId)
    return admission.operationId
  }

  private async completeDaemonWork(operationId: string | null, participant: ProfileMaintenanceParticipant, outcome: 'completed' | 'cancelled'): Promise<void> {
    if (operationId === null) return
    await this.maintenanceGate.complete({ connectionId: 'daemon-internal' }, {
      participant,
      operationId,
      epoch: this.maintenanceGate.readState().lease?.epoch ?? 1,
      ownerConnectionId: 'daemon-internal'
    }, outcome)
  }

  /**
   * Migration-owner context: daemon-created for the authenticated connection
   * that names the owner stage. Renderer, CLI, plugin, worker, and participant
   * callers cannot author one, because every admin op below re-validates the
   * stage against the persisted lease inside the gate.
   */
  private migrationCaller(socket: Socket, message: Record<string, unknown>): AuthenticatedProfileMaintenanceMigrationContext {
    return {
      connectionId: this.taskConnectionKey(socket),
      ownerStage: parseProfileMaintenanceOwnerStage(message['ownerStage'], 'ownerStage')
    }
  }

  /**
   * Completes an accepted abort: discards every candidate-only imported row and
   * returns the migration to the legacy state.
   *
   * This runs after the gate's abort transaction commits, so a failure here is
   * reported rather than silently swallowed — the lease is already released and
   * the operator must know the residue removal did not finish.
   */
  private discardAbortedMigration(migrationId: string): void {
    try {
      this.migration.abort(migrationId)
    } catch (error) {
      logger.error({ err: error, migrationId }, 'profile maintenance abort could not discard candidate rows')
      throw error
    }
  }

  /**
   * Dispatches one maintenance or migration command.
   *
   * Principal contexts are built lazily inside the op that needs them: most
   * commands carry neither a participant nor an owner stage, so eagerly parsing
   * both would reject the majority of valid calls before their handler runs.
   */
  private async handleMaintenanceOp(socket: Socket, message: Record<string, unknown>): Promise<unknown> {
    const op = String(message['op'] ?? '')
    const caller = (): AuthenticatedProfileMaintenanceMigrationContext => this.migrationCaller(socket, message)
    const participantCaller = (): AuthenticatedProfileMaintenanceParticipantContext => ({
      connectionId: this.taskConnectionKey(socket),
      participant: parseProfileMaintenanceParticipant(message['participant'], 'participant')
    })
    switch (op) {
      case 'maintenance.state':
        return { state: this.maintenanceGate.readState() }
      case 'task.migration.status':
        return { status: this.migration.status() }
      case 'task.migration.import':
        return { result: await this.migration.prepare() }
      case 'task.migration.shadow':
        return { report: await this.migration.shadow() }
      case 'task.migration.export': {
        const repositoryId = taskWireRequiredString(message['repositoryId'], 'repositoryId')
        return { export: this.migration.exportBacklog(repositoryId) }
      }
      case 'maintenance.admit.affected': {
        // The daemon maps the authenticated connection's operation onto the
        // participant that owns it; the caller never supplies a participant.
        const operationId = taskWireRequiredString(message['operationId'], 'operationId')
        return { admission: await this.maintenanceGate.admit(this.maintenanceCaller(socket), 'task-authority', operationId) }
      }
      case 'maintenance.complete.affected': {
        // The epoch comes from the persisted admission, never from the caller:
        // a client cannot close work it admitted under a superseded epoch.
        const operationId = taskWireRequiredString(message['operationId'], 'operationId')
        const outcome = message['outcome'] === 'cancelled' ? 'cancelled' as const : 'completed' as const
        const epoch = this.maintenanceGate.admissionEpoch('task-authority', operationId)
        await this.maintenanceGate.complete(this.maintenanceCaller(socket), {
          participant: 'task-authority',
          operationId,
          epoch,
          ownerConnectionId: this.taskConnectionKey(socket)
        }, outcome)
        return { completed: true }
      }
      case 'maintenance.acquire':
        return {
          lease: await this.maintenanceGate.acquire({
            connectionId: this.taskConnectionKey(socket),
            ownerStage: parseProfileMaintenanceOwnerStage(message['ownerStage'], 'ownerStage')
          }, {
            migrationId: taskWireRequiredString(message['migrationId'], 'migrationId'),
            ownerStage: parseProfileMaintenanceOwnerStage(message['ownerStage'], 'ownerStage'),
            participants: parseProfileMaintenanceParticipantSet(message['participants']),
            expectedRevision: taskWireInteger(message['expectedRevision'], 'expectedRevision', 1, Number.MAX_SAFE_INTEGER) ?? 1
          })
        }
      case 'maintenance.freeze': {
        await this.maintenanceGate.freeze(caller(), parseProfileMaintenanceLease(message['lease']))
        return { frozen: true }
      }
      case 'maintenance.drained': {
        await this.maintenanceGate.acknowledgeDrained(participantCaller(), taskWireRequiredString(message['migrationId'], 'migrationId'))
        return { acknowledged: true }
      }
      case 'maintenance.cutover': {
        await this.maintenanceGate.beginCutover(caller(), parseProfileMaintenanceLease(message['lease']))
        return { cutover: true }
      }
      case 'maintenance.transition.prepare':
        return { receipt: await this.maintenanceGate.prepareMigrationTransition(caller(), parseProfileMaintenanceLease(message['lease']), parseProfileMaintenanceTransitionIntent(message['intent'])) }
      case 'maintenance.transition.complete':
        return { receipt: await this.maintenanceGate.completeMigrationTransition(caller(), parseProfileMaintenanceReceipt(message['receipt']), taskWireRequiredString(message['evidenceSha256'], 'evidenceSha256')) }
      case 'maintenance.transition.visibility':
        return { receipt: await this.maintenanceGate.acknowledgeExternalVisibility(caller(), parseProfileMaintenanceReceipt(message['receipt']), {
          expectedRevision: taskWireInteger(message['expectedRevision'], 'expectedRevision', 1, Number.MAX_SAFE_INTEGER) ?? 1,
          localVisibleRevision: taskWireRequiredString(message['localVisibleRevision'], 'localVisibleRevision'),
          localVisibleEvidenceSha256: taskWireRequiredString(message['localVisibleEvidenceSha256'], 'localVisibleEvidenceSha256')
        }) }
      case 'maintenance.transitions':
        return { receipts: await this.maintenanceGate.listMigrationTransitions(caller(), parseProfileMaintenanceLease(message['lease'])) }
      case 'maintenance.fence':
        return { receipt: await this.maintenanceGate.recordRetirementFence(caller(), parseProfileMaintenanceLease(message['lease']), parseProfileMaintenanceRetirement(message['retirement'])) }
      case 'maintenance.fail':
        return { lease: await this.maintenanceGate.fail(caller(), parseProfileMaintenanceLease(message['lease']), parseProfileMaintenanceFailure(message['failure'])) }
      case 'maintenance.resume':
        return { lease: await this.maintenanceGate.resume(caller(), parseProfileMaintenanceResumeInput(message['input'])) }
      case 'maintenance.abort': {
        await this.maintenanceGate.abort(caller(), parseProfileMaintenanceAbortInput(message['input']))
        return { aborted: true }
      }
      case 'maintenance.release': {
        await this.maintenanceGate.release(caller(), parseProfileMaintenanceLease(message['lease']), 'active')
        return { released: true }
      }
      default:
        throw new TaskAuthorityError('DAEMON_UPGRADE_REQUIRED', `unknown maintenance op: ${op}`)
    }
  }

  private handleTaskOp(socket: Socket, message: Record<string, unknown>): Record<string, unknown> {
    const op = String(message['op'] ?? '')
    if (!WORKER_TASK_OPS.has(op) && message['credential'] !== undefined) {
      throw new TaskAuthorityError('AUTHORIZATION_DENIED', 'administrator task commands do not accept a worker credential')
    }
    switch (op) {
      case 'task.credential.issue':
        return { credential: this.issueTaskWorkerCredential(socket, message) }
      case 'task.query': {
        const status = taskWireString(message['status'], 'status', 32)
        if (status !== undefined && !TASK_STATUSES.includes(status as TaskStatus)) {
          throw new TaskAuthorityValidationError('status', 'must be a known task status')
        }
        const limit = taskWireInteger(message['limit'], 'limit', 1, TASK_AUTHORITY_MAX_PAGE)
        const runnableOnly = taskWireBoolean(message['runnableOnly'], 'runnableOnly')
        const cursor = taskWireString(message['cursor'], 'cursor')
        const projectId = taskWireString(message['projectId'], 'projectId')
        return this.taskAuthority.query({
          connection: this.taskAdminConnection(socket),
          ...(projectId === undefined ? {} : { projectId }),
          ...(status === undefined ? {} : { status: status as TaskStatus }),
          ...(runnableOnly === undefined ? {} : { runnableOnly }),
          ...(cursor === undefined ? {} : { cursor }),
          ...(limit === undefined ? {} : { limit })
        }) as unknown as Record<string, unknown>
      }
      case 'task.create': {
        const status = taskWireString(message['status'], 'status', 16)
        if (status !== undefined && status !== 'todo' && status !== 'blocked') throw new TaskAuthorityValidationError('status', 'must be todo or blocked')
        const priority = taskWireInteger(message['priority'], 'priority', 0, 1_000_000)
        const body = taskWireString(message['body'], 'body', TASK_AUTHORITY_MAX_USER_TEXT)
        const repositoryId = taskWireString(message['repositoryId'], 'repositoryId')
        const workspaceRoot = taskWireString(message['workspaceRoot'], 'workspaceRoot')
        return {
          task: this.taskAuthority.createTask({
            connection: this.taskAdminConnection(socket),
            projectId: taskWireRequiredString(message['projectId'], 'projectId'),
            ...(repositoryId === undefined ? {} : { repositoryId }),
            ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
            externalTaskId: taskWireRequiredString(message['externalTaskId'], 'externalTaskId'),
            title: taskWireRequiredString(message['title'], 'title', 512),
            ...(body === undefined ? {} : { body }),
            ...(priority === undefined ? {} : { priority }),
            ...(status === undefined ? {} : { status: status as 'todo' | 'blocked' })
          })
        }
      }
      case 'task.update': {
        const status = taskWireString(message['status'], 'status', 16)
        if (status !== undefined && status !== 'todo' && status !== 'blocked') throw new TaskAuthorityValidationError('status', 'must be todo or blocked')
        const priority = taskWireInteger(message['priority'], 'priority', 0, 1_000_000)
        const title = taskWireString(message['title'], 'title', 512)
        const body = taskWireString(message['body'], 'body', TASK_AUTHORITY_MAX_USER_TEXT)
        return {
          task: this.taskAuthority.updateTask({
            connection: this.taskAdminConnection(socket),
            projectId: taskWireRequiredString(message['projectId'], 'projectId'),
            taskId: taskWireUuid(message['taskId'], 'taskId'),
            expectedEntityVersion: taskWireEntityVersion(message['expectedEntityVersion']),
            ...(title === undefined ? {} : { title }),
            ...(body === undefined ? {} : { body }),
            ...(priority === undefined ? {} : { priority }),
            ...(status === undefined ? {} : { status: status as 'todo' | 'blocked' })
          })
        }
      }
      case 'task.dependencies.set': {
        const dependsOnTaskIds = message['dependsOnTaskIds']
        if (!Array.isArray(dependsOnTaskIds)) throw new TaskAuthorityValidationError('dependsOnTaskIds', 'must be an array of task ids')
        return {
          task: this.taskAuthority.setDependencies({
            connection: this.taskAdminConnection(socket),
            projectId: taskWireRequiredString(message['projectId'], 'projectId'),
            taskId: taskWireUuid(message['taskId'], 'taskId'),
            expectedEntityVersion: taskWireEntityVersion(message['expectedEntityVersion']),
            dependsOnTaskIds: dependsOnTaskIds.map((id, index) => assertAuthorityUuid(typeof id === 'string' ? id : '', `dependsOnTaskIds[${index}]`))
          })
        }
      }
      case 'task.schedule.create': {
        const nextRunAt = taskWireString(message['nextRunAt'], 'nextRunAt', 64)
        if (nextRunAt !== undefined && Number.isNaN(Date.parse(nextRunAt))) throw new TaskAuthorityValidationError('nextRunAt', 'must be an ISO 8601 timestamp')
        const enabled = taskWireBoolean(message['enabled'], 'enabled')
        const repositoryId = taskWireString(message['repositoryId'], 'repositoryId')
        const workspaceRoot = taskWireString(message['workspaceRoot'], 'workspaceRoot')
        return {
          schedule: this.taskAuthority.createSchedule({
            connection: this.taskAdminConnection(socket),
            projectId: taskWireRequiredString(message['projectId'], 'projectId'),
            ...(repositoryId === undefined ? {} : { repositoryId }),
            ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
            spec: taskWireScheduleSpec(message['spec']),
            ...(enabled === undefined ? {} : { enabled }),
            ...(nextRunAt === undefined ? {} : { nextRunAt })
          })
        }
      }
      case 'task.schedule.update': {
        const nextRunAtRaw = message['nextRunAt']
        const spec = message['spec'] === undefined ? undefined : taskWireScheduleSpec(message['spec'])
        const enabled = taskWireBoolean(message['enabled'], 'enabled')
        const nextRunAt = nextRunAtRaw === null ? null : taskWireString(nextRunAtRaw, 'nextRunAt', 64)
        if (nextRunAt !== null && nextRunAt !== undefined && Number.isNaN(Date.parse(nextRunAt))) {
          throw new TaskAuthorityValidationError('nextRunAt', 'must be an ISO 8601 timestamp or null')
        }
        return {
          schedule: this.taskAuthority.updateSchedule({
            connection: this.taskAdminConnection(socket),
            projectId: taskWireRequiredString(message['projectId'], 'projectId'),
            scheduleId: taskWireUuid(message['scheduleId'], 'scheduleId'),
            expectedEntityVersion: taskWireEntityVersion(message['expectedEntityVersion']),
            ...(spec === undefined ? {} : { spec }),
            ...(enabled === undefined ? {} : { enabled }),
            ...(nextRunAtRaw === undefined ? {} : { nextRunAt })
          })
        }
      }
      case 'task.schedule.duplicate':
        return {
          schedule: this.taskAuthority.duplicateSchedule({
            connection: this.taskAdminConnection(socket),
            projectId: taskWireRequiredString(message['projectId'], 'projectId'),
            scheduleId: taskWireUuid(message['scheduleId'], 'scheduleId'),
            expectedEntityVersion: taskWireEntityVersion(message['expectedEntityVersion'])
          })
        }
      case 'task.schedule.delete':
        return {
          schedule: this.taskAuthority.deleteSchedule({
            connection: this.taskAdminConnection(socket),
            projectId: taskWireRequiredString(message['projectId'], 'projectId'),
            scheduleId: taskWireUuid(message['scheduleId'], 'scheduleId'),
            expectedEntityVersion: taskWireEntityVersion(message['expectedEntityVersion'])
          })
        }
      case 'task.schedule.execution.enqueue':
        return {
          execution: this.taskAuthority.enqueueManualScheduleExecution({
            connection: this.taskAdminConnection(socket),
            projectId: taskWireRequiredString(message['projectId'], 'projectId'),
            scheduleId: taskWireUuid(message['scheduleId'], 'scheduleId'),
            expectedEntityVersion: taskWireEntityVersion(message['expectedEntityVersion']),
            requestId: taskWireRequiredString(message['requestId'], 'requestId')
          })
        }
      case 'task.schedule.list': {
        const projectId = taskWireString(message['projectId'], 'projectId')
        return { schedules: this.taskAuthority.listSchedules({ connection: this.taskAdminConnection(socket), ...(projectId === undefined ? {} : { projectId }) }) }
      }
      case 'task.schedule.executions.list': {
        const state = taskWireString(message['state'], 'state', 16)
        if (state !== undefined && !['queued', 'running', 'cancelling', 'cancelled', 'succeeded', 'failed'].includes(state)) {
          throw new TaskAuthorityValidationError('state', 'must be a known schedule execution state')
        }
        const limit = taskWireInteger(message['limit'], 'limit', 1, TASK_AUTHORITY_MAX_PAGE)
        const projectId = taskWireString(message['projectId'], 'projectId')
        const scheduleId = message['scheduleId'] === undefined ? undefined : taskWireUuid(message['scheduleId'], 'scheduleId')
        const cursor = taskWireString(message['cursor'], 'cursor')
        return this.taskAuthority.listScheduleExecutions({
          connection: this.taskAdminConnection(socket),
          ...(projectId === undefined ? {} : { projectId }),
          ...(scheduleId === undefined ? {} : { scheduleId }),
          ...(state === undefined ? {} : { state: state as 'queued' | 'running' | 'cancelling' | 'cancelled' | 'succeeded' | 'failed' }),
          ...(cursor === undefined ? {} : { cursor }),
          ...(limit === undefined ? {} : { limit })
        }) as unknown as Record<string, unknown>
      }
      case 'task.run-group.list': {
        const profileId = taskWireString(message['profileId'], 'profileId')
        return { runGroups: this.taskAuthority.listRunGroups({ connection: this.taskAdminConnection(socket), ...(profileId === undefined ? {} : { profileId }) }) }
      }
      case 'task.schedule.execution.cancel':
        return {
          execution: this.taskAuthority.cancelScheduleExecution({
            connection: this.taskAdminConnection(socket),
            projectId: taskWireRequiredString(message['projectId'], 'projectId'),
            scheduleId: taskWireUuid(message['scheduleId'], 'scheduleId'),
            executionId: taskWireUuid(message['executionId'], 'executionId'),
            expectedEntityVersion: taskWireEntityVersion(message['expectedEntityVersion'])
          })
        }
      case 'task.run-group.create': {
        const concurrency = taskWireInteger(message['concurrency'], 'concurrency', 1, 1_000_000)
        if (concurrency === undefined) throw new TaskAuthorityValidationError('concurrency', 'is required')
        return {
          runGroup: this.taskAuthority.createRunGroup({
            connection: this.taskAdminConnection(socket),
            profileId: taskWireRequiredString(message['profileId'], 'profileId'),
            name: taskWireRequiredString(message['name'], 'name', 512),
            concurrency,
            members: taskWireMemberList(message['members'], 'members')
          })
        }
      }
      case 'task.run-group.cancel':
        return {
          runGroup: this.taskAuthority.cancelRunGroup({
            connection: this.taskAdminConnection(socket),
            profileId: taskWireRequiredString(message['profileId'], 'profileId'),
            runGroupId: taskWireUuid(message['runGroupId'], 'runGroupId'),
            expectedEntityVersion: taskWireEntityVersion(message['expectedEntityVersion'])
          })
        }
      case 'task.run-group.delete':
        return {
          runGroup: this.taskAuthority.deleteRunGroup({
            connection: this.taskAdminConnection(socket),
            profileId: taskWireRequiredString(message['profileId'], 'profileId'),
            runGroupId: taskWireUuid(message['runGroupId'], 'runGroupId'),
            expectedEntityVersion: taskWireEntityVersion(message['expectedEntityVersion'])
          })
        }
      case 'task.run-group.retry': {
        const memberTaskIds = message['memberTaskIds']
        if (!Array.isArray(memberTaskIds)) throw new TaskAuthorityValidationError('memberTaskIds', 'must be an array of members')
        return {
          runGroup: this.taskAuthority.retryRunGroup({
            connection: this.taskAdminConnection(socket),
            runGroupId: taskWireUuid(message['runGroupId'], 'runGroupId'),
            expectedEntityVersion: taskWireEntityVersion(message['expectedEntityVersion']),
            requestId: taskWireRequiredString(message['requestId'], 'requestId'),
            ownerId: taskWireUuid(message['ownerId'], 'ownerId'),
            memberTaskIds: memberTaskIds.map((entry, index) => {
              if (typeof entry !== 'object' || entry === null) throw new TaskAuthorityValidationError(`memberTaskIds[${index}]`, 'must be an object')
              const record = entry as Record<string, unknown>
              return { projectId: taskWireRequiredString(record['projectId'], `memberTaskIds[${index}].projectId`), taskId: taskWireUuid(record['taskId'], `memberTaskIds[${index}].taskId`) }
            })
          })
        }
      }
      case 'task.cancel':
        return {
          task: this.taskAuthority.requestCancellation({
            connection: this.taskAdminConnection(socket),
            projectId: taskWireRequiredString(message['projectId'], 'projectId'),
            taskId: taskWireUuid(message['taskId'], 'taskId'),
            expectedEntityVersion: taskWireEntityVersion(message['expectedEntityVersion'])
          })
        }
      case 'task.retry': {
        const specification = message['specification'] === undefined ? undefined : parseTaskExecutionSpecification(message['specification'])
        const leaseTtlMs = taskWireInteger(message['leaseTtlMs'], 'leaseTtlMs', 1000, 600_000)
        return {
          claim: this.taskAuthority.retryFailedTask({
            connection: this.taskAdminConnection(socket),
            projectId: taskWireRequiredString(message['projectId'], 'projectId'),
            taskId: taskWireUuid(message['taskId'], 'taskId'),
            expectedEntityVersion: taskWireEntityVersion(message['expectedEntityVersion']),
            ownerId: taskWireUuid(message['ownerId'], 'ownerId'),
            ...(specification === undefined ? {} : { specification }),
            ...(leaseTtlMs === undefined ? {} : { leaseTtlMs })
          })
        }
      }
      case 'task.adopt-artifact':
        return {
          task: this.taskAuthority.adoptArtifact({
            connection: this.taskAdminConnection(socket),
            projectId: taskWireRequiredString(message['projectId'], 'projectId'),
            taskId: taskWireUuid(message['taskId'], 'taskId'),
            artifactId: taskWireUuid(message['artifactId'], 'artifactId'),
            reviewReceiptSha256: taskWireRequiredString(message['reviewReceiptSha256'], 'reviewReceiptSha256', 64)
          })
        }
      case 'task.claim': {
        const projectId = taskWireRequiredString(message['projectId'], 'projectId')
        const connection = this.bindTaskWorker(socket, message, projectId)
        const specification = parseTaskExecutionSpecification(message['specification'], 'specification')
        const taskId = message['taskId'] === undefined ? undefined : taskWireUuid(message['taskId'], 'taskId')
        const externalTaskId = message['externalTaskId'] === undefined ? undefined : taskWireRequiredString(message['externalTaskId'], 'externalTaskId')
        if (taskId === undefined && externalTaskId === undefined) throw new TaskAuthorityValidationError('claim', 'taskId or externalTaskId is required')
        const leaseTtlMs = taskWireInteger(message['leaseTtlMs'], 'leaseTtlMs', 1000, 600_000)
        const result = this.taskAuthority.claim({
          connection,
          projectId,
          ...(taskId === undefined ? { externalTaskId: externalTaskId as string } : { taskId }),
          specification,
          ...(leaseTtlMs === undefined ? {} : { leaseTtlMs })
        })
        this.launchClaimedTask(result, specification, 'finite-job', connection)
        return { task: result.task, attempt: result.attempt, token: result.token }
      }
      case 'task.write': {
        const token = taskWireLeaseToken(message['token'])
        const connection = this.bindTaskWorker(socket, message, token.projectId)
        const kind = taskWireRequiredString(message['kind'], 'kind', 32)
        switch (kind) {
          case 'heartbeat': {
            const ttlMs = taskWireInteger(message['ttlMs'], 'ttlMs', 1000, 600_000)
            return { task: this.taskAuthority.write({ kind: 'heartbeat', connection, token, ttlMs: ttlMs ?? 30_000 }) }
          }
          case 'progress': {
            const detail = taskWireRequiredString(message['detail'], 'detail', TASK_AUTHORITY_MAX_USER_TEXT)
            return { task: this.taskAuthority.write({ kind: 'progress', connection, token, detail }) }
          }
          case 'attach-artifact':
            return { task: this.taskAuthority.write({ kind: 'attach-artifact', connection, token, artifact: parseVerificationArtifact(message['artifact']) }) }
          case 'complete': {
            const summary = taskWireRequiredString(message['summary'], 'summary', TASK_AUTHORITY_MAX_USER_TEXT)
            return { task: this.taskAuthority.write({ kind: 'complete', connection, token, result: { summary } }) }
          }
          case 'fail': {
            const error = taskWireRequiredString(message['error'], 'error', TASK_AUTHORITY_MAX_ERROR_TEXT)
            return { task: this.taskAuthority.write({ kind: 'fail', connection, token, error }) }
          }
          default:
            throw new TaskAuthorityError('AUTHORIZATION_DENIED', `task write kind "${kind}" is reserved for daemon coordination or is unknown`)
        }
      }
      case 'task.handoff.offer': {
        const projectId = taskWireRequiredString(message['projectId'], 'projectId')
        const connection = this.bindTaskWorker(socket, message, projectId)
        return {
          offer: this.taskAuthority.offerHandoff({
            connection,
            projectId,
            taskId: taskWireUuid(message['taskId'], 'taskId'),
            attemptId: taskWireUuid(message['attemptId'], 'attemptId'),
            leaseId: taskWireUuid(message['leaseId'], 'leaseId'),
            generation: taskWireEntityVersion(message['generation'], 'generation'),
            targetOwnerId: taskWireUuid(message['targetOwnerId'], 'targetOwnerId'),
            ...(taskWireInteger(message['ttlMs'], 'ttlMs', 1000, 600_000) === undefined ? {} : { ttlMs: taskWireInteger(message['ttlMs'], 'ttlMs', 1000, 600_000) })
          })
        }
      }
      case 'task.handoff.cancel': {
        const projectId = taskWireRequiredString(message['projectId'], 'projectId')
        const connection = this.bindTaskWorker(socket, message, projectId)
        return {
          offer: this.taskAuthority.cancelHandoff({
            connection,
            projectId,
            taskId: taskWireUuid(message['taskId'], 'taskId'),
            attemptId: taskWireUuid(message['attemptId'], 'attemptId'),
            leaseId: taskWireUuid(message['leaseId'], 'leaseId'),
            generation: taskWireEntityVersion(message['generation'], 'generation'),
            offerId: taskWireUuid(message['offerId'], 'offerId')
          })
        }
      }
      case 'task.handoff.accept': {
        const projectId = taskWireRequiredString(message['projectId'], 'projectId')
        const connection = this.bindTaskWorker(socket, message, projectId)
        const result = this.taskAuthority.acceptHandoff({
          connection,
          projectId,
          taskId: taskWireUuid(message['taskId'], 'taskId'),
          attemptId: taskWireUuid(message['attemptId'], 'attemptId'),
          offerId: taskWireUuid(message['offerId'], 'offerId')
        })
        this.resumeClaimedTask(result, connection)
        return { task: result.task, attempt: result.attempt, token: result.token }
      }
      case 'task.takeover': {
        const projectId = taskWireRequiredString(message['projectId'], 'projectId')
        const connection = this.bindTaskWorker(socket, message, projectId)
        const result = this.taskAuthority.takeOverExpired({
          connection,
          projectId,
          taskId: taskWireUuid(message['taskId'], 'taskId'),
          attemptId: taskWireUuid(message['attemptId'], 'attemptId'),
          leaseId: taskWireUuid(message['leaseId'], 'leaseId'),
          generation: taskWireEntityVersion(message['generation'], 'generation'),
          ...(taskWireInteger(message['leaseTtlMs'], 'leaseTtlMs', 1000, 600_000) === undefined ? {} : { leaseTtlMs: taskWireInteger(message['leaseTtlMs'], 'leaseTtlMs', 1000, 600_000) })
        })
        this.resumeClaimedTask(result, connection)
        return { task: result.task, attempt: result.attempt, token: result.token }
      }
      case 'task.mailbox.append': {
        const projectId = taskWireRequiredString(message['projectId'], 'projectId')
        const connection = this.bindTaskWorker(socket, message, projectId)
        const kind = taskWireRequiredString(message['kind'], 'kind', 16)
        if (kind !== 'attention' && kind !== 'progress' && kind !== 'artifact' && kind !== 'system') {
          throw new TaskAuthorityValidationError('kind', 'must be a known mailbox kind')
        }
        const payload = message['payload']
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
          throw new TaskAuthorityValidationError('payload', 'must be an object')
        }
        return {
          mailboxEntry: this.taskAuthority.appendMailbox({ connection, projectId, taskId: taskWireUuid(message['taskId'], 'taskId'), kind: kind as 'attention' | 'progress' | 'artifact' | 'system', payload: payload as Record<string, unknown> })
        }
      }
      case 'task.mailbox.acknowledge':
        return {
          mailboxEntry: this.taskAuthority.acknowledgeAttention({
            connection: this.taskAdminConnection(socket),
            projectId: taskWireRequiredString(message['projectId'], 'projectId'),
            taskId: taskWireUuid(message['taskId'], 'taskId'),
            mailboxEntryId: taskWireUuid(message['mailboxEntryId'], 'mailboxEntryId')
          })
        }
      default:
        throw new TaskAuthorityError('DAEMON_UPGRADE_REQUIRED', `unknown task op: ${op}`)
    }
  }
}
