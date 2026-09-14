import { AGENT_PROVIDER_DRIVER_IDS, type AgentDriverId, type ProviderCatalogSnapshot } from './provider-authority'

/**
 * Versioned reverse-request broker between the daemon (which owns launch
 * admission) and the Electron main process (which owns credential material).
 *
 * The daemon is the only side that creates materialization request IDs and the
 * only side that assigns a connection epoch; main answers exactly one
 * schema-validated response per request. Nothing here is renderer authority:
 * credential references, binding generations, launch authorizations, and
 * materialized environments never cross the IPC boundary.
 */
export const PROVIDER_SECRET_BROKER_PROTOCOL = 'provider-secret-broker-v1'

/** Daemon transport capability that activates the reverse-request broker. */
export const PROVIDER_SECRET_BROKER_CAPABILITY = PROVIDER_SECRET_BROKER_PROTOCOL

/** Upper bound for one materialization round trip, counted from daemon issue. */
export const PROVIDER_SECRET_BROKER_DEADLINE_MS = 5_000

/** Upper bound for one credential value, in UTF-8 bytes. */
export const PROVIDER_SECRET_MAX_BYTES = 4_096

/** Opaque, random handle for one protected credential record. Never rendered. */
export type CredentialRef = string & { readonly __credentialRef: unique symbol }

export function isCredentialRef(value: unknown): value is CredentialRef {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0')
}

export function asCredentialRef(value: unknown, label = 'credentialRef'): CredentialRef {
  if (!isCredentialRef(value)) throw new Error(`${label} must be an opaque credential reference`)
  return value
}

export type CredentialState = 'present' | 'absent' | 'revoked' | 'unavailable'
export type CredentialBackend = 'keychain' | 'dpapi' | 'secret-service' | 'unprotected' | 'unavailable'

/** Renderer-safe credential status. Its revision is display state, not launch authority. */
export type CredentialStatus = {
  state: CredentialState
  revision: number
  backend: CredentialBackend
  updatedAt: string
  problem?: string
}

/** Renderer-safe request to create or replace one instance/account credential. */
export type ProviderCredentialWriteRequest = {
  providerInstanceId: string
  accountId: string
  expectedInstanceRevision: number
  expectedAccountRevision: number
  secret: string
}

/** Renderer-safe request for the current status of one instance/account credential. */
export type ProviderCredentialStatusRequest = { providerInstanceId: string; accountId: string }

/** Renderer-safe request to revoke one instance/account credential. */
export type ProviderCredentialRevokeRequest = ProviderCredentialStatusRequest & {
  expectedInstanceRevision: number
  expectedAccountRevision: number
}

/** The sanitized catalog plus status pair each provider credential call returns. */
export type ProviderCredentialResult = { snapshot: ProviderCatalogSnapshot; status: CredentialStatus }

/**
 * The principal a trusted main-process path resolved from the Catalog. It never
 * originates in the renderer and it carries the exact revisions and binding
 * generation the operation must authenticate against.
 */
export type ResolvedProviderCredentialPrincipal = {
  driverId: AgentDriverId
  providerInstanceId: string
  instanceRevision: number
  accountId: string
  accountRevision: number
  credentialRef: CredentialRef
  bindingGeneration: number
}

export type ResolvedProviderCredentialWrite = {
  operationId: string
  principal: ResolvedProviderCredentialPrincipal
  secret: string
}

export type ResolvedProviderCredentialStatus = { principal: ResolvedProviderCredentialPrincipal }
export type ResolvedProviderCredentialRevoke = { principal: ResolvedProviderCredentialPrincipal }

/** One exact launch admission. Every field is cross-checked against the record. */
export type ProviderLaunchAuthorization = {
  launchAdmissionId: string
  preparationId: string
  attemptId: string
  sessionId: string
  purpose: 'agent-launch'
  driverId: AgentDriverId
  providerInstanceId: string
  instanceRevision: number
  accountId: string
  accountRevision: number
  credentialRef: CredentialRef
  bindingGeneration: number
}

export type ProviderLaunchSecrets = {
  environment: Readonly<Record<string, string>>
  credentialRevision: number
}

export const SECRET_AUTHORITY_ERROR_CODES = [
  'INSTANCE_MISMATCH',
  'ACCOUNT_MISMATCH',
  'BINDING_CHANGED',
  'CREDENTIAL_ABSENT',
  'CREDENTIAL_REVOKED',
  'BACKEND_UNAVAILABLE',
  'BACKEND_UNPROTECTED',
  'AUTHORIZATION_INVALID',
  'AUTHORIZATION_EXPIRED',
  'CORRUPT_SECRET_STORE'
] as const
export type SecretAuthorityErrorCode = (typeof SECRET_AUTHORITY_ERROR_CODES)[number]

