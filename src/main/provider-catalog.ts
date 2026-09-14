import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { AGENT_PROVIDER_DEFINITIONS } from '@shared/agent-runtime'
import { ProviderCatalogError, isAgentDriverId, parseProviderInstanceInput, PROVIDER_CREDENTIAL_OPERATION_KINDS, PROVIDER_CREDENTIAL_OPERATION_STATES, type AgentDriverId, type ProviderAccount, type ProviderCatalog, type ProviderCatalogSnapshot, type ProviderCommandSpec, type ProviderCredentialBinding, type ProviderCredentialOperation, type ProviderCredentialOperationKind, type ProviderCredentialOperationState, type ProviderDriverProjection, type ProviderInstanceInput, type ProviderInstanceProjection, type ProviderLaunchPreparation, type ProviderManagedSupport, type ProviderSelection, type BindCredentialInput, type UnbindCredentialInput } from '@shared/provider-authority'
import type { TaskAuthorityDatabase } from './task-authority/schema'
import { AgentRegistry } from './agents/registry'
import { certificationFor, type ProviderCertification } from './agents/provider-certifications'

export { ProviderCatalogError }
export type ProviderCatalogOptions = Readonly<{ database: TaskAuthorityDatabase; registry?: AgentRegistry; certifications?: readonly ProviderCertification[]; now?: () => Date }>
type Row = Record<string, unknown>
const MAX_LABEL = 256
const PREPARATION_TTL_MS = 30_000
/** SQLite primary result code for a violated foreign key (see node:sqlite errcode). */
const SQLITE_CONSTRAINT_FOREIGNKEY = 787

function text(row: Row, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new ProviderCatalogError('CORRUPT_CATALOG', `catalog row field ${key} is invalid`)
  return value
}
function integer(row: Row, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new ProviderCatalogError('CORRUPT_CATALOG', `catalog row field ${key} is invalid`)
  return value
}
function canonicalLabel(value: string, field: string): string {
  const label = value.trim()
  if (!label || label.length > MAX_LABEL || /[\0\r\n]/.test(label)) throw new ProviderCatalogError('INVALID_INPUT', `${field} is invalid`)
  return label
}
function jsonCommand(value: string): ProviderCommandSpec {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    if (parsed['kind'] === 'driver' && typeof parsed['driverId'] === 'string' && !isAgentDriverId(parsed['driverId'])) return { kind: 'driver', driverId: parsed['driverId'] as AgentDriverId }
    return parseProviderInstanceInput({ driverId: 'custom-command', displayName: 'x', command: parsed, credentialMode: 'external', accountId: null, enabled: true }).command
  } catch (error) {
    throw new ProviderCatalogError('CORRUPT_CATALOG', error instanceof Error ? error.message : String(error))
  }
}
function nowIso(clock: () => Date): string { return clock().toISOString() }
/** A raw SQLite foreign-key failure is a catalog refusal, never an untyped crash. */
function isForeignKeyFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { errcode?: unknown; message?: unknown }
  return candidate.errcode === SQLITE_CONSTRAINT_FOREIGNKEY || (typeof candidate.message === 'string' && candidate.message.includes('FOREIGN KEY constraint failed'))
}

/**
 * The daemon-owned SQLite catalog. Its credential-saga methods are synchronous
 * here because this class is the authority itself; the async
 * `ProviderCredentialCatalog` seam is what trusted main orchestration sees, and
 * `DaemonClient` adapts the two.
 */
export class SqliteProviderCatalog implements ProviderCatalog {
  readonly databasePath: string
  private readonly database: TaskAuthorityDatabase
  private readonly registry: AgentRegistry
  private readonly certifications: readonly ProviderCertification[]
  private readonly clock: () => Date

  constructor(options: ProviderCatalogOptions) {
    this.database = options.database
    this.databasePath = options.database.databasePath
    this.registry = options.registry ?? new AgentRegistry()
    this.certifications = options.certifications ?? []
    this.clock = options.now ?? (() => new Date())
    this.database.withImmediate(db => {
      const present = db.prepare('SELECT singleton FROM provider_catalog_state WHERE singleton = 1').get() as Row | undefined
      if (!present) db.prepare('INSERT INTO provider_catalog_state(singleton,default_instance_id,revision) VALUES (1,NULL,1)').run()
    })
  }

  snapshot(): ProviderCatalogSnapshot {
    return this.database.withReadOnly(db => {
      const state = db.prepare('SELECT default_instance_id,revision FROM provider_catalog_state WHERE singleton = 1').get() as Row | undefined
      if (!state) throw new ProviderCatalogError('CORRUPT_CATALOG', 'provider catalog state is missing')
      const accountRows = db.prepare('SELECT id,driver_id,display_label,verified_subject,revision FROM provider_accounts ORDER BY id').all() as Row[]
      const accounts = accountRows.map(row => this.accountFromRow(row))
      const byId = new Map(accounts.map(account => [account.id, account]))
      const drivers = this.driverProjections()
      const instances = (db.prepare('SELECT * FROM provider_instances ORDER BY id').all() as Row[]).map(row => this.instanceFromRow(row, byId, drivers))
      return { revision: integer(state, 'revision'), defaultInstanceId: state['default_instance_id'] === null ? null : text(state, 'default_instance_id'), drivers, accounts, instances }
    })
  }

