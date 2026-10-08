import { createHash } from 'node:crypto'
import type { ProviderCatalog, ProviderCatalogSnapshot, MigratedLegacyCommandPlan, AgentDriverId, ProviderCommandSpec } from '@shared/provider-authority'
import {
  ProfileMaintenanceError,
  parseProfileMaintenanceParticipantSet,
  type ProfileMaintenanceLease,
  type ProfileMaintenanceParticipant,
  type ProfileMaintenanceTransitionReceipt,
  type AuthenticatedAdministratorContext,
  type AuthenticatedProfileMaintenanceMigrationContext,
  type AuthenticatedProfileMaintenanceParticipantContext
} from '@shared/profile-maintenance'
import { migrateLegacyToInstance, MIGRATED_CREDENTIAL_MODE, PROVIDER_MIGRATION_VERSION, EXTERNAL_COMMAND_DRIVER_ID } from './provider-migration'
import { publishLegacyCommandRemoval } from './legacy-agent-command-removal'
import { SqliteProfileMaintenanceGate } from './profile-maintenance-gate'

/**
 * One-time, gate-fenced legacy `agentCommand` → provider-instance migration
 * (Stage 3 / Provider Authority). Acquires The shared profile maintenance lease
 * for `task-authority` + `provider-authority`, Freezes Ordinary Admissions,
 * Collects Both Exact-epoch Acknowledgements, Then Calls `beginCutover` Before
 * The Final Source Capture. Each Legacy Command Becomes A Deterministic instance
 * (`deriveInstanceKey`) With `custom-command` External-Shell Fallback; Only A
 * Valid Migration Sets The Default. No Ordinary Catalog RPC Accepts A Receipt.
 */

/** Participants whose Acknowledgement Gates The Provider-Authority Cutover. */
const MIGRATION_PARTICIPANTS: readonly ProfileMaintenanceParticipant[] = ['task-authority', 'provider-authority']

/** The authenticated migration coordinator, bound To stage-3. */
const COORDINATOR: AuthenticatedAdministratorContext = { connectionId: 'migration-owner', ownerStage: 'stage-3' }

/** The migration-owner context reused by transition prepare/complete. */
const migrationOwner: AuthenticatedProfileMaintenanceMigrationContext = { connectionId: 'migration-owner', ownerStage: 'stage-3' }

/** Builds The exact-epoch participant drain context. */
const participantContext = (name: ProfileMaintenanceParticipant, connectionId: string): AuthenticatedProfileMaintenanceParticipantContext => ({ connectionId, participant: name })

export type ProviderMaintenanceMigrationOptions = Readonly<{
  gate: SqliteProfileMaintenanceGate
  catalog: ProviderCatalog
  profileId?: string
  /**
   * The profile directory whose settings envelope is published to. Absent in
   * tests that drive the Catalog and gate without a filesystem, in which case
   * the settings publication is skipped rather than invented.
   */
  userDataDir?: string
}>

/** One legacy command to migrate; The renderer Supplies A Display Name + The Original Command String. */
export type MigrateCommandInput = Readonly<{ command: string; displayName: string }>

/** A deterministic instance plan derived from one legacy command (configuration-required yields null). */
type MigrationPlan = Readonly<{ id: string | null; driverId: AgentDriverId; command: ProviderCommandSpec; displayName: string }>

/** The Outcome Of A Complete provider-instance migration run. */
export type MigrationResult = Readonly<{ snapshot: ProviderCatalogSnapshot; receiptId: string; defaultInstanceId: string | null; instanceIds: readonly string[] }>

/** The prepared-transition receipt Id For A Resume Before Handlers Register (crash-recovery Key). */
export type PreparedMigration = Readonly<{ receiptId: string; migrationId: string }>

/** Directs The one-time provider-authority cutover across The shared gate + catalog. */
export class ProviderMaintenanceMigration {
  private readonly gate: SqliteProfileMaintenanceGate
  private readonly catalog: ProviderCatalog
  private readonly profileId: string
  private readonly userDataDir: string | undefined

  constructor(options: ProviderMaintenanceMigrationOptions) {
    this.gate = options.gate
    this.catalog = options.catalog
    this.profileId = options.profileId ?? 'default'
    this.userDataDir = options.userDataDir
  }

