import { AGENT_PROVIDER_DEFINITIONS, type AgentExecutable, type AgentHookSupport, type AgentMemorySupport, type AgentSkillConsumer } from './agent-runtime'

/** Daemon protocol capability that activates the sanitized provider catalog surface. */
export const AGENT_PROVIDER_CATALOG_CAPABILITY = 'provider-catalog-v1'

/**
 * Every driver the catalog can configure: the declarative provider registry plus
 * the explicit custom-command escape hatch. Derived, never hand-maintained, so a
 * new provider definition cannot silently miss the catalog.
 */
export const AGENT_PROVIDER_DRIVER_IDS = ['custom-command', ...AGENT_PROVIDER_DEFINITIONS.map(definition => definition.id)] as const

export type AgentDriverId = (typeof AGENT_PROVIDER_DRIVER_IDS)[number]
export type ProviderCredentialMode = 'external' | 'managed' | 'none'
export const PROVIDER_CREDENTIAL_MODES = ['external', 'managed', 'none'] as const

/** Platforms a managed/none certification may bind. Invalid values are rejected, never coerced. */
export const PROVIDER_CERTIFICATION_PLATFORMS = ['darwin', 'linux', 'win32'] as const
export type ProviderCertificationPlatform = (typeof PROVIDER_CERTIFICATION_PLATFORMS)[number]

export type ProviderCommandSpec =
  | { kind: 'driver'; driverId: AgentDriverId }
  | { kind: 'external-argv'; executable: AgentExecutable }
  | { kind: 'external-shell'; program: string }
export type ProviderAccount = { id: string; driverId: AgentDriverId; displayLabel: string; verifiedSubject?: string; revision: number }
export type ProviderSelection = { driverId: AgentDriverId; providerInstanceId: string; instanceRevision: number; accountId: string | null; accountRevision: number | null }
export type ProviderInstanceInput = { id?: string; driverId: AgentDriverId; displayName: string; command: ProviderCommandSpec; credentialMode: ProviderCredentialMode; accountId: string | null; enabled: boolean }
export type ProviderManagedSupport =
  | { kind: 'unsupported'; reason: string }
  | { kind: 'certified'; modes: readonly ('managed' | 'none')[]; supportedVersionRange: string; platform: ProviderCertificationPlatform; architecture: string }
export type ProviderDriverProjection =
  | { kind: 'known'; id: AgentDriverId; displayName: string; installed: boolean; executable?: string; hooks: AgentHookSupport; skills: AgentSkillConsumer; memorySupport: AgentMemorySupport; credentialModes: readonly ProviderCredentialMode[]; managedSupport: ProviderManagedSupport; problem?: string }
  | { kind: 'unknown'; rawDriverId: string; availability: 'unavailable'; problem: string }
export type ProviderInstanceProjection = { id: string; driver: ProviderDriverProjection; displayName: string; command: ProviderCommandSpec; credentialMode: ProviderCredentialMode; account: ProviderAccount | null; enabled: boolean; revision: number; availability: 'available' | 'unavailable'; problem?: string }
export type ProviderCatalogSnapshot = { revision: number; defaultInstanceId: string | null; drivers: readonly ProviderDriverProjection[]; accounts: readonly ProviderAccount[]; instances: readonly ProviderInstanceProjection[] }
export type BindCredentialInput = { providerInstanceId: string; accountId: string; expectedInstanceRevision: number; expectedAccountRevision: number; credentialRef: string; expectedBindingGeneration: number }
export type UnbindCredentialInput = { providerInstanceId: string; accountId: string; expectedInstanceRevision: number; expectedAccountRevision: number; expectedBindingGeneration: number }

// ---------------------------------------------------------------------------
// Credential-operation ledger (internal; never renderer-visible)
//
// Every provider credential create/replace/revoke is a durable saga across two
// authorities that no single transaction can span: this Catalog ledger owns the
// intent and the binding facts, Secret Authority owns the material. These
// contracts carry opaque refs and generations and are therefore main-only:
// they never enter `IpcApi`, preload, or a sanitized projection.
// ---------------------------------------------------------------------------

export const PROVIDER_CREDENTIAL_OPERATION_KINDS = ['create-replace', 'revoke', 'account-update', 'account-remove', 'instance-update', 'instance-remove'] as const
export type ProviderCredentialOperationKind = (typeof PROVIDER_CREDENTIAL_OPERATION_KINDS)[number]
export const PROVIDER_CREDENTIAL_OPERATION_STATES = ['pending', 'catalog-bound', 'complete', 'aborted'] as const
export type ProviderCredentialOperationState = (typeof PROVIDER_CREDENTIAL_OPERATION_STATES)[number]