  createAccount(input: { driverId: AgentDriverId; displayLabel: string }): ProviderAccount {
    if (!isAgentDriverId(input.driverId)) throw new ProviderCatalogError('DRIVER_UNAVAILABLE', 'unknown provider driver')
    const displayLabel = canonicalLabel(input.displayLabel, 'displayLabel')
    return this.database.withImmediate(db => {
      this.purgePreparations(db)
      const id = randomUUID(); const now = nowIso(this.clock)
      db.prepare('INSERT INTO provider_accounts(id,driver_id,display_label,verified_subject,revision,created_at,updated_at) VALUES (?,?,?,NULL,1,?,?)').run(id, input.driverId, displayLabel, now, now)
      this.bumpCatalog(db)
      return { id, driverId: input.driverId, displayLabel, revision: 1 }
    })
  }

  updateAccount(input: { id: string; expectedRevision: number; displayLabel: string }): ProviderAccount {
    const displayLabel = canonicalLabel(input.displayLabel, 'displayLabel')
    return this.database.withImmediate(db => {
      this.purgePreparations(db)
      const row = this.accountRow(db, input.id)
      this.requireRevision(row, input.expectedRevision, 'ACCOUNT_CHANGED')
      this.assertNoIncompleteCredentialOperationById(db, input.id)
      if (this.activeBindingForAccount(db, input.id)) throw new ProviderCatalogError('ACCOUNT_HAS_CREDENTIAL', 'account has an active credential binding')
      const revision = integer(row, 'revision') + 1; const now = nowIso(this.clock)
      this.guardForeignKeys(() => {
        db.prepare('UPDATE provider_accounts SET display_label=?,revision=?,updated_at=? WHERE id=?').run(displayLabel, revision, now, input.id)
      }, 'account is still referenced by credential history')
      this.bumpCatalog(db)
      return { id: text(row, 'id'), driverId: this.driverId(text(row, 'driver_id')), displayLabel, ...(row['verified_subject'] === null ? {} : { verifiedSubject: text(row, 'verified_subject') }), revision }
    })
  }

  /**
   * An account may only be removed once nothing references it. Retired binding
   * history is owned by the account and is deleted with it; an active binding or
   * a referencing instance is a typed refusal, never a raw foreign-key crash.
   */
  removeAccount(input: { id: string; expectedRevision: number }): void {
    this.database.withImmediate(db => {
      this.purgePreparations(db)
      const row = this.accountRow(db, input.id)
      this.requireRevision(row, input.expectedRevision, 'ACCOUNT_CHANGED')
      this.assertNoIncompleteCredentialOperationById(db, input.id)
      if (this.activeBindingForAccount(db, input.id)) throw new ProviderCatalogError('ACCOUNT_HAS_CREDENTIAL', 'account has an active credential binding')
      if (db.prepare('SELECT 1 FROM provider_instances WHERE account_id=? LIMIT 1').get(input.id)) throw new ProviderCatalogError('ACCOUNT_HAS_CREDENTIAL', 'account is referenced by an instance')
      this.guardForeignKeys(() => {
        db.prepare('DELETE FROM provider_credential_bindings WHERE account_id=? AND retired_at IS NOT NULL').run(input.id)
        db.prepare('DELETE FROM provider_accounts WHERE id=?').run(input.id)
      }, 'account is still referenced by credential history')
      this.bumpCatalog(db)
    })
  }

  create(input: ProviderInstanceInput): ProviderInstanceProjection {
    const parsed = parseProviderInstanceInput(input)
    const id = this.database.withImmediate(db => this.writeInstance(db, parsed, null, null))
    return this.snapshotInstance(id)
  }

  /**
   * Update mutates the existing row in place. Deleting and re-inserting the
   * parent row under `foreign_keys=ON` would either fail on child references
   * (bindings, preparations, the default pointer) or silently drop `created_at`.
   */
  update(id: string, expectedRevision: number, input: ProviderInstanceInput): ProviderInstanceProjection {
    const parsed = parseProviderInstanceInput({ ...input, id })
    const updatedId = this.database.withImmediate(db => {
      this.purgePreparations(db)
      const current = this.instanceRow(db, id)
      this.requireRevision(current, expectedRevision, 'INSTANCE_CHANGED')
      this.assertNoIncompleteCredentialOperation(db, id, null)
      if (this.activeBindingForInstance(db, id)) throw new ProviderCatalogError('INSTANCE_HAS_CREDENTIAL', 'instance has an active credential binding')
      return this.writeInstance(db, parsed, id, integer(current, 'revision'))
    })
    return this.snapshotInstance(updatedId)
  }

  /**
   * Removal clears a matching default pointer inside the same transaction, then
   * deletes the instance with its credential history. A non-null pointer that
   * survives would violate the state table's foreign key, so the order matters
   * and the pointer is never silently re-pointed at another instance.
   */
  remove(id: string, expectedRevision: number): void {
    this.database.withImmediate(db => {
      this.purgePreparations(db)
      const row = this.instanceRow(db, id); this.requireRevision(row, expectedRevision, 'INSTANCE_CHANGED')
      this.assertNoIncompleteCredentialOperation(db, id, null)
      if (this.activeBindingForInstance(db, id)) throw new ProviderCatalogError('INSTANCE_HAS_CREDENTIAL', 'instance has an active credential binding')
      if (db.prepare('SELECT 1 FROM provider_launch_preparations WHERE provider_instance_id=? LIMIT 1').get(id)) throw new ProviderCatalogError('PREPARATION_ACTIVE', 'instance is still named by a live launch preparation')
      db.prepare('UPDATE provider_catalog_state SET default_instance_id=NULL WHERE singleton=1 AND default_instance_id=?').run(id)
      this.guardForeignKeys(() => {
        db.prepare('DELETE FROM provider_credential_bindings WHERE provider_instance_id=?').run(id)
        db.prepare('DELETE FROM provider_instances WHERE id=?').run(id)
      }, 'instance is still referenced by credential history')
      this.bumpCatalog(db)
    })
  }