  /**
   * Advances The gate To the cutover phase: acquires A stage-3 lease over both
   * participants, freezes Ordinary Admissions, Drains/Reconciles Exact pre-freeze
   * Work (Both Acknowledgements), And Calls `beginCutover`. An Unacknowledged
   * Participant OR Unresolved Admission Holds The Cutover (Retry Resumes It).
   *
   * A run that crashed before the Catalog commit left no ledger row, so there is
   * nothing to resume from and `acquire` would refuse the still-held lease —
   * permanently, since it is the same daemon that restarts. This therefore
   * resumes its OWN interrupted lease instead of taking a new one. A lease held
   * by a different migration is never resumed: that migration owns it and must
   * be resolved by its own coordinator.
   */
  async prepareCutover(): Promise<ProfileMaintenanceLease> {
    const interrupted = this.gate.readState()
    if (interrupted.phase !== 'open') {
      const held = interrupted.lease
      if (held === null) throw new ProfileMaintenanceError('GATE_PHASE_INVALID', `profile maintenance phase "${interrupted.phase}" has no lease to resume`)
      if (held.migrationId !== this.migrationId() || held.ownerStage !== 'stage-3') {
        throw new ProfileMaintenanceError('GATE_LEASED', `migration ${held.migrationId} holds the profile maintenance lease; only its own coordinator may resume it`)
      }
      // Freeze and both drain acknowledgements are idempotent, and `beginCutover`
      // returns early when the phase already reached it.
      await this.gate.freeze(COORDINATOR, held)
      for (const participant of MIGRATION_PARTICIPANTS) {
        await this.gate.acknowledgeDrained(participantContext(participant, COORDINATOR.connectionId), held.migrationId)
      }
      await this.gate.beginCutover(COORDINATOR, held)
      return held
    }

    const lease = await this.gate.acquire(COORDINATOR, {
      migrationId: this.migrationId(),
      ownerStage: 'stage-3',
      participants: parseProfileMaintenanceParticipantSet([...MIGRATION_PARTICIPANTS]),
      expectedRevision: this.gate.readState().revision
    })
    await this.gate.freeze(COORDINATOR, lease)
    for (const participant of MIGRATION_PARTICIPANTS) {
      await this.gate.acknowledgeDrained(participantContext(participant, COORDINATOR.connectionId), lease.migrationId)
    }
    await this.gate.beginCutover(COORDINATOR, lease)
    return lease
  }

  /** Lists The Prepared Provider-Authority Transitions For A Resume Before Handlers Register. */
  async preparedTransitions(lease: ProfileMaintenanceLease): Promise<PreparedMigration[]> {
    const transitions = await this.gate.listMigrationTransitions(migrationOwner, lease)
    return transitions.map(transition => ({ receiptId: transition.id, migrationId: lease.migrationId }))
  }

  /** Turns The user commands Into Deterministic instance plans (configuration-required yields null). */
  private plansFromCommands(commands: readonly MigrateCommandInput[]): MigrationPlan[] {
    return commands.map(command => {
      const migrated = migrateLegacyToInstance({ command: command.command, credentialMode: MIGRATED_CREDENTIAL_MODE })
      const id = migrated.spec === null ? null : String(migrated.key)
      return {
        id,
        driverId: (migrated.spec?.driverId ?? EXTERNAL_COMMAND_DRIVER_ID) as AgentDriverId,
        command: migrated.spec?.command ?? { kind: 'external-shell', program: command.command },
        displayName: command.displayName
      } as MigrationPlan
    })
  }

  /** The frozen source digest Of The Migrated Command Set (keyed By Version + Ordered Commands). */
  private frozenSourceSha256(commands: readonly MigrateCommandInput[]): string {
    const payload = JSON.stringify({ version: PROVIDER_MIGRATION_VERSION, profileId: this.profileId, commands })
    return createHash('sha256').update(payload, 'utf8').digest('hex')
  }

  /** The migration operation id; one migration version per profile. */
  private operationId(): string {
    return PROVIDER_MIGRATION_VERSION + ':' + this.profileId
  }

  /** The profile-scoped migration id this coordinator leases and owns. */
  private migrationId(): string {
    return this.operationId()
  }

  /**
   * A participant's canonical intent digest. It is derived only from stable
   * identity, so a fresh run and a crash resume produce the same value and the
   * gate's prepare-time conflict check compares equal rather than refusing a
   * legitimate retry.
   */
  private intentSha256(participant: ProfileMaintenanceParticipant): string {
    return createHash('sha256').update(`${PROVIDER_MIGRATION_VERSION}:${this.profileId}:${participant}:intent`, 'utf8').digest('hex')
  }

  /**
   * The evidence digest recorded when a transition completes. It is a pure
   * function of committed state, so replaying a completion is idempotent.
   */
  private evidenceSha256(participant: ProfileMaintenanceParticipant, sourceSha256: string, snapshot: ProviderCatalogSnapshot): string {
    return createHash('sha256').update(JSON.stringify({
      participant,
      sourceSha256,
      revision: snapshot.revision,
      defaultInstanceId: snapshot.defaultInstanceId,
      instanceIds: snapshot.instances.map(instance => instance.id)
    }), 'utf8').digest('hex')
  }

  /**
   * Brings one frozen participant's transition to `completed`, resuming rather
   * than restarting: an existing prepared receipt is completed as-is (its intent
   * is already bound) and an existing completed receipt is left alone. Only a
   * participant with no receipt at all is prepared here.
   */
  private async ensureParticipantCompleted(lease: ProfileMaintenanceLease, participant: ProfileMaintenanceParticipant, sourceSha256: string, existing: readonly ProfileMaintenanceTransitionReceipt[]): Promise<void> {
    const found = existing.find(receipt => receipt.participant === participant)
    if (found !== undefined && found.state === 'completed') return
    const receipt = found ?? await this.gate.prepareMigrationTransition(migrationOwner, lease, {
      participant,
      operationId: this.operationId(),
      sourceSha256,
      intentSha256: this.intentSha256(participant),
      visibilityMode: 'central'
    })
    await this.gate.completeMigrationTransition(migrationOwner, receipt, this.evidenceSha256(participant, sourceSha256, this.catalog.snapshot()))
  }