/** One durable saga row. `pending`/`catalog-bound` are the incomplete states. */
export type ProviderCredentialOperation = {
  id: string
  kind: ProviderCredentialOperationKind
  state: ProviderCredentialOperationState
  providerInstanceId: string | null
  instanceRevision: number | null
  accountId: string | null
  accountRevision: number | null
  priorCredentialRef: string | null
  priorBindingGeneration: number | null
  stagedCredentialRef: string | null
  targetBindingGeneration: number | null
}

/** The exact live binding plus the revisions a principal resolution must carry. */
export type ProviderCredentialBinding = {
  driverId: AgentDriverId
  providerInstanceId: string
  instanceRevision: number
  accountId: string
  accountRevision: number
  credentialRef: string
  bindingGeneration: number
}

export type PrepareProviderLaunchInput = { selection: ProviderSelection; attemptId: string; sessionId: string; purpose: 'agent-launch' }
export type ProviderLaunchPreparation = { id: string; selection: ProviderSelection; command: ProviderCommandSpec; credentialMode: ProviderCredentialMode; credentialRequest: null | { credentialRef: string; bindingGeneration: number; driverId: AgentDriverId; providerInstanceId: string; accountId: string; accountRevision: number }; attemptId: string; sessionId: string; purpose: 'agent-launch'; expiresAt: string }
/** The synchronous in-process credential-saga slice of the Catalog. */
export interface ProviderCredentialOperations {
  credentialScope(providerInstanceId: string, accountId: string): { driverId: AgentDriverId; instanceRevision: number; accountRevision: number }
  credentialBinding(providerInstanceId: string, accountId: string): ProviderCredentialBinding | null
  incompleteCredentialOperations(): ProviderCredentialOperation[]
  credentialOperation(operationId: string): ProviderCredentialOperation | null
  stageCredentialReplace(input: { operationId: string; providerInstanceId: string; accountId: string; expectedInstanceRevision: number; expectedAccountRevision: number; stagedCredentialRef: string }): ProviderCredentialOperation
  bindStagedCredential(input: { operationId: string; providerInstanceId: string; accountId: string; expectedInstanceRevision: number; expectedAccountRevision: number; targetCredentialRef: string; targetBindingGeneration: number; expectedBindingGeneration: number }): boolean
  stageCredentialRevoke(input: { operationId: string; providerInstanceId: string; accountId: string; expectedInstanceRevision: number; expectedAccountRevision: number }): ProviderCredentialOperation
  closeCredentialOperation(input: { operationId: string; state: ProviderCredentialOperationState }): ProviderCredentialOperation
  retireCredentialBindingForOperation(input: UnbindCredentialInput & { credentialOperationId: string }): ProviderInstanceProjection
}

/**
 * The asynchronous credential-saga seam trusted main orchestration runs
 * against. The Catalog is daemon-owned, so main reaches it over the daemon
 * wire; the in-process SQLite authority is adapted to this shape instead.
 */
export interface ProviderCredentialCatalog extends Omit<ProviderCredentialOperations, 'credentialScope' | 'credentialBinding' | 'incompleteCredentialOperations' | 'credentialOperation' | 'stageCredentialReplace' | 'bindStagedCredential' | 'stageCredentialRevoke' | 'closeCredentialOperation' | 'retireCredentialBindingForOperation'> {
  snapshot(): Promise<ProviderCatalogSnapshot>
  credentialScope(providerInstanceId: string, accountId: string): Promise<{ driverId: AgentDriverId; instanceRevision: number; accountRevision: number }>
  credentialBinding(providerInstanceId: string, accountId: string): Promise<ProviderCredentialBinding | null>
  incompleteCredentialOperations(): Promise<readonly ProviderCredentialOperation[]>
  credentialOperation(operationId: string): Promise<ProviderCredentialOperation | null>
  stageCredentialReplace(input: { operationId: string; providerInstanceId: string; accountId: string; expectedInstanceRevision: number; expectedAccountRevision: number; stagedCredentialRef: string }): Promise<ProviderCredentialOperation>
  bindStagedCredential(input: { operationId: string; providerInstanceId: string; accountId: string; expectedInstanceRevision: number; expectedAccountRevision: number; targetCredentialRef: string; targetBindingGeneration: number; expectedBindingGeneration: number }): Promise<boolean>
  stageCredentialRevoke(input: { operationId: string; providerInstanceId: string; accountId: string; expectedInstanceRevision: number; expectedAccountRevision: number }): Promise<ProviderCredentialOperation>
  closeCredentialOperation(input: { operationId: string; state: ProviderCredentialOperationState }): Promise<ProviderCredentialOperation>
  retireCredentialBindingForOperation(input: UnbindCredentialInput & { credentialOperationId: string }): Promise<ProviderCatalogSnapshot>
}