  setDefault(id: string | null, expectedRevision: number): ProviderCatalogSnapshot {
    this.database.withImmediate(db => {
      this.purgePreparations(db)
      const state = this.stateRow(db); this.requireRevision(state, expectedRevision, 'INSTANCE_CHANGED')
      if (id !== null) this.instanceRow(db, id)
      db.prepare('UPDATE provider_catalog_state SET default_instance_id=?,revision=? WHERE singleton=1').run(id, expectedRevision + 1)
    })
    return this.snapshot()
  }

  bindCredential(input: BindCredentialInput): ProviderInstanceProjection {
    const id = this.database.withImmediate(db => {
      this.purgePreparations(db)
      const instance = this.instanceRow(db, input.providerInstanceId); this.requireRevision(instance, input.expectedInstanceRevision, 'INSTANCE_CHANGED')
      const account = this.accountRow(db, input.accountId); this.requireRevision(account, input.expectedAccountRevision, 'ACCOUNT_CHANGED')
      if (this.driverId(text(instance, 'driver_id')) !== this.driverId(text(account, 'driver_id'))) throw new ProviderCatalogError('ACCOUNT_MISMATCH', 'credential account driver does not match instance')
      if (typeof input.credentialRef !== 'string' || !input.credentialRef || input.credentialRef.length > 512 || input.credentialRef.includes('\0')) throw new ProviderCatalogError('CREDENTIAL_REQUIRED', 'credential reference is invalid')
      if (this.activeBindingForInstance(db, input.providerInstanceId)) throw new ProviderCatalogError('INSTANCE_HAS_CREDENTIAL', 'instance already has an active credential binding')
      // Retired rows keep their generation inside the primary key, so the next
      // generation is allocated above every generation this account has ever
      // used. A caller that just revoked has no live binding to read a
      // generation from, so its seed cannot be trusted to be the highest one.
      const highest = db.prepare('SELECT MAX(generation) AS generation FROM provider_credential_bindings WHERE provider_instance_id=? AND account_id=?').get(input.providerInstanceId, input.accountId) as Row
      const generation = Math.max(input.expectedBindingGeneration + 1, (highest['generation'] === null ? 0 : integer(highest, 'generation')) + 1); const now = nowIso(this.clock)
      db.prepare('INSERT INTO provider_credential_bindings(provider_instance_id,account_id,account_revision,credential_ref,generation,created_at,retired_at) VALUES (?,?,?,?,?,?,NULL)').run(input.providerInstanceId, input.accountId, input.expectedAccountRevision, input.credentialRef, generation, now)
      db.prepare('UPDATE provider_instances SET revision=revision+1,updated_at=? WHERE id=?').run(now, input.providerInstanceId); this.bumpCatalog(db)
      return input.providerInstanceId
    })
    return this.snapshotInstance(id)
  }

  /**
   * There is no free-standing unbind: retirement only happens as the second half
   * of an exact live destructive credential operation, which the caller may not
   * fabricate.
   */
  retireCredentialBindingForOperation(input: UnbindCredentialInput & { credentialOperationId: string }): ProviderInstanceProjection {
    const id = this.database.withImmediate(db => {
      this.purgePreparations(db)
      const instance = this.instanceRow(db, input.providerInstanceId); this.requireRevision(instance, input.expectedInstanceRevision, 'INSTANCE_CHANGED')
      const account = this.accountRow(db, input.accountId); this.requireRevision(account, input.expectedAccountRevision, 'ACCOUNT_CHANGED')
      const binding = db.prepare('SELECT * FROM provider_credential_bindings WHERE provider_instance_id=? AND account_id=? AND generation=? AND retired_at IS NULL').get(input.providerInstanceId, input.accountId, input.expectedBindingGeneration) as Row | undefined
      if (!binding) throw new ProviderCatalogError('CREDENTIAL_REQUIRED', 'active credential binding was not found')
      const operation = db.prepare("SELECT id FROM provider_credential_operations WHERE id=? AND operation_kind IN ('revoke','account-update','account-remove','instance-update','instance-remove') AND state='pending' AND provider_instance_id=? AND account_id=? AND prior_binding_generation=?").get(input.credentialOperationId, input.providerInstanceId, input.accountId, input.expectedBindingGeneration)
      if (!operation) throw new ProviderCatalogError('CREDENTIAL_REQUIRED', 'credential retirement requires its live destructive operation')
      db.prepare('UPDATE provider_credential_bindings SET retired_at=? WHERE provider_instance_id=? AND account_id=? AND generation=?').run(nowIso(this.clock), input.providerInstanceId, input.accountId, input.expectedBindingGeneration)
      db.prepare("UPDATE provider_credential_operations SET state='complete',updated_at=? WHERE id=?").run(nowIso(this.clock), input.credentialOperationId)
      this.bumpCatalog(db)
      return input.providerInstanceId
    })
    return this.snapshotInstance(id)
  }