  /** Full-pipeline migration: prepare cutover → derive plans → prepare transition → commit (integrated) → finalize. */
  async migrate(input: { commands: readonly MigrateCommandInput[]; defaultPlanIndex?: number }): Promise<MigrationResult> {
    const commands = input.commands ?? []

    // Startup calls this on every boot, so a completed migration must be a
    // no-op before any lease is taken: re-running the gate would fail against
    // the already-completed receipt and take the daemon down with it.
    const recorded = this.catalog.completedMigration()
    if (recorded !== null) {
      // The Catalog commit is durable, but a crash between it and `release`
      // leaves the gate non-open with the coordinator's lease still held. The
      // instances are already canonical, so resuming only finishes the gate
      // bookkeeping; it never re-derives or re-writes Catalog state.
      await this.finishInterruptedCutover(recorded)
      // The settings publication is the last step of the transfer and is
      // idempotent, so a resume that crashed between the commit and here still
      // removes the legacy setting rather than leaving two authorities live.
      this.publishRemovalIfRequested()
      return { snapshot: this.catalog.snapshot(), receiptId: recorded.receiptId, defaultInstanceId: recorded.defaultInstanceId, instanceIds: recorded.instanceIds }
    }

    const lease = await this.prepareCutover()

    const plans = this.plansFromCommands(commands).filter(plan => plan.id !== null) as MigratedLegacyCommandPlan[]
    const defaultPlanIndex = input.defaultPlanIndex ?? 0
    const defaultInstanceId: string | null = defaultPlanIndex < plans.length ? (plans[defaultPlanIndex]!.id) : null

    const sourceSha256 = this.frozenSourceSha256(commands)
    const intentSha256 = this.intentSha256('provider-authority')

    // Prepare The provider-authority transition, THEN Validate It Inside The Catalog Commit Transaction.
    const prepared: ProfileMaintenanceTransitionReceipt = await this.gate.prepareMigrationTransition(migrationOwner, lease, { participant: 'provider-authority', operationId: this.operationId(), sourceSha256, intentSha256, visibilityMode: 'central' })
    const snapshot: ProviderCatalogSnapshot = this.catalog.beginMigrationTransition({ preparedReceiptId: prepared.id, sourceSha256, intentSha256, plans, defaultInstanceId })
    await this.gate.completeMigrationTransition(migrationOwner, prepared, this.evidenceSha256('provider-authority', sourceSha256, snapshot))

    // The Catalog commit made the instance authoritative; this publishes that
    // decision to the settings envelope and removes the legacy command, so the
    // profile stops carrying two launch authorities.
    this.publishRemovalIfRequested()

    // `release` refuses while any frozen participant lacks a completed receipt —
    // "a partial set would reopen admissions with sources still unwritten" — so
    // every participant this migration froze must finish its own transition.
    // The provider participant's work is the Catalog commit above; the rest
    // certify only that they were drained and hold no unwritten provider-command
    // authority, which the gate independently re-verifies as zero live admissions.
    const issued = await this.gate.listMigrationTransitions(migrationOwner, lease)
    for (const participant of MIGRATION_PARTICIPANTS) {
      if (participant === 'provider-authority') continue
      await this.ensureParticipantCompleted(lease, participant, sourceSha256, issued)
    }

    await this.gate.release(COORDINATOR, lease, 'active')

    return { snapshot, receiptId: prepared.id, defaultInstanceId, instanceIds: plans.map(plan => plan.id) }
  }

  /**
   * Removes the legacy setting once the Catalog is authoritative.
   *
   * Only a profile with a directory and an actual migration to perform reaches
   * here, and the removal itself is idempotent, so a resumed run and a first run
   * take the same path.
   */
  private publishRemovalIfRequested(): void {
    if (this.userDataDir === undefined) return
    publishLegacyCommandRemoval(this.userDataDir)
  }

  /**
   * Closes out a cutover whose Catalog commit already succeeded.
   *
   * A crash after the commit but before `release` leaves the gate non-open with
   * our lease still held. The committed instances are canonical, so this only
   * finishes the gate bookkeeping the interrupted run did not reach — it never
   * re-derives plans, re-writes instances, or re-commits the migration. A gate
   * that is already `open` (the ordinary case) is left untouched.
   */
  private async finishInterruptedCutover(recorded: { sourceSha256: string }): Promise<void> {
    const state = this.gate.readState()
    if (state.phase !== 'cutting-over') return
    const lease = state.lease
    if (lease === null) throw new Error('profile maintenance is cutting over without a lease; an operator must resume or abort it')
    const issued = await this.gate.listMigrationTransitions(migrationOwner, lease)
    for (const participant of MIGRATION_PARTICIPANTS) {
      await this.ensureParticipantCompleted(lease, participant, recorded.sourceSha256, issued)
    }
    await this.gate.release(COORDINATOR, lease, 'active')
  }
}
