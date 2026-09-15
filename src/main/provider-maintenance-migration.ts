import { createHash } from 'node:crypto'
import type { ProviderCatalog, ProviderCatalogSnapshot, MigratedLegacyCommandPlan, AgentDriverId, ProviderCommandSpec } from '@shared/provider-authority'
import {
  parseProfileMaintenanceParticipantSet,
  type ProfileMaintenanceLease,
  type ProfileMaintenanceParticipant,
  type ProfileMaintenanceTransitionIntent,
  type ProfileMaintenanceTransitionReceipt,
  type AuthenticatedAdministratorContext,
  type AuthenticatedProfileMaintenanceMigrationContext,
  type AuthenticatedProfileMaintenanceParticipantContext
} from '@shared/profile-maintenance'
import { migrateLegacyToInstance, MIGRATED_CREDENTIAL_MODE, PROVIDER_MIGRATION_VERSION, EXTERNAL_COMMAND_DRIVER_ID } from './provider-migration'
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

export type ProviderMaintenanceMigrationOptions = Readonly<{ gate: SqliteProfileMaintenanceGate; catalog: ProviderCatalog; profileId?: string }>

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

  constructor(options: ProviderMaintenanceMigrationOptions) {
    this.gate = options.gate
    this.catalog = options.catalog
    this.profileId = options.profileId ?? 'default'
  }

  /**
   * Advances The gate To the cutover phase: acquires A stage-3 lease over both
   * participants, freezes Ordinary Admissions, Drains/Reconciles Exact pre-freeze
   * Work (Both Acknowledgements), And Calls `beginCutover`. An Unacknowledged
   * Participant OR Unresolved Admission Holds The Cutover (Retry Resumes It).
   */
  async prepareCutover(): Promise<ProfileMaintenanceLease> {
    const lease = await this.gate.acquire(COORDINATOR, {
      migrationId: PROVIDER_MIGRATION_VERSION + ':' + this.profileId,
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

  /** Full-pipeline migration: prepare cutover → derive plans → prepare transition → commit (integrated) → finalize. */
  async migrate(input: { commands: readonly MigrateCommandInput[]; defaultPlanIndex?: number }): Promise<MigrationResult> {
    const commands = input.commands ?? []
    const lease = await this.prepareCutover()

    const plans = this.plansFromCommands(commands).filter(plan => plan.id !== null) as MigratedLegacyCommandPlan[]
    const defaultPlanIndex = input.defaultPlanIndex ?? 0
    const defaultInstanceId: string | null = defaultPlanIndex < plans.length ? (plans[defaultPlanIndex]!.id) : null

    const sourceSha256 = this.frozenSourceSha256(commands)
    const intentSha256 = createHash('sha256').update(`${PROVIDER_MIGRATION_VERSION}:${this.profileId}:intent`, 'utf8').digest('hex')
    const operationId = PROVIDER_MIGRATION_VERSION + ':' + this.profileId

    // Prepare The provider-authority transition, THEN Validate It Inside The Catalog Commit Transaction.
    const prepared: ProfileMaintenanceTransitionReceipt = await this.gate.prepareMigrationTransition(migrationOwner, lease, { participant: 'provider-authority', operationId, sourceSha256, intentSha256, visibilityMode: 'central' })
    const snapshot: ProviderCatalogSnapshot = this.catalog.beginMigrationTransition({ preparedReceiptId: prepared.id, sourceSha256, intentSha256, plans, defaultInstanceId })

    const evidenceSha256 = createHash('sha256').update(JSON.stringify({ revision: snapshot.revision, defaultInstanceId: defaultInstanceId ?? null, instanceIds: plans.map(plan => plan.id) }), 'utf8').digest('hex')
    await this.gate.completeMigrationTransition(migrationOwner, prepared, evidenceSha256)
    await this.gate.release(COORDINATOR, lease, 'active')

    return { snapshot, receiptId: prepared.id, defaultInstanceId, instanceIds: plans.map(plan => plan.id) }
  }
}

/** Re-exported For Test Alignment. */
export { MIGRATED_CREDENTIAL_MODE }