  prepareLaunch(input: { selection: ProviderSelection; attemptId: string; sessionId: string; purpose: 'agent-launch' }): ProviderLaunchPreparation {
    return this.database.withImmediate(db => {
      this.purgePreparations(db)
      const selection = input.selection
      if (!isAgentDriverId(selection.driverId)) throw new ProviderCatalogError('DRIVER_UNAVAILABLE', 'unknown provider driver')
      const row = this.instanceRow(db, selection.providerInstanceId)
      this.requireRevision(row, selection.instanceRevision, 'INSTANCE_CHANGED')
      if (Number(row['enabled']) !== 1) throw new ProviderCatalogError('INSTANCE_DISABLED', 'provider instance is disabled')
      if (text(row, 'driver_id') !== selection.driverId) throw new ProviderCatalogError('DRIVER_UNAVAILABLE', 'provider selection does not match instance')
      const command = jsonCommand(text(row, 'command_spec_json'))
      const mode = text(row, 'credential_mode') as 'external' | 'managed' | 'none'
      this.validateMode(selection.driverId, mode, command)
      let credentialRequest: ProviderLaunchPreparation['credentialRequest'] = null
      if (selection.accountId !== null) {
        if (selection.accountRevision === null) throw new ProviderCatalogError('ACCOUNT_CHANGED', 'selection account revision is required')
        const account = this.accountRow(db, selection.accountId); this.requireRevision(account, selection.accountRevision, 'ACCOUNT_CHANGED')
        if (text(account, 'driver_id') !== selection.driverId) throw new ProviderCatalogError('ACCOUNT_MISMATCH', 'selection account does not match driver')
        const binding = db.prepare('SELECT * FROM provider_credential_bindings WHERE provider_instance_id=? AND account_id=? AND retired_at IS NULL').get(selection.providerInstanceId, selection.accountId) as Row | undefined
        if (mode === 'managed' && !binding) throw new ProviderCatalogError('CREDENTIAL_REQUIRED', 'managed provider has no bound credential')
        if (binding) credentialRequest = { credentialRef: text(binding, 'credential_ref'), bindingGeneration: integer(binding, 'generation'), driverId: selection.driverId, providerInstanceId: selection.providerInstanceId, accountId: selection.accountId, accountRevision: integer(account, 'revision') }
      } else if (mode === 'managed') throw new ProviderCatalogError('CREDENTIAL_REQUIRED', 'managed provider requires an account')
      const id = randomUUID(); const createdAt = nowIso(this.clock); const expiresAt = new Date(this.clock().getTime() + PREPARATION_TTL_MS).toISOString()
      db.prepare('INSERT INTO provider_launch_preparations(id,provider_instance_id,instance_revision,account_id,account_revision,credential_ref,binding_generation,attempt_id,session_id,purpose,expires_at,consumed_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,?)').run(id, selection.providerInstanceId, selection.instanceRevision, selection.accountId, selection.accountRevision, credentialRequest?.credentialRef ?? null, credentialRequest?.bindingGeneration ?? null, input.attemptId, input.sessionId, input.purpose, expiresAt, createdAt)
      return { id, selection: structuredClone(selection), command, credentialMode: mode, credentialRequest, attemptId: input.attemptId, sessionId: input.sessionId, purpose: input.purpose, expiresAt }
    })
  }

  /* ---------------------------------------------------------------- *
   * Credential-operation saga (main-only).
   *
   * Refs and generations are the internal identity of one credential, so none
   * of these methods may be reached from renderer IPC; the daemon and the
   * main-process orchestrator are the only callers.
   * ---------------------------------------------------------------- */

  credentialBinding(providerInstanceId: string, accountId: string): ProviderCredentialBinding | null {
    return this.database.withReadOnly(db => {
      const row = db.prepare('SELECT * FROM provider_credential_bindings WHERE provider_instance_id=? AND account_id=? AND retired_at IS NULL').get(providerInstanceId, accountId) as Row | undefined
      if (!row) return null
      const instance = this.instanceRow(db, providerInstanceId)
      const account = this.accountRow(db, accountId)
      return {
        driverId: this.driverId(text(instance, 'driver_id')),
        providerInstanceId,
        instanceRevision: integer(instance, 'revision'),
        accountId,
        accountRevision: integer(account, 'revision'),
        credentialRef: text(row, 'credential_ref'),
        bindingGeneration: integer(row, 'generation')
      }
    })
  }

  incompleteCredentialOperations(): ProviderCredentialOperation[] {
    return this.database.withReadOnly(db => (db.prepare("SELECT * FROM provider_credential_operations WHERE state IN ('pending','catalog-bound') ORDER BY created_at, id").all() as Row[]).map(row => this.operationRow(row)))
  }

  credentialOperation(operationId: string): ProviderCredentialOperation | null {
    return this.database.withReadOnly(db => {
      const row = db.prepare('SELECT * FROM provider_credential_operations WHERE id=?').get(operationId) as Row | undefined
      return row ? this.operationRow(row) : null
    })
  }

  credentialScope(providerInstanceId: string, accountId: string): { driverId: AgentDriverId; instanceRevision: number; accountRevision: number } {
    return this.database.withReadOnly(db => {
      const instance = this.instanceRow(db, providerInstanceId)
      const account = this.accountRow(db, accountId)
      if (integer(instance, 'revision') < 1) throw new ProviderCatalogError('CORRUPT_CATALOG', 'provider instance revision is invalid')
      const driverId = this.driverId(text(instance, 'driver_id'))
      if (this.driverId(text(account, 'driver_id')) !== driverId) throw new ProviderCatalogError('ACCOUNT_MISMATCH', 'credential account driver does not match instance')
      return { driverId, instanceRevision: integer(instance, 'revision'), accountRevision: integer(account, 'revision') }
    })
  }