export class SecretAuthorityError extends Error {
  constructor(readonly code: SecretAuthorityErrorCode, message: string) {
    super(message)
    this.name = 'SecretAuthorityError'
  }
}

export interface SecretAuthority {
  reserveProviderCredentialRef(): CredentialRef
  putProviderCredential(input: ResolvedProviderCredentialWrite): Promise<CredentialStatus>
  inspectProviderCredential(input: ResolvedProviderCredentialStatus): Promise<CredentialStatus>
  materializeProviderLaunch(input: ProviderLaunchAuthorization): Promise<ProviderLaunchSecrets>
  revokeProviderCredential(input: ResolvedProviderCredentialRevoke): Promise<CredentialStatus>
}

export type SecretBrokerMaterializeRequest = {
  protocol: typeof PROVIDER_SECRET_BROKER_PROTOCOL
  requestId: string
  connectionEpoch: string
  deadline: string
  authorization: ProviderLaunchAuthorization
}

export type SecretBrokerMaterializeResponse =
  | { requestId: string; connectionEpoch: string; ok: true; secrets: ProviderLaunchSecrets }
  | { requestId: string; connectionEpoch: string; ok: false; error: SecretAuthorityErrorCode }

/**
 * Driver-declared credential environment: for each driver, the exact environment
 * variables a managed credential may be materialized into. This is reviewed
 * static evidence beside the certification matrix, not a user setting — no
 * built-in driver is certified, so the shipped table is empty and every managed
 * materialization fails closed until a driver is reviewed into it.
 */
export type ProviderCredentialEnvironment = Readonly<Record<string, readonly string[]>>

export const PROVIDER_CREDENTIAL_ENVIRONMENTS: ProviderCredentialEnvironment = {}

/** Parses a driver-environment declaration; an unknown driver or bad name is refused. */
export function parseProviderCredentialEnvironment(value: unknown, label = 'credential environment'): ProviderCredentialEnvironment {
  const record = wireRecord(value, label)
  const parsed: Record<string, readonly string[]> = {}
  for (const [driverId, names] of Object.entries(record)) {
    if (!(AGENT_PROVIDER_DRIVER_IDS as readonly string[]).includes(driverId)) throw new Error(`${label} names an unknown driver: ${driverId}`)
    if (!Array.isArray(names) || names.length === 0 || names.length > 4) throw new Error(`${label}.${driverId} must declare between one and four variables`)
    const unique: string[] = []
    for (const name of names) {
      if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) throw new Error(`${label}.${driverId} declares an invalid variable name`)
      if (unique.includes(name)) throw new Error(`${label}.${driverId} repeats a variable name`)
      unique.push(name)
    }
    parsed[driverId] = unique
  }
  return parsed
}

// ---------------------------------------------------------------------------
// Parsing
//
// Every crossing frame is decoded field by field against an exact key set, so a
// malformed, extended, or foreign frame is refused instead of partially read.
// ---------------------------------------------------------------------------

type Wire = Record<string, unknown>

function wireRecord(value: unknown, label: string): Wire {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Wire
}

function wireExact(value: Wire, allowed: readonly string[], label: string): void {
  const known = new Set(allowed)
  const extra = Object.keys(value).find(key => !known.has(key))
  if (extra) throw new Error(`${label} contains unknown field: ${extra}`)
}

function wireString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`)
  return value
}

function wireInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label} must be an integer of at least ${minimum}`)
  return value as number
}

function wireDriverId(value: unknown, label: string): AgentDriverId {
  if (typeof value !== 'string') throw new Error(`${label} must be a known agent driver`)
  // The driver id is validated against the registry by the caller that owns the
  // registry; here it is only required to be a bounded opaque identity.
  return wireString(value, label, 256) as AgentDriverId
}

function wireTimestamp(value: unknown, label: string): string {
  const text = wireString(value, label, 64)
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text) || !Number.isFinite(Date.parse(text))) throw new Error(`${label} must be an ISO timestamp with timezone`)
  return text
}

/**
 * A credential value must be usable as an environment value: non-empty, bounded,
 * and free of every C0 control and DEL.
 */