/** One deterministic legacy-command migration entry; the catalog writes one instance per plan under Its computed id. */
export type MigratedLegacyCommandPlan = Readonly<{ id: string; driverId: AgentDriverId; command: ProviderCommandSpec; displayName: string }>

/**
 * The durable record of a completed one-time migration. Its existence is what
 * makes later startups no-ops: the instances and default it names are already
 * committed, so nothing is re-derived and no revision moves.
 */
export type MigrationLedgerRecord = Readonly<{ version: string; defaultInstanceId: string | null; instanceIds: readonly string[]; sourceSha256: string; receiptId: string; completedAt: string }>
export interface ProviderCatalog extends ProviderCredentialOperations { snapshot(): ProviderCatalogSnapshot; createAccount(input: { driverId: AgentDriverId; displayLabel: string }): ProviderAccount; updateAccount(input: { id: String; expectedRevision: number; displayLabel: string }): ProviderAccount; removeAccount(input: { id: String; expectedRevision: number }): void; create(input: ProviderInstanceInput): ProviderInstanceProjection; update(id: String, expectedRevision: number, input: ProviderInstanceInput): ProviderInstanceProjection; remove(id: String, expectedRevision: number): void; setDefault(id: String | null, expectedRevision: Number): ProviderCatalogSnapshot; completedMigration(): MigrationLedgerRecord | null; beginMigrationTransition(input: { preparedReceiptId: String; sourceSha256: string; intentSha256: string; plans: readonly MigratedLegacyCommandPlan[]; defaultInstanceId: String | null }): ProviderCatalogSnapshot; bindCredential(input: BindCredentialInput): ProviderInstanceProjection; prepareLaunch(input: PrepareProviderLaunchInput): ProviderLaunchPreparation }

/** The credential-saga wire decoders: opaque ids and revisions, never material. */
export function parseCredentialScope(value: unknown, label = 'credential scope'): { driverId: AgentDriverId; instanceRevision: number; accountRevision: number } {
  const record = wireRecord(value, label)
  wireOptionalKeys(record, ['driverId', 'instanceRevision', 'accountRevision'], ['driverId', 'instanceRevision', 'accountRevision'], label)
  return {
    driverId: parseAgentDriverId(record['driverId'], label + '.driverId'),
    instanceRevision: wireInteger(record['instanceRevision'], label + '.instanceRevision', 1),
    accountRevision: wireInteger(record['accountRevision'], label + '.accountRevision', 1)
  }
}

export function parseCredentialBinding(value: unknown, label = 'credential binding'): ProviderCredentialBinding {
  const record = wireRecord(value, label)
  wireOptionalKeys(record, ['driverId', 'providerInstanceId', 'instanceRevision', 'accountId', 'accountRevision', 'credentialRef', 'bindingGeneration'], ['driverId', 'providerInstanceId', 'instanceRevision', 'accountId', 'accountRevision', 'credentialRef', 'bindingGeneration'], label)
  return {
    driverId: parseAgentDriverId(record['driverId'], label + '.driverId'),
    providerInstanceId: wireString(record['providerInstanceId'], label + '.providerInstanceId', 128) as string,
    instanceRevision: wireInteger(record['instanceRevision'], label + '.instanceRevision', 1),
    accountId: wireString(record['accountId'], label + '.accountId', 128) as string,
    accountRevision: wireInteger(record['accountRevision'], label + '.accountRevision', 1),
    credentialRef: wireString(record['credentialRef'], label + '.credentialRef', 512) as string,
    bindingGeneration: wireInteger(record['bindingGeneration'], label + '.bindingGeneration', 1)
  }
}