  /**
   * One durable intent per tuple. The unique live index makes a second
   * concurrent saga against the same instance/account a typed refusal rather
   * than a race, and the ref is persisted before any material is sealed.
   */
  stageCredentialReplace(input: { operationId: string; providerInstanceId: string; accountId: string; expectedInstanceRevision: number; expectedAccountRevision: number; stagedCredentialRef: string }): ProviderCredentialOperation {
    return this.database.withImmediate(db => {
      this.purgePreparations(db)
      const instance = this.instanceRow(db, input.providerInstanceId); this.requireRevision(instance, input.expectedInstanceRevision, 'INSTANCE_CHANGED')
      const account = this.accountRow(db, input.accountId); this.requireRevision(account, input.expectedAccountRevision, 'ACCOUNT_CHANGED')
      if (this.driverId(text(instance, 'driver_id')) !== this.driverId(text(account, 'driver_id'))) throw new ProviderCatalogError('ACCOUNT_MISMATCH', 'credential account driver does not match instance')
      if (text(instance, 'credential_mode') === 'external') throw new ProviderCatalogError('CREDENTIAL_REQUIRED', 'external providers do not accept managed credentials')
      if (typeof input.stagedCredentialRef !== 'string' || !input.stagedCredentialRef || input.stagedCredentialRef.length > 512 || input.stagedCredentialRef.includes('\0')) throw new ProviderCatalogError('CREDENTIAL_REQUIRED', 'staged credential reference is invalid')
      this.assertNoIncompleteCredentialOperation(db, input.providerInstanceId, input.accountId)
      const prior = db.prepare('SELECT * FROM provider_credential_bindings WHERE provider_instance_id=? AND account_id=? AND retired_at IS NULL').get(input.providerInstanceId, input.accountId) as Row | undefined
      const now = nowIso(this.clock)
      // Retired rows keep their generation in the primary key, so the target is
      // allocated above every generation this account has ever used; reusing a
      // retired generation would be refused by the primary key on publication.
      const highest = db.prepare('SELECT MAX(generation) AS generation FROM provider_credential_bindings WHERE provider_instance_id=? AND account_id=?').get(input.providerInstanceId, input.accountId) as Row
      const target = (highest['generation'] === null ? 0 : integer(highest, 'generation')) + 1
      this.guardForeignKeys(() => {
        db.prepare("INSERT INTO provider_credential_operations(id,operation_kind,provider_instance_id,instance_revision,account_id,account_revision,prior_credential_ref,prior_binding_generation,staged_credential_ref,target_binding_generation,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)").run(input.operationId, 'create-replace', input.providerInstanceId, input.expectedInstanceRevision, input.accountId, input.expectedAccountRevision, prior ? text(prior, 'credential_ref') : null, prior ? integer(prior, 'generation') : null, input.stagedCredentialRef, target, now, now)
      }, 'a credential operation is already live for this provider account')
      return this.operationRow(db.prepare('SELECT * FROM provider_credential_operations WHERE id=?').get(input.operationId) as Row)
    })
  }

  /**
   * The Catalog compare-and-set: it publishes exactly the target generation
   * only while the prior binding and both revisions still match, and stops at
   * the `catalog-bound` checkpoint so a crash before the superseded-ref
   * revocation is reconcilable rather than silently complete.
   */
  bindStagedCredential(input: { operationId: string; providerInstanceId: string; accountId: string; expectedInstanceRevision: number; expectedAccountRevision: number; targetCredentialRef: string; targetBindingGeneration: number; expectedBindingGeneration: number }): boolean {
    return this.database.withImmediate(db => {
      this.purgePreparations(db)
      const operationRow = db.prepare('SELECT * FROM provider_credential_operations WHERE id=?').get(input.operationId) as Row | undefined
      if (!operationRow) throw new ProviderCatalogError('CREDENTIAL_OPERATION_NOT_FOUND', 'credential operation was not found')
      const operation = this.operationRow(operationRow)
      if (operation.state === 'complete' || operation.kind !== 'create-replace') return operation.state === 'complete'
      if (operation.state === 'aborted') return false
      const instance = this.instanceRow(db, input.providerInstanceId); this.requireRevision(instance, input.expectedInstanceRevision, 'INSTANCE_CHANGED')
      const account = this.accountRow(db, input.accountId); this.requireRevision(account, input.expectedAccountRevision, 'ACCOUNT_CHANGED')
      const current = db.prepare('SELECT * FROM provider_credential_bindings WHERE provider_instance_id=? AND account_id=? AND retired_at IS NULL').get(input.providerInstanceId, input.accountId) as Row | undefined
      const currentRef = current ? text(current, 'credential_ref') : null
      const currentGeneration = current ? integer(current, 'generation') : null
      // Compare-and-set against the binding the intent recorded; a concurrent
      // replacement or revocation therefore makes this bind lose, never retarget.
      if (currentRef !== operation.priorCredentialRef || currentGeneration !== operation.priorBindingGeneration) {
        // The staged ref may already hold sealed material, so this row is left
        // `pending` rather than written `aborted`: only the orchestrator owns
        // the staged ref and may revoke it first, and a terminal row would hide
        // the intent from reconciliation forever. The caller reads `false`.
        return false
      }
      const now = nowIso(this.clock)
      if (current) db.prepare('UPDATE provider_credential_bindings SET retired_at=? WHERE provider_instance_id=? AND account_id=? AND generation=?').run(now, input.providerInstanceId, input.accountId, currentGeneration)
      this.guardForeignKeys(() => {
        db.prepare('INSERT INTO provider_credential_bindings(provider_instance_id,account_id,account_revision,credential_ref,generation,created_at,retired_at) VALUES (?,?,?,?,?,?,NULL)').run(input.providerInstanceId, input.accountId, input.expectedAccountRevision, input.targetCredentialRef, input.targetBindingGeneration, now)
      }, 'the target credential binding could not be published')
      db.prepare("UPDATE provider_credential_operations SET state='catalog-bound',updated_at=? WHERE id=?").run(now, input.operationId)
      db.prepare('UPDATE provider_instances SET revision=revision+1,updated_at=? WHERE id=?').run(now, input.providerInstanceId)
      // Publication advances the instance revision by exactly one, and the
      // sealed record authenticates that published revision. If the increments
      // ever diverge, the credential could never materialize for its own launch.
      const published = db.prepare('SELECT revision FROM provider_instances WHERE id=?').get(input.providerInstanceId) as Row
      if (integer(published, 'revision') !== input.expectedInstanceRevision + 1) throw new ProviderCatalogError('CORRUPT_CATALOG', 'provider instance revision did not advance by exactly one')
      this.bumpCatalog(db)
      return true
    })
  }