export function parseProviderSecret(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Credential must be a non-empty value')
  if (value.length > PROVIDER_SECRET_MAX_BYTES) throw new Error(`Credential must be at most ${PROVIDER_SECRET_MAX_BYTES} characters`)
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('Credential must not contain control characters')
  if (Buffer.byteLength(value, 'utf8') > PROVIDER_SECRET_MAX_BYTES) throw new Error(`Credential must be at most ${PROVIDER_SECRET_MAX_BYTES} bytes`)
  return value
}

export function parseCredentialStatus(value: unknown, label = 'credential status'): CredentialStatus {
  const record = wireRecord(value, label)
  wireExact(record, ['state', 'revision', 'backend', 'updatedAt', 'problem'], label)
  const state = record['state']
  if (state !== 'present' && state !== 'absent' && state !== 'revoked' && state !== 'unavailable') throw new Error(`${label}.state must be a known credential state`)
  const backend = record['backend']
  if (backend !== 'keychain' && backend !== 'dpapi' && backend !== 'secret-service' && backend !== 'unprotected' && backend !== 'unavailable') throw new Error(`${label}.backend must be a known credential backend`)
  const problem = record['problem'] === undefined ? undefined : wireString(record['problem'], `${label}.problem`, 512)
  return {
    state,
    revision: wireInteger(record['revision'], `${label}.revision`),
    backend,
    updatedAt: wireTimestamp(record['updatedAt'], `${label}.updatedAt`),
    ...(problem === undefined ? {} : { problem })
  }
}

export function parseProviderCredentialWriteRequest(value: unknown, label = 'credential write request'): ProviderCredentialWriteRequest {
  const record = wireRecord(value, label)
  wireExact(record, ['providerInstanceId', 'accountId', 'expectedInstanceRevision', 'expectedAccountRevision', 'secret'], label)
  return {
    providerInstanceId: wireString(record['providerInstanceId'], `${label}.providerInstanceId`, 128),
    accountId: wireString(record['accountId'], `${label}.accountId`, 128),
    expectedInstanceRevision: wireInteger(record['expectedInstanceRevision'], `${label}.expectedInstanceRevision`, 1),
    expectedAccountRevision: wireInteger(record['expectedAccountRevision'], `${label}.expectedAccountRevision`, 1),
    secret: parseProviderSecret(record['secret'])
  }
}

export function parseProviderCredentialStatusRequest(value: unknown, label = 'credential status request'): ProviderCredentialStatusRequest {
  const record = wireRecord(value, label)
  wireExact(record, ['providerInstanceId', 'accountId'], label)
  return {
    providerInstanceId: wireString(record['providerInstanceId'], `${label}.providerInstanceId`, 128),
    accountId: wireString(record['accountId'], `${label}.accountId`, 128)
  }
}

export function parseProviderCredentialRevokeRequest(value: unknown, label = 'credential revoke request'): ProviderCredentialRevokeRequest {
  const record = wireRecord(value, label)
  wireExact(record, ['providerInstanceId', 'accountId', 'expectedInstanceRevision', 'expectedAccountRevision'], label)
  return {
    ...parseProviderCredentialStatusRequest(value, label),
    expectedInstanceRevision: wireInteger(record['expectedInstanceRevision'], `${label}.expectedInstanceRevision`, 1),
    expectedAccountRevision: wireInteger(record['expectedAccountRevision'], `${label}.expectedAccountRevision`, 1)
  }
}

export function parseResolvedProviderCredentialPrincipal(value: unknown, label = 'credential principal'): ResolvedProviderCredentialPrincipal {
  const record = wireRecord(value, label)
  wireExact(record, ['driverId', 'providerInstanceId', 'instanceRevision', 'accountId', 'accountRevision', 'credentialRef', 'bindingGeneration'], label)
  return {
    driverId: wireDriverId(record['driverId'], `${label}.driverId`),
    providerInstanceId: wireString(record['providerInstanceId'], `${label}.providerInstanceId`, 128),
    instanceRevision: wireInteger(record['instanceRevision'], `${label}.instanceRevision`, 1),
    accountId: wireString(record['accountId'], `${label}.accountId`, 128),
    accountRevision: wireInteger(record['accountRevision'], `${label}.accountRevision`, 1),
    credentialRef: asCredentialRef(record['credentialRef'], `${label}.credentialRef`),
    bindingGeneration: wireInteger(record['bindingGeneration'], `${label}.bindingGeneration`, 1)
  }
}