export function parseCredentialOperation(value: unknown, label = 'credential operation'): ProviderCredentialOperation {
  const record = wireRecord(value, label)
  wireOptionalKeys(record, ['id', 'kind', 'state', 'providerInstanceId', 'instanceRevision', 'accountId', 'accountRevision', 'priorCredentialRef', 'priorBindingGeneration', 'stagedCredentialRef', 'targetBindingGeneration'], ['id', 'kind', 'state', 'providerInstanceId', 'instanceRevision', 'accountId', 'accountRevision', 'priorCredentialRef', 'priorBindingGeneration', 'stagedCredentialRef', 'targetBindingGeneration'], label)
  const nullableString = (key: string, maximum: number): string | null => record[key] === null ? null : wireString(record[key], `${label}.${key}`, maximum) as string
  const nullableInteger = (key: string, minimum: number): number | null => record[key] === null ? null : wireInteger(record[key], `${label}.${key}`, minimum)
  return {
    id: wireString(record['id'], label + '.id', 128) as string,
    kind: wireEnum(record['kind'], label + '.kind', PROVIDER_CREDENTIAL_OPERATION_KINDS),
    state: wireEnum(record['state'], label + '.state', PROVIDER_CREDENTIAL_OPERATION_STATES),
    providerInstanceId: nullableString('providerInstanceId', 128),
    instanceRevision: nullableInteger('instanceRevision', 1),
    accountId: nullableString('accountId', 128),
    accountRevision: nullableInteger('accountRevision', 1),
    priorCredentialRef: nullableString('priorCredentialRef', 512),
    priorBindingGeneration: nullableInteger('priorBindingGeneration', 1),
    stagedCredentialRef: nullableString('stagedCredentialRef', 512),
    targetBindingGeneration: nullableInteger('targetBindingGeneration', 1)
  }
}

/**
 * Catalog failures are a typed contract: the daemon maps `code` onto the wire,
 * so a caller never parses a message to learn what happened.
 *
 * `FOREIGN_KEY_CONFLICT` replaces an untyped SQLite foreign-key crash with an
 * explicit refusal; `INVALID_INPUT` covers a malformed catalog frame;
 * `PREPARATION_ACTIVE` refuses a removal while an unexpired launch preparation
 * still names the row.
 */
export const PROVIDER_CATALOG_ERROR_CODES = [
  'INSTANCE_NOT_FOUND',
  'INSTANCE_DISABLED',
  'INSTANCE_CHANGED',
  'ACCOUNT_CHANGED',
  'INSTANCE_HAS_CREDENTIAL',
  'ACCOUNT_NOT_FOUND',
  'ACCOUNT_MISMATCH',
  'ACCOUNT_HAS_CREDENTIAL',
  'DRIVER_UNAVAILABLE',
  'DRIVER_MODE_UNCERTIFIED',
  'COMMAND_NOT_ALLOWED',
  'CREDENTIAL_REQUIRED',
  'PREPARATION_NOT_FOUND',
  'TRANSITION_NOT_PREPARED',
  'MIGRATION_TRANSITION_CONFLICT',
  'PREPARATION_CONSUMED',
  'PREPARATION_ACTIVE',
  'CREDENTIAL_OPERATION_ACTIVE',
  'CREDENTIAL_OPERATION_NOT_FOUND',
  'CORRUPT_CATALOG',
  'FOREIGN_KEY_CONFLICT',
  'INVALID_INPUT'
] as const
export type ProviderCatalogErrorCode = (typeof PROVIDER_CATALOG_ERROR_CODES)[number]
export class ProviderCatalogError extends Error {
  constructor(readonly code: ProviderCatalogErrorCode, message: string) {
    super(message)
    this.name = 'ProviderCatalogError'
  }
}

export function isAgentDriverId(value: unknown): value is AgentDriverId {
  return typeof value === 'string' && (AGENT_PROVIDER_DRIVER_IDS as readonly string[]).includes(value)
}
export function parseAgentDriverId(value: unknown, label = 'driverId'): AgentDriverId {
  if (!isAgentDriverId(value)) throw new Error(`${label} must identify a known agent driver`)
  return value
}
export function isProviderCertificationPlatform(value: unknown): value is ProviderCertificationPlatform {
  return typeof value === 'string' && (PROVIDER_CERTIFICATION_PLATFORMS as readonly string[]).includes(value)
}
export function parseProviderCertificationPlatform(value: unknown, label = 'platform'): ProviderCertificationPlatform {
  if (!isProviderCertificationPlatform(value)) throw new Error(`${label} must be one of ${PROVIDER_CERTIFICATION_PLATFORMS.join(', ')}`)
  return value
}

function exactKeys(input: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed)
  const extra = Object.keys(input).find(key => !allowedSet.has(key))
  if (extra) throw new Error(`${label} contains unknown field: ${extra}`)
}