  /** Records a destructive intent against the exact live ref/generation. */
  stageCredentialRevoke(input: { operationId: string; providerInstanceId: string; accountId: string; expectedInstanceRevision: number; expectedAccountRevision: number; kind?: ProviderCredentialOperationKind }): ProviderCredentialOperation {
    const kind = input.kind ?? 'revoke'
    if (kind === 'create-replace') throw new ProviderCatalogError('INVALID_INPUT', 'create-replace uses its own staging path')
    return this.database.withImmediate(db => {
      this.purgePreparations(db)
      const instance = this.instanceRow(db, input.providerInstanceId); this.requireRevision(instance, input.expectedInstanceRevision, 'INSTANCE_CHANGED')
      const account = this.accountRow(db, input.accountId); this.requireRevision(account, input.expectedAccountRevision, 'ACCOUNT_CHANGED')
      this.assertNoIncompleteCredentialOperation(db, input.providerInstanceId, input.accountId)
      const binding = db.prepare('SELECT * FROM provider_credential_bindings WHERE provider_instance_id=? AND account_id=? AND retired_at IS NULL').get(input.providerInstanceId, input.accountId) as Row | undefined
      if (!binding) throw new ProviderCatalogError('CREDENTIAL_REQUIRED', 'no active credential binding to revoke')
      const now = nowIso(this.clock)
      db.prepare("INSERT INTO provider_credential_operations(id,operation_kind,provider_instance_id,instance_revision,account_id,account_revision,prior_credential_ref,prior_binding_generation,staged_credential_ref,target_binding_generation,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,NULL,NULL,'pending',?,?)").run(input.operationId, kind, input.providerInstanceId, input.expectedInstanceRevision, input.accountId, input.expectedAccountRevision, text(binding, 'credential_ref'), integer(binding, 'generation'), now, now)
      return this.operationRow(db.prepare('SELECT * FROM provider_credential_operations WHERE id=?').get(input.operationId) as Row)
    })
  }

  /** Idempotent terminal transition; replaying the same state is a no-op. */
  closeCredentialOperation(input: { operationId: string; state: ProviderCredentialOperationState }): ProviderCredentialOperation {
    return this.database.withImmediate(db => {
      const row = db.prepare('SELECT * FROM provider_credential_operations WHERE id=?').get(input.operationId) as Row | undefined
      if (!row) throw new ProviderCatalogError('CREDENTIAL_OPERATION_NOT_FOUND', 'credential operation was not found')
      const current = this.operationRow(row)
      if (current.state === input.state) return current
      db.prepare('UPDATE provider_credential_operations SET state=?,updated_at=? WHERE id=?').run(input.state, nowIso(this.clock), input.operationId)
      return { ...current, state: input.state }
    })
  }

  /**
   * Governed identity mutations run after their saga completes exact
   * revocation, so an incomplete saga against the tuple blocks the mutation
   * instead of orphaning a credential. It reads the caller's own transaction:
   * the process-wide authority lock is not reentrant, so opening a second
   * connection here would deadlock every governed mutation.
   */
  private assertNoIncompleteCredentialOperation(db: DatabaseSync, providerInstanceId: string, accountId: string | null): void {
    const row = accountId === null
      ? db.prepare("SELECT id FROM provider_credential_operations WHERE state IN ('pending','catalog-bound') AND provider_instance_id=? LIMIT 1").get(providerInstanceId) as Row | undefined
      : db.prepare("SELECT id FROM provider_credential_operations WHERE state IN ('pending','catalog-bound') AND provider_instance_id=? AND account_id=? LIMIT 1").get(providerInstanceId, accountId) as Row | undefined
    if (row) throw new ProviderCatalogError('CREDENTIAL_OPERATION_ACTIVE', 'a credential operation targeting this provider account is still live')
  }

  /**
   * The account-scoped sibling: an accountable identity mutation is refused
   * while any incomplete saga still targets that account, so a governed path
   * always retires its exact credential first and never orphans one.
   */
  private assertNoIncompleteCredentialOperationById(db: DatabaseSync, accountId: string): void {
    if (db.prepare("SELECT id FROM provider_credential_operations WHERE state IN ('pending','catalog-bound') AND account_id=? LIMIT 1").get(accountId)) throw new ProviderCatalogError('CREDENTIAL_OPERATION_ACTIVE', 'a credential operation targeting this provider account is still live')
  }