export function parseProviderLaunchAuthorization(value: unknown, label = 'launch authorization'): ProviderLaunchAuthorization {
  const record = wireRecord(value, label)
  wireExact(record, ['launchAdmissionId', 'preparationId', 'attemptId', 'sessionId', 'purpose', 'driverId', 'providerInstanceId', 'instanceRevision', 'accountId', 'accountRevision', 'credentialRef', 'bindingGeneration'], label)
  if (record['purpose'] !== 'agent-launch') throw new Error(`${label}.purpose must be agent-launch`)
  return {
    launchAdmissionId: wireString(record['launchAdmissionId'], `${label}.launchAdmissionId`, 128),
    preparationId: wireString(record['preparationId'], `${label}.preparationId`, 128),
    attemptId: wireString(record['attemptId'], `${label}.attemptId`, 128),
    sessionId: wireString(record['sessionId'], `${label}.sessionId`, 128),
    purpose: 'agent-launch',
    driverId: wireDriverId(record['driverId'], `${label}.driverId`),
    providerInstanceId: wireString(record['providerInstanceId'], `${label}.providerInstanceId`, 128),
    instanceRevision: wireInteger(record['instanceRevision'], `${label}.instanceRevision`, 1),
    accountId: wireString(record['accountId'], `${label}.accountId`, 128),
    accountRevision: wireInteger(record['accountRevision'], `${label}.accountRevision`, 1),
    credentialRef: asCredentialRef(record['credentialRef'], `${label}.credentialRef`),
    bindingGeneration: wireInteger(record['bindingGeneration'], `${label}.bindingGeneration`, 1)
  }
}

export function parseProviderLaunchSecrets(value: unknown, label = 'launch secrets'): ProviderLaunchSecrets {
  const record = wireRecord(value, label)
  wireExact(record, ['environment', 'credentialRevision'], label)
  const environment = wireRecord(record['environment'], `${label}.environment`)
  const entries = Object.entries(environment)
  if (entries.length === 0 || entries.length > 8) throw new Error(`${label}.environment must carry between one and eight entries`)
  const parsed: Record<string, string> = {}
  for (const [name, secret] of entries) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) throw new Error(`${label}.environment contains an invalid variable name`)
    if (Object.hasOwn(parsed, name)) throw new Error(`${label}.environment repeats a variable name`)
    parsed[name] = parseProviderSecret(secret)
  }
  return { environment: parsed, credentialRevision: wireInteger(record['credentialRevision'], `${label}.credentialRevision`, 1) }
}

export function parseSecretBrokerMaterializeRequest(value: unknown): SecretBrokerMaterializeRequest {
  const record = wireRecord(value, 'materialize request')
  wireExact(record, ['protocol', 'requestId', 'connectionEpoch', 'deadline', 'authorization'], 'materialize request')
  const protocol = record['protocol']
  if (protocol !== PROVIDER_SECRET_BROKER_PROTOCOL) throw new Error('materialize request.protocol must be ' + PROVIDER_SECRET_BROKER_PROTOCOL)
  return {
    protocol,
    requestId: wireString(record['requestId'], 'materialize request.requestId', 128),
    connectionEpoch: wireString(record['connectionEpoch'], 'materialize request.connectionEpoch', 128),
    deadline: wireTimestamp(record['deadline'], 'materialize request.deadline'),
    authorization: parseProviderLaunchAuthorization(record['authorization'], 'materialize request.authorization')
  }
}

export function parseSecretBrokerMaterializeResponse(value: unknown): SecretBrokerMaterializeResponse {
  const record = wireRecord(value, 'materialize response')
  // `id` and `op` are the transport envelope this frame travels in; every other
  // field is exact, so an extended or foreign body is still refused.
  wireExact(record, ['id', 'op', 'requestId', 'connectionEpoch', 'ok', 'error', 'secrets'], 'materialize response')
  const requestId = wireString(record['requestId'], 'materialize response.requestId', 128)
  const connectionEpoch = wireString(record['connectionEpoch'], 'materialize response.connectionEpoch', 128)
  if (record['ok'] === true) {
    if (record['error'] !== undefined) throw new Error('materialize response cannot carry both a result and an error')
    if (record['secrets'] === undefined) throw new Error('materialize response is missing secrets')
    return { requestId, connectionEpoch, ok: true, secrets: parseProviderLaunchSecrets(record['secrets'], 'materialize response.secrets') }
  }
  if (record['ok'] !== false) throw new Error('materialize response.ok must be a boolean')
  if (record['secrets'] !== undefined) throw new Error('materialize response cannot carry both a result and an error')
  const error = record['error']
  if (typeof error !== 'string' || !(SECRET_AUTHORITY_ERROR_CODES as readonly string[]).includes(error)) throw new Error('materialize response.error must be a known secret authority code')
  return { requestId, connectionEpoch, ok: false, error: error as SecretAuthorityErrorCode }
}