/**
 * The immutable attempt-scoped selection decoder. A selection names one exact
 * provider instance and (when it has one) one exact account at one exact
 * revision each, so a later catalog edit cannot silently retarget a recorded
 * attempt: the revisions stop matching and admission refuses.
 */
export function parseProviderSelection(value: unknown, label = 'provider selection'): ProviderSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const input = value as Record<string, unknown>
  exactKeys(input, ['driverId', 'providerInstanceId', 'instanceRevision', 'accountId', 'accountRevision'], label)
  const accountId = input['accountId']
  if (accountId !== null && (typeof accountId !== 'string' || accountId.length === 0 || accountId.length > 128 || accountId.includes('\0'))) {
    throw new Error(`${label}.accountId must be null or a bounded identifier`)
  }
  const accountRevision = input['accountRevision']
  if (accountRevision !== null && (!Number.isSafeInteger(accountRevision) || (accountRevision as number) < 1)) {
    throw new Error(`${label}.accountRevision must be null or a positive integer`)
  }
  if ((accountId === null) !== (accountRevision === null)) throw new Error(`${label} must name an account and its revision together`)
  if (typeof input['providerInstanceId'] !== 'string' || input['providerInstanceId'].length === 0 || input['providerInstanceId'].length > 128 || input['providerInstanceId'].includes('\0')) {
    throw new Error(`${label}.providerInstanceId must be a bounded identifier`)
  }
  if (!Number.isSafeInteger(input['instanceRevision']) || (input['instanceRevision'] as number) < 1) {
    throw new Error(`${label}.instanceRevision must be a positive integer`)
  }
  return {
    driverId: parseAgentDriverId(input['driverId'], `${label}.driverId`),
    providerInstanceId: input['providerInstanceId'],
    instanceRevision: input['instanceRevision'] as number,
    accountId: accountId as string | null,
    accountRevision: accountRevision as number | null
  }
}

/** Exact identity comparison; `revision` fields are numbers, never coerced strings. */
export function sameProviderSelection(left: ProviderSelection, right: ProviderSelection): boolean {
  return left.driverId === right.driverId
    && left.providerInstanceId === right.providerInstanceId
    && left.instanceRevision === right.instanceRevision
    && left.accountId === right.accountId
    && left.accountRevision === right.accountRevision
}

export function parseProviderCommandSpec(value: unknown): ProviderCommandSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider command')
  const input = value as Record<string, unknown>
  if (input['kind'] === 'driver') {
    exactKeys(input, ['kind', 'driverId'], 'provider command')
    return { kind: 'driver', driverId: parseAgentDriverId(input['driverId'], 'command.driverId') }
  }
  if (input['kind'] === 'external-argv') {
    exactKeys(input, ['kind', 'executable'], 'provider command')
    if (!input['executable'] || typeof input['executable'] !== 'object' || Array.isArray(input['executable'])) throw new Error('external argv requires executable')
    const launch = input['executable'] as Record<string, unknown>
    exactKeys(launch, ['executable', 'args'], 'external argv executable')
    if (typeof launch['executable'] !== 'string' || !Array.isArray(launch['args'])) throw new Error('Invalid external argv executable')
    if (launch['args'].length > 256 || launch['args'].some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Invalid external argv arguments')
    return { kind: 'external-argv', executable: { executable: launch['executable'], args: [...launch['args'] as string[]] } }
  }
  if (input['kind'] === 'external-shell') {
    exactKeys(input, ['kind', 'program'], 'provider command')
    if (typeof input['program'] === 'string' && input['program'].length > 0 && input['program'].length <= 16 * 1024 && !/[\0\r\n]/.test(input['program'])) return { kind: 'external-shell', program: input['program'] }
  }
  throw new Error('Invalid provider command')
}
export function parseProviderInstanceInput(value: unknown): ProviderInstanceInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider instance')
  const input = value as Record<string, unknown>
  exactKeys(input, ['id', 'driverId', 'displayName', 'command', 'credentialMode', 'accountId', 'enabled'], 'provider instance')
  if (input['id'] !== undefined && (typeof input['id'] !== 'string' || !input['id'] || input['id'].length > 128)) throw new Error('Invalid provider instance id')
  if (typeof input['driverId'] !== 'string' || !isAgentDriverId(input['driverId'])) throw new Error('Unknown provider driver')
  if (typeof input['displayName'] !== 'string' || !input['displayName'].trim() || input['displayName'].length > 256) throw new Error('Invalid provider display name')
  if (input['credentialMode'] !== 'external' && input['credentialMode'] !== 'managed' && input['credentialMode'] !== 'none') throw new Error('Invalid provider credential mode')
  if (typeof input['enabled'] !== 'boolean') throw new Error('Invalid provider enabled state')
  if (input['accountId'] !== null && typeof input['accountId'] !== 'string') throw new Error('Invalid provider account')
  return { ...(input['id'] === undefined ? {} : { id: input['id'] as string }), driverId: input['driverId'], displayName: input['displayName'].trim(), command: parseProviderCommandSpec(input['command']), credentialMode: input['credentialMode'], accountId: input['accountId'] as string | null, enabled: input['enabled'] }
}