  private operationRow(row: Row): ProviderCredentialOperation {
    const state = text(row, 'state')
    if (!(PROVIDER_CREDENTIAL_OPERATION_STATES as readonly string[]).includes(state)) throw new ProviderCatalogError('CORRUPT_CATALOG', 'credential operation state is invalid')
    const kind = text(row, 'operation_kind')
    if (!(PROVIDER_CREDENTIAL_OPERATION_KINDS as readonly string[]).includes(kind)) throw new ProviderCatalogError('CORRUPT_CATALOG', 'credential operation kind is invalid')
    return {
      id: text(row, 'id'),
      kind: kind as ProviderCredentialOperationKind,
      state: state as ProviderCredentialOperationState,
      providerInstanceId: row['provider_instance_id'] === null ? null : text(row, 'provider_instance_id'),
      instanceRevision: row['instance_revision'] === null ? null : integer(row, 'instance_revision'),
      accountId: row['account_id'] === null ? null : text(row, 'account_id'),
      accountRevision: row['account_revision'] === null ? null : integer(row, 'account_revision'),
      priorCredentialRef: row['prior_credential_ref'] === null ? null : text(row, 'prior_credential_ref'),
      priorBindingGeneration: row['prior_binding_generation'] === null ? null : integer(row, 'prior_binding_generation'),
      stagedCredentialRef: row['staged_credential_ref'] === null ? null : text(row, 'staged_credential_ref'),
      targetBindingGeneration: row['target_binding_generation'] === null ? null : integer(row, 'target_binding_generation')
    }
  }

  private validateMode(driverId: AgentDriverId, mode: 'external' | 'managed' | 'none', command: ProviderCommandSpec): void {
    if (mode === 'external') return
    if (driverId === 'custom-command' || command.kind !== 'driver' || command.driverId !== driverId) throw new ProviderCatalogError('DRIVER_MODE_UNCERTIFIED', 'managed and none require a certified driver command')
    const executable = this.registry.findExecutable(driverId)
    const certification = executable === undefined ? undefined : certificationFor(driverId, mode, executable, [], process.platform, process.arch, this.certifications)
    if (!certification) throw new ProviderCatalogError('DRIVER_MODE_UNCERTIFIED', `driver ${driverId} is not certified for ${mode}`)
  }

  private writeInstance(db: DatabaseSync, input: ProviderInstanceInput, existingId: string | null, previousRevision: number | null): string {
    const driver = this.driverProjection(input.driverId)
    if (driver.kind === 'unknown') throw new ProviderCatalogError('DRIVER_UNAVAILABLE', 'provider driver is unavailable')
    this.validateMode(input.driverId, input.credentialMode, input.command)
    if (input.command.kind === 'driver' && input.command.driverId !== input.driverId) throw new ProviderCatalogError('COMMAND_NOT_ALLOWED', 'driver command does not match provider driver')
    if (input.credentialMode === 'managed' && input.accountId === null) throw new ProviderCatalogError('CREDENTIAL_REQUIRED', 'managed provider requires an account')
    if (input.accountId !== null) {
      const account = this.accountRow(db, input.accountId)
      if (text(account, 'driver_id') !== input.driverId) throw new ProviderCatalogError('ACCOUNT_MISMATCH', 'instance account driver does not match')
    }
    const id = existingId ?? input.id ?? randomUUID(); const revision = previousRevision === null ? 1 : previousRevision + 1; const now = nowIso(this.clock)
    if (existingId === null) db.prepare('INSERT INTO provider_instances(id,driver_id,display_name,command_spec_json,credential_mode,account_id,enabled,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, input.driverId, input.displayName, JSON.stringify(input.command), input.credentialMode, input.accountId, input.enabled ? 1 : 0, revision, now, now)
    else db.prepare('UPDATE provider_instances SET driver_id=?,display_name=?,command_spec_json=?,credential_mode=?,account_id=?,enabled=?,revision=?,updated_at=? WHERE id=?').run(input.driverId, input.displayName, JSON.stringify(input.command), input.credentialMode, input.accountId, input.enabled ? 1 : 0, revision, now, id)
    this.bumpCatalog(db)
    return id
  }

  /**
   * Launch preparations are bounded-TTL launch intent, not durable history: the
   * durable record of an attempt lives in the Stage 2 attempt tables. Purging
   * them keeps the catalog from growing without bound and stops an expired
   * preparation from pinning an instance or account against edits/removal. The
   * admission receipt references the preparation, so it is removed first — which
   * is also why this runs inside the caller's own transaction.
   */
  private purgePreparations(db: DatabaseSync): void {
    const now = nowIso(this.clock)
    db.prepare('DELETE FROM task_launch_admissions WHERE preparation_id IN (SELECT id FROM provider_launch_preparations WHERE consumed_at IS NOT NULL OR expires_at <= ?)').run(now)
    db.prepare('DELETE FROM provider_launch_preparations WHERE consumed_at IS NOT NULL OR expires_at <= ?').run(now)
  }
  private guardForeignKeys<T>(operation: () => T, message: string): T {
    try {
      return operation()
    } catch (error) {
      if (isForeignKeyFailure(error)) throw new ProviderCatalogError('FOREIGN_KEY_CONFLICT', message)
      throw error
    }
  }
  private driverId(value: string): AgentDriverId { if (!isAgentDriverId(value)) throw new ProviderCatalogError('CORRUPT_CATALOG', `unknown persisted driver ${value}`); return value }
  private accountRow(db: DatabaseSync, id: string): Row { const row = db.prepare('SELECT * FROM provider_accounts WHERE id=?').get(id) as Row | undefined; if (!row) throw new ProviderCatalogError('ACCOUNT_NOT_FOUND', 'provider account was not found'); return row }
  private instanceRow(db: DatabaseSync, id: string): Row { const row = db.prepare('SELECT * FROM provider_instances WHERE id=?').get(id) as Row | undefined; if (!row) throw new ProviderCatalogError('INSTANCE_NOT_FOUND', 'provider instance was not found'); return row }
  private stateRow(db: DatabaseSync): Row { const row = db.prepare('SELECT * FROM provider_catalog_state WHERE singleton=1').get() as Row | undefined; if (!row) throw new ProviderCatalogError('CORRUPT_CATALOG', 'provider catalog state is missing'); return row }
  private requireRevision(row: Row, expected: number, code: 'INSTANCE_CHANGED' | 'ACCOUNT_CHANGED'): void { if (integer(row, 'revision') !== expected) throw new ProviderCatalogError(code, 'provider revision changed') }
  private bumpCatalog(db: DatabaseSync): void { db.prepare('UPDATE provider_catalog_state SET revision=revision+1 WHERE singleton=1').run() }
  private activeBindingForAccount(db: DatabaseSync, accountId: string): Row | undefined { return db.prepare('SELECT * FROM provider_credential_bindings WHERE account_id=? AND retired_at IS NULL LIMIT 1').get(accountId) as Row | undefined }
  private activeBindingForInstance(db: DatabaseSync, instanceId: string): Row | undefined { return db.prepare('SELECT * FROM provider_credential_bindings WHERE provider_instance_id=? AND retired_at IS NULL LIMIT 1').get(instanceId) as Row | undefined }
  private accountFromRow(row: Row): ProviderAccount { return { id: text(row, 'id'), driverId: this.driverId(text(row, 'driver_id')), displayLabel: text(row, 'display_label'), ...(row['verified_subject'] === null ? {} : { verifiedSubject: text(row, 'verified_subject') }), revision: integer(row, 'revision') } }

  /**
   * A driver projection is composed only from reviewed certification records.
   * The certification type already binds platform to a reviewed value, so a
   * supported tuple is reported as-is and never clamped onto another platform.
   */
  private driverProjection(id: AgentDriverId): ProviderDriverProjection {
    if (id === 'custom-command') return { kind: 'known', id, displayName: 'Custom command', installed: true, hooks: { support: 'unavailable', events: [], reason: 'Custom commands do not provide driver hooks.' }, skills: { supported: false, reason: 'Custom commands do not provide native skill discovery.' }, memorySupport: 'none', credentialModes: ['external'], managedSupport: { kind: 'unsupported', reason: 'Custom commands are external-only.' } }
    const definition = AGENT_PROVIDER_DEFINITIONS.find(candidate => candidate.id === id)
    if (!definition) return { kind: 'unknown', rawDriverId: id, availability: 'unavailable', problem: 'driver is not registered' }
    const executable = this.registry.findExecutable(definition.command)
    const managed = executable === undefined ? undefined : certificationFor(id, 'managed', executable, [], process.platform, process.arch, this.certifications)
    const none = executable === undefined ? undefined : certificationFor(id, 'none', executable, [], process.platform, process.arch, this.certifications)
    const certification = managed ?? none
    const modes = certification ? [...new Set(certification.modes)] : []
    const managedSupport: ProviderManagedSupport = certification ? { kind: 'certified', modes, supportedVersionRange: certification.supportedVersionRange, platform: certification.platform, architecture: certification.architecture } : { kind: 'unsupported', reason: 'No reviewed certification evidence.' }
    return { kind: 'known', id, displayName: definition.name, installed: executable !== undefined, ...(executable ? { executable } : {}), hooks: structuredClone(definition.hookSupport), skills: structuredClone(definition.skillConsumer), memorySupport: definition.memorySupport, credentialModes: ['external', ...modes], managedSupport }
  }
  private driverProjections(): ProviderDriverProjection[] { return [...AGENT_PROVIDER_DEFINITIONS.map(definition => this.driverProjection(definition.id)), this.driverProjection('custom-command')] }
  private instanceFromRow(row: Row, accounts: Map<string, ProviderAccount>, drivers: readonly ProviderDriverProjection[]): ProviderInstanceProjection {
    const driverId = text(row, 'driver_id'); const driver = drivers.find(candidate => candidate.kind === 'known' && candidate.id === driverId) ?? { kind: 'unknown', rawDriverId: driverId, availability: 'unavailable' as const, problem: 'persisted driver is not registered' }
    const command = jsonCommand(text(row, 'command_spec_json')); const mode = text(row, 'credential_mode')
    if (mode !== 'external' && mode !== 'managed' && mode !== 'none') throw new ProviderCatalogError('CORRUPT_CATALOG', 'persisted credential mode is invalid')
    const accountId = row['account_id'] === null ? null : text(row, 'account_id'); const account = accountId === null ? null : accounts.get(accountId) ?? null
    const unavailable = driver.kind === 'unknown' || (mode !== 'external' && driver.managedSupport.kind !== 'certified')
    return { id: text(row, 'id'), driver, displayName: text(row, 'display_name'), command, credentialMode: mode, account, enabled: Number(row['enabled']) === 1, revision: integer(row, 'revision'), availability: unavailable ? 'unavailable' : 'available', ...(unavailable ? { problem: driver.kind === 'unknown' ? driver.problem : 'credential mode is not currently certified' } : {}) }
  }
  private snapshotInstance(id: string): ProviderInstanceProjection {
    const projection = this.snapshot().instances.find(instance => instance.id === id)
    if (!projection) throw new ProviderCatalogError('INSTANCE_NOT_FOUND', 'provider instance was not found')
    return projection
  }
}