// ---------------------------------------------------------------------------
// Sanitized projection decoding
//
// The snapshot crosses the daemon boundary into the renderer, so every field is
// checked by exact key (as the ACP wire decoders in agent-runtime do). Keys are
// compared by membership: a legitimate string such as a driver problem message
// that merely *mentions* a credential concept must not be mistaken for leaked
// material.

const FORBIDDEN_PROJECTION_KEYS: Record<string, true> = {
  credentialRef: true,
  bindingGeneration: true,
  credentialRevision: true,
  environment: true,
  authFile: true,
  authFilePath: true
}

type Wire = Record<string, unknown>

function wireRecord(value: unknown, label: string): Wire {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Wire
}
function wireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}
function wireOptionalKeys(value: Wire, allowed: readonly string[], required: readonly string[], label: string): void {
  exactKeys(value, allowed, label)
  const missing = required.find(key => !Object.hasOwn(value, key))
  if (missing) throw new Error(`${label} is missing field: ${missing}`)
}
function wireString(value: unknown, label: string, maximum: number, optional = false): string | undefined {
  if (optional && value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`)
  return value
}
function wireInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label} must be an integer of at least ${minimum}`)
  return value as number
}
function wireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`)
  return value
}
function wireEnum<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw new Error(`${label} must be one of ${allowed.join(', ')}`)
  return value as T
}
/**
 * Command specs are decoded strictly, except for a persisted instance's
 * driver-mode command that still names an unregistered driver: the catalog keeps
 * that instance as an unavailable projection, so refusing the id here would
 * reject the entire snapshot for every reader because of one legacy row.
 * Structure is still validated — only the id's registration is tolerated.
 */
function decodeCommand(value: unknown, label: string, tolerateUnknownDriver = false): ProviderCommandSpec {
  const spec = wireRecord(value, label)
  if (spec['kind'] === 'driver') {
    wireOptionalKeys(spec, ['kind', 'driverId'], ['kind', 'driverId'], label)
    const driverId = tolerateUnknownDriver ? wireString(spec['driverId'], label + '.driverId', 256) : parseAgentDriverId(spec['driverId'], label + '.driverId')
    return { kind: 'driver', driverId: driverId as AgentDriverId }
  }
  if (spec['kind'] === 'external-argv') {
    wireOptionalKeys(spec, ['kind', 'executable'], ['kind', 'executable'], label)
    const launch = wireRecord(spec['executable'], label + '.executable')
    wireOptionalKeys(launch, ['executable', 'args'], ['executable', 'args'], label + '.executable')
    return { kind: 'external-argv', executable: { executable: wireString(launch['executable'], label + '.executable.executable', 4_096) as string, args: wireArray(launch['args'], label + '.executable.args').map((arg, index) => wireString(arg, `${label}.executable.args[${index}]`, 4_096) as string) } }
  }
  if (spec['kind'] === 'external-shell') {
    wireOptionalKeys(spec, ['kind', 'program'], ['kind', 'program'], label)
    return { kind: 'external-shell', program: wireString(spec['program'], label + '.program', 16 * 1024) as string }
  }
  throw new Error(`${label}.kind must be a known provider command kind`)
}
function decodeHooks(value: unknown, label: string): AgentHookSupport {
  const hooks = wireRecord(value, label)
  if (hooks['support'] === 'native') {
    wireOptionalKeys(hooks, ['support', 'adapter', 'events', 'documentationUrl'], ['support', 'adapter', 'events', 'documentationUrl'], label)
    return {
      support: 'native',
      adapter: wireEnum(hooks['adapter'], label + '.adapter', ['codex-hooks', 'claude-hooks', 'opencode-plugin'] as const),
      events: wireArray(hooks['events'], label + '.events').map((event, index) => wireEnum(event, `${label}.events[${index}]`, ['working', 'waiting', 'permission', 'completed', 'failed'] as const)),
      documentationUrl: wireString(hooks['documentationUrl'], label + '.documentationUrl', 8_192) as string
    }
  }
  wireOptionalKeys(hooks, ['support', 'events', 'reason'], ['support', 'events', 'reason'], label)
  return {
    support: 'unavailable',
    events: wireArray(hooks['events'], label + '.events').map((event, index) => wireEnum(event, `${label}.events[${index}]`, ['working', 'waiting', 'permission', 'completed', 'failed'] as const)),
    reason: wireString(hooks['reason'], label + '.reason', 8_192) as string
  }
}
function decodeSkills(value: unknown, label: string): AgentSkillConsumer {
  const skills = wireRecord(value, label)
  if (skills['supported'] === true) {
    wireOptionalKeys(skills, ['supported', 'root', 'discovery'], ['supported', 'root', 'discovery'], label)
    return { supported: true, root: wireString(skills['root'], label + '.root', 4_096) as string, discovery: wireEnum(skills['discovery'], label + '.discovery', ['native'] as const) }
  }
  wireOptionalKeys(skills, ['supported', 'reason'], ['supported', 'reason'], label)
  if (skills['supported'] !== false) throw new Error(`${label}.supported must be a boolean`)
  return { supported: false, reason: wireString(skills['reason'], label + '.reason', 8_192) as string }
}
function decodeManagedSupport(value: unknown, label: string): ProviderManagedSupport {
  const support = wireRecord(value, label)
  if (support['kind'] === 'certified') {
    wireOptionalKeys(support, ['kind', 'modes', 'supportedVersionRange', 'platform', 'architecture'], ['kind', 'modes', 'supportedVersionRange', 'platform', 'architecture'], label)
    const modes = wireArray(support['modes'], label + '.modes').map((mode, index) => wireEnum(mode, `${label}.modes[${index}]`, ['managed', 'none'] as const))
    return {
      kind: 'certified',
      modes,
      supportedVersionRange: wireString(support['supportedVersionRange'], label + '.supportedVersionRange', 256) as string,
      platform: parseProviderCertificationPlatform(support['platform'], label + '.platform'),
      architecture: wireString(support['architecture'], label + '.architecture', 64) as string
    }
  }
  wireOptionalKeys(support, ['kind', 'reason'], ['kind', 'reason'], label)
  if (support['kind'] !== 'unsupported') throw new Error(`${label}.kind must be a known managed-support kind`)
  return { kind: 'unsupported', reason: wireString(support['reason'], label + '.reason', 8_192) as string }
}
function decodeAccount(value: unknown, label: string): ProviderAccount {
  const account = wireRecord(value, label)
  wireOptionalKeys(account, ['id', 'driverId', 'displayLabel', 'verifiedSubject', 'revision'], ['id', 'driverId', 'displayLabel', 'revision'], label)
  const verifiedSubject = wireString(account['verifiedSubject'], label + '.verifiedSubject', 512, true)
  return {
    id: wireString(account['id'], label + '.id', 128) as string,
    driverId: parseAgentDriverId(account['driverId'], label + '.driverId'),
    displayLabel: wireString(account['displayLabel'], label + '.displayLabel', 256) as string,
    ...(verifiedSubject === undefined ? {} : { verifiedSubject }),
    revision: wireInteger(account['revision'], label + '.revision', 1)
  }
}
function decodeDriver(value: unknown, label: string): ProviderDriverProjection {
  const driver = wireRecord(value, label)
  if (driver['kind'] === 'unknown') {
    wireOptionalKeys(driver, ['kind', 'rawDriverId', 'availability', 'problem'], ['kind', 'rawDriverId', 'availability', 'problem'], label)
    return {
      kind: 'unknown',
      rawDriverId: wireString(driver['rawDriverId'], label + '.rawDriverId', 256) as string,
      availability: wireEnum(driver['availability'], label + '.availability', ['unavailable'] as const),
      problem: wireString(driver['problem'], label + '.problem', 8_192) as string
    }
  }
  wireOptionalKeys(driver, ['kind', 'id', 'displayName', 'installed', 'executable', 'hooks', 'skills', 'memorySupport', 'credentialModes', 'managedSupport', 'problem'], ['kind', 'id', 'displayName', 'installed', 'hooks', 'skills', 'memorySupport', 'credentialModes', 'managedSupport'], label)
  if (driver['kind'] !== 'known') throw new Error(`${label}.kind must be a known driver kind`)
  const executable = wireString(driver['executable'], label + '.executable', 4_096, true)
  const problem = wireString(driver['problem'], label + '.problem', 8_192, true)
  return {
    kind: 'known',
    id: parseAgentDriverId(driver['id'], label + '.id'),
    displayName: wireString(driver['displayName'], label + '.displayName', 256) as string,
    installed: wireBoolean(driver['installed'], label + '.installed'),
    ...(executable === undefined ? {} : { executable }),
    hooks: decodeHooks(driver['hooks'], label + '.hooks'),
    skills: decodeSkills(driver['skills'], label + '.skills'),
    memorySupport: wireEnum(driver['memorySupport'], label + '.memorySupport', ['direct', 'acp', 'none'] as const),
    credentialModes: wireArray(driver['credentialModes'], label + '.credentialModes').map((mode, index) => wireEnum(mode, `${label}.credentialModes[${index}]`, PROVIDER_CREDENTIAL_MODES)),
    managedSupport: decodeManagedSupport(driver['managedSupport'], label + '.managedSupport'),
    ...(problem === undefined ? {} : { problem })
  }
}
function decodeInstance(value: unknown, label: string): ProviderInstanceProjection {
  const instance = wireRecord(value, label)
  wireOptionalKeys(instance, ['id', 'driver', 'displayName', 'command', 'credentialMode', 'account', 'enabled', 'revision', 'availability', 'problem'], ['id', 'driver', 'displayName', 'command', 'credentialMode', 'account', 'enabled', 'revision', 'availability'], label)
  const driver = decodeDriver(instance['driver'], label + '.driver')
  const problem = wireString(instance['problem'], label + '.problem', 8_192, true)
  // An unavailable instance may still carry an unregistered driver id, so its
  // driver-mode command tolerates exactly that; every other command stays strict.
  const unavailableDriver = driver.kind === 'unknown'
  return {
    id: wireString(instance['id'], label + '.id', 128) as string,
    driver,
    displayName: wireString(instance['displayName'], label + '.displayName', 256) as string,
    command: decodeCommand(instance['command'], label + '.command', unavailableDriver),
    credentialMode: wireEnum(instance['credentialMode'], label + '.credentialMode', PROVIDER_CREDENTIAL_MODES),
    account: instance['account'] === null ? null : decodeAccount(instance['account'], label + '.account'),
    enabled: wireBoolean(instance['enabled'], label + '.enabled'),
    revision: wireInteger(instance['revision'], label + '.revision', 1),
    availability: wireEnum(instance['availability'], label + '.availability', ['available', 'unavailable'] as const),
    ...(problem === undefined ? {} : { problem })
  }
}

export function parseProviderCatalogSnapshot(value: unknown): ProviderCatalogSnapshot {
  const snapshot = wireRecord(value, 'provider catalog snapshot')
  wireOptionalKeys(snapshot, ['revision', 'defaultInstanceId', 'drivers', 'accounts', 'instances'], ['revision', 'defaultInstanceId', 'drivers', 'accounts', 'instances'], 'provider catalog snapshot')
  const defaultInstanceId = snapshot['defaultInstanceId'] === null ? null : wireString(snapshot['defaultInstanceId'], 'provider catalog snapshot.defaultInstanceId', 128) as string
  assertNoCredentialKeys(snapshot, 'provider catalog snapshot')
  return {
    revision: wireInteger(snapshot['revision'], 'provider catalog snapshot.revision', 1),
    defaultInstanceId,
    drivers: wireArray(snapshot['drivers'], 'provider catalog snapshot.drivers').map((driver, index) => decodeDriver(driver, `provider catalog snapshot.drivers[${index}]`)),
    accounts: wireArray(snapshot['accounts'], 'provider catalog snapshot.accounts').map((account, index) => decodeAccount(account, `provider catalog snapshot.accounts[${index}]`)),
    instances: wireArray(snapshot['instances'], 'provider catalog snapshot.instances').map((instance, index) => decodeInstance(instance, `provider catalog snapshot.instances[${index}]`))
  }
}

/** Key-membership scan: a credential key is refused wherever it appears. */
function assertNoCredentialKeys(value: unknown, label: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoCredentialKeys(entry, `${label}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, entry] of Object.entries(value)) {
    if (Object.hasOwn(FORBIDDEN_PROJECTION_KEYS, key)) throw new Error(`${label} contains credential field: ${key}`)
    assertNoCredentialKeys(entry, `${label}.${key}`)
  }
}
