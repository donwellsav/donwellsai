import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { safeStorage } from 'electron'
import type { ProviderCredentialEnvironment } from '@shared/provider-secret-broker'
import type { ProviderCatalog, ProviderCredentialBinding, ProviderCredentialOperation } from '@shared/provider-authority'
import {
  PROVIDER_CREDENTIAL_ENVIRONMENTS,
  SecretAuthorityError,
  asCredentialRef,
  parseProviderSecret,
  type CredentialBackend,
  type CredentialRef,
  type CredentialStatus,
  type ProviderCredentialResult,
  type ProviderCredentialRevokeRequest,
  type ProviderCredentialStatusRequest,
  type ProviderCredentialWriteRequest,
  type ProviderLaunchAuthorization,
  type ProviderLaunchSecrets,
  type ResolvedProviderCredentialPrincipal,
  type ResolvedProviderCredentialRevoke,
  type ResolvedProviderCredentialStatus,
  type ResolvedProviderCredentialWrite,
  type SecretAuthority,
  type SecretAuthorityErrorCode
} from '@shared/provider-secret-broker'

/**
 * Electron `safeStorage` async adapter. Injected so tests can drive backend
 * classification, key rotation, and refusal without a real OS keychain.
 */
export type ProviderSecretEncryption = {
  available(): Promise<boolean>
  backend(): CredentialBackend
  encrypt(plaintext: string): Promise<Buffer>
  decrypt(ciphertext: Buffer): Promise<{ plaintext: string; shouldReEncrypt: boolean }>
}

/**
 * Linux `basic_text` is reversible local obfuscation, not encryption, so it is
 * reported as `unprotected` and refuses every managed operation. Only the async
 * API is used: the synchronous one can block on a locked keyring.
 */
function electronBackend(): CredentialBackend {
  if (process.platform === 'darwin') return 'keychain'
  if (process.platform === 'win32') return 'dpapi'
  if (process.platform !== 'linux') return 'unavailable'
  const selected = safeStorage.getSelectedStorageBackend()
  return selected === 'basic_text' || selected === 'unknown' ? 'unprotected' : 'secret-service'
}

export function electronProviderSecretEncryption(): ProviderSecretEncryption {
  return {
    available: async () => {
      try {
        return await safeStorage.isAsyncEncryptionAvailable()
      } catch {
        return false
      }
    },
    backend: electronBackend,
    encrypt: plaintext => safeStorage.encryptStringAsync(plaintext),
    decrypt: async (ciphertext) => {
      const result = await safeStorage.decryptStringAsync(ciphertext)
      return { plaintext: result.result, shouldReEncrypt: result.shouldReEncrypt }
    }
  }
}

const STORE_VERSION = 1
const STORE_FILE = 'provider-secrets.enc.json'
const FORMAT_VERSION = 1
const MAX_STORE_BYTES = 4 * 1024 * 1024
const MAX_CIPHERTEXT_BYTES = 64 * 1024
const STORE_KEYS = ['version', 'revision', 'records']
const RECORD_KEYS = ['credentialRef', 'ciphertext', 'formatVersion', 'operationId', 'driverId', 'providerInstanceId', 'instanceRevision', 'accountId', 'accountRevision', 'bindingGeneration', 'credentialRevision', 'backend', 'updatedAt', 'revokedAt']
const PAYLOAD_KEYS = ['formatVersion', 'credentialRef', 'operationId', 'driverId', 'providerInstanceId', 'instanceRevision', 'accountId', 'accountRevision', 'bindingGeneration', 'credentialRevision', 'secret']

/** Durable cleartext metadata: never sufficient on its own to decrypt or retarget. */
type StoredCredential = {
  /** The ref is repeated here so a record copied to another key is detected. */
  credentialRef: string
  ciphertext: string | null
  formatVersion: number
  operationId: string
  driverId: string
  providerInstanceId: string
  instanceRevision: number
  accountId: string
  accountRevision: number
  bindingGeneration: number
  credentialRevision: number
  backend: CredentialBackend
  updatedAt: string
  revokedAt: string | null
}

type StoredStore = { version: number; revision: number; records: Record<string, StoredCredential> }

/**
 * The authenticated payload. Its tuple is compared against both the durable
 * cleartext metadata and the launch authorization, so copying ciphertext or
 * metadata between records can never retarget a credential.
 */
type AuthenticatedCredential = {
  formatVersion: number
  credentialRef: string
  operationId: string
  driverId: string
  providerInstanceId: string
  instanceRevision: number
  accountId: string
  accountRevision: number
  bindingGeneration: number
  credentialRevision: number
  secret: string
}

type CredentialTuple = Pick<AuthenticatedCredential, 'credentialRef' | 'driverId' | 'providerInstanceId' | 'instanceRevision' | 'accountId' | 'accountRevision' | 'bindingGeneration'>

export type ProviderSecretAuthorityOptions = Readonly<{
  userDataDir: string
  encryption?: ProviderSecretEncryption
  /** Driver-declared credential environment; empty until a driver is reviewed. */
  credentialEnvironments?: ProviderCredentialEnvironment
  now?: () => Date
}>

function fail(code: SecretAuthorityErrorCode, detail: string): never {
  throw new SecretAuthorityError(code, detail)
}

function readInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label} is invalid`)
  return value as number
}

function readString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) throw new Error(`${label} is invalid`)
  return value
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extra = Object.keys(value).find(key => !allowed.includes(key))
  if (extra) throw new Error(`${label} contains unknown field: ${extra}`)
}

function readBackend(value: unknown, label: string): CredentialBackend {
  if (value !== 'keychain' && value !== 'dpapi' && value !== 'secret-service' && value !== 'unprotected' && value !== 'unavailable') throw new Error(`${label} is invalid`)
  return value
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200)
}

/**
 * Field-by-field tuple comparison. It is the single predicate used both when
 * sealing and when materializing, so no caller can weaken the cross-check.
 */
function sameTuple(left: CredentialTuple, right: CredentialTuple): boolean {
  return left.credentialRef === right.credentialRef
    && left.driverId === right.driverId
    && left.providerInstanceId === right.providerInstanceId
    && left.instanceRevision === right.instanceRevision
    && left.accountId === right.accountId
    && left.accountRevision === right.accountRevision
    && left.bindingGeneration === right.bindingGeneration
}

/** Decodes one durable record, refusing any extended or malformed shape. */
function decodeStored(value: unknown, label: string): StoredCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid`)
  const record = value as Record<string, unknown>
  exactKeys(record, RECORD_KEYS, label)
  const ciphertext = record['ciphertext'] === null ? null : readString(record['ciphertext'], `${label}.ciphertext`, 4 * MAX_CIPHERTEXT_BYTES)
  if (ciphertext !== null && (ciphertext.length % 4 !== 0 || Buffer.from(ciphertext, 'base64').toString('base64') !== ciphertext)) throw new Error(`${label}.ciphertext is not base64`)
  const revokedAt = record['revokedAt'] === null ? null : readString(record['revokedAt'], `${label}.revokedAt`, 64)
  const recordFormat = readInteger(record['formatVersion'], `${label}.formatVersion`, 1)
  if (recordFormat !== FORMAT_VERSION) throw new Error(`${label}.formatVersion is unsupported`)
  return {
    credentialRef: asCredentialRef(record['credentialRef'], `${label}.credentialRef`),
    ciphertext,
    formatVersion: recordFormat,
    operationId: readString(record['operationId'], `${label}.operationId`, 128),
    driverId: readString(record['driverId'], `${label}.driverId`, 256),
    providerInstanceId: readString(record['providerInstanceId'], `${label}.providerInstanceId`, 128),
    instanceRevision: readInteger(record['instanceRevision'], `${label}.instanceRevision`, 1),
    accountId: readString(record['accountId'], `${label}.accountId`, 128),
    accountRevision: readInteger(record['accountRevision'], `${label}.accountRevision`, 1),
    bindingGeneration: readInteger(record['bindingGeneration'], `${label}.bindingGeneration`, 1),
    credentialRevision: readInteger(record['credentialRevision'], `${label}.credentialRevision`, 1),
    backend: readBackend(record['backend'], `${label}.backend`),
    updatedAt: readString(record['updatedAt'], `${label}.updatedAt`, 64),
    revokedAt
  }
}

/** Decodes the authenticated payload decrypted out of one sealed record. */
function decodePayload(plaintext: string): AuthenticatedCredential {
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    fail('CORRUPT_SECRET_STORE', 'Stored credential payload is malformed; the original file was preserved')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('CORRUPT_SECRET_STORE', 'Stored credential payload is malformed; the original file was preserved')
  const record = parsed as Record<string, unknown>
  try {
    exactKeys(record, PAYLOAD_KEYS, 'payload')
    const formatVersion = readInteger(record['formatVersion'], 'payload.formatVersion', 1)
    if (formatVersion !== FORMAT_VERSION) fail('CORRUPT_SECRET_STORE', 'Stored credential format is unsupported')
    return {
      formatVersion,
      credentialRef: asCredentialRef(record['credentialRef'], 'payload.credentialRef'),
      operationId: readString(record['operationId'], 'payload.operationId', 128),
      driverId: readString(record['driverId'], 'payload.driverId', 256),
      providerInstanceId: readString(record['providerInstanceId'], 'payload.providerInstanceId', 128),
      instanceRevision: readInteger(record['instanceRevision'], 'payload.instanceRevision', 1),
      accountId: readString(record['accountId'], 'payload.accountId', 128),
      accountRevision: readInteger(record['accountRevision'], 'payload.accountRevision', 1),
      bindingGeneration: readInteger(record['bindingGeneration'], 'payload.bindingGeneration', 1),
      credentialRevision: readInteger(record['credentialRevision'], 'payload.credentialRevision', 1),
      secret: parseProviderSecret(record['secret'])
    }
  } catch (error) {
    if (error instanceof SecretAuthorityError) throw error
    return fail('CORRUPT_SECRET_STORE', `Stored credential payload is invalid; the original file was preserved (${describe(error)})`)
  }
}

/**
 * The protected provider credential store.
 *
 * A separate versioned `provider-secrets.enc.json` keeps unrelated Graphiti
 * secrets on their existing authority and migration risk. The file maps opaque
 * credential refs to OS-encrypted bytes plus non-secret binding metadata and a
 * monotonic store revision. Every write is an exclusive temporary file, fsync,
 * atomic rename, and parent-directory fsync; an invalid file is preserved and
 * fails closed.
 */
export class ProviderSecretAuthority implements SecretAuthority {
  private readonly file: string
  private readonly encryption: ProviderSecretEncryption
  private readonly environments: ProviderCredentialEnvironment
  private readonly clock: () => Date
  /** One serialized queue: a revoke therefore blocks every later materialization. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: ProviderSecretAuthorityOptions) {
    this.file = join(options.userDataDir, STORE_FILE)
    this.encryption = options.encryption ?? electronProviderSecretEncryption()
    this.environments = options.credentialEnvironments ?? PROVIDER_CREDENTIAL_ENVIRONMENTS
    this.clock = options.now ?? (() => new Date())
  }

  reserveProviderCredentialRef(): CredentialRef {
    return asCredentialRef(randomUUID(), 'reserved credentialRef')
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action, action)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  /** Refuses before any write: an unprotected or unavailable backend never persists. */
  private async requireProtectedBackend(): Promise<CredentialBackend> {
    const backend = this.encryption.backend()
    if (backend === 'unprotected') fail('BACKEND_UNPROTECTED', 'Credential storage is unprotected on this system; managed credentials are refused')
    if (backend === 'unavailable') fail('BACKEND_UNAVAILABLE', 'Credential storage is unavailable on this system')
    if (!(await this.encryption.available())) fail('BACKEND_UNAVAILABLE', 'Credential encryption is temporarily unavailable')
    return backend
  }

  private load(): StoredStore {
    let text: string
    try {
      const info = lstatSync(this.file)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('provider secret store must be a regular file')
      if (info.size > MAX_STORE_BYTES) throw new Error('provider secret store exceeds its size limit')
      text = readFileSync(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: STORE_VERSION, revision: 0, records: {} }
      return fail('CORRUPT_SECRET_STORE', `Provider secret store could not be read; the original file was preserved (${describe(error)})`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return fail('CORRUPT_SECRET_STORE', 'Provider secret store is not valid JSON; the original file was preserved')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('CORRUPT_SECRET_STORE', 'Provider secret store is invalid; the original file was preserved')
    const record = parsed as Record<string, unknown>
    const records = record['records']
    if (!records || typeof records !== 'object' || Array.isArray(records)) return fail('CORRUPT_SECRET_STORE', 'Provider secret store is invalid; the original file was preserved')
    try {
      exactKeys(record, STORE_KEYS, 'store')
      const version = readInteger(record['version'], 'store.version', 1)
      if (version !== STORE_VERSION) return fail('CORRUPT_SECRET_STORE', `Provider secret store version ${version} is unsupported`)
      const decoded: Record<string, StoredCredential> = {}
      for (const [ref, entry] of Object.entries(records as Record<string, unknown>)) {
        const key = asCredentialRef(ref, 'store credential ref')
        const record = decodeStored(entry, `store.records[${ref}]`)
        // Copying a record under another key must never retarget a credential.
        if (record.credentialRef !== key) return fail('CORRUPT_SECRET_STORE', 'Provider secret store record does not match its key; the original file was preserved')
        decoded[key] = record
      }
      return { version, revision: readInteger(record['revision'], 'store.revision'), records: decoded }
    } catch (error) {
      if (error instanceof SecretAuthorityError) throw error
      return fail('CORRUPT_SECRET_STORE', `Provider secret store is invalid; the original file was preserved (${describe(error)})`)
    }
  }

  private persist(store: StoredStore): void {
    const directory = dirname(this.file)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`
    let descriptor: number | undefined
    try {
      descriptor = openSync(temporary, 'wx', 0o600)
      writeFileSync(descriptor, JSON.stringify(store, null, 2), 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      renameSync(temporary, this.file)
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
      rmSync(temporary, { force: true })
    }
    if (process.platform === 'win32') return
    const parent = openSync(directory, 'r')
    try { fsyncSync(parent) } finally { closeSync(parent) }
  }

  private ciphertextFor(record: AuthenticatedCredential): Promise<string> {
    return this.seal(record).then(sealed => sealed.toString('base64'))
  }

  private async seal(record: AuthenticatedCredential): Promise<Buffer> {
    const sealed = await this.encryption.encrypt(JSON.stringify(record))
    // The JSON snapshot above is the one immediate in-memory result the design
    // allows; the only durable form of the secret is the returned ciphertext.
    record.secret = ''
    if (sealed.byteLength > MAX_CIPHERTEXT_BYTES) fail('AUTHORIZATION_INVALID', 'Encrypted credential exceeded its size limit')
    return sealed
  }

  /** Opens one sealed record: the payload plus its key-rotation instruction. */
  private async open(ciphertext: string): Promise<{ credential: AuthenticatedCredential; shouldReEncrypt: boolean }> {
    let plaintext = ''
    let shouldReEncrypt = false
    try {
      const opened = await this.encryption.decrypt(Buffer.from(ciphertext, 'base64'))
      plaintext = opened.plaintext
      shouldReEncrypt = opened.shouldReEncrypt
    } catch {
      return fail('CORRUPT_SECRET_STORE', 'Stored credential could not be decrypted; the original file was preserved')
    }
    try {
      return { credential: decodePayload(plaintext), shouldReEncrypt }
    } finally {
      plaintext = ''
    }
  }

  private statusOf(record: StoredCredential | undefined, backend: CredentialBackend, problem?: string): CredentialStatus {
    if (!record) return { state: problem === undefined ? 'absent' : 'unavailable', revision: 0, backend, updatedAt: this.clock().toISOString(), ...(problem === undefined ? {} : { problem }) }
    const base = { revision: record.credentialRevision, backend: record.backend, updatedAt: record.updatedAt }
    if (record.revokedAt !== null) return { ...base, state: 'revoked' }
    if (problem !== undefined) return { ...base, state: 'unavailable', problem }
    return { ...base, state: 'present' }
  }

  /**
   * Idempotently seals material under the already-persisted staged ref. The
   * Secret Authority never chooses a ref here: the caller persisted it first.
   */
  async putProviderCredential(input: ResolvedProviderCredentialWrite): Promise<CredentialStatus> {
    const secret = parseProviderSecret(input.secret)
    return this.serialize(async () => {
      const principal = input.principal
      const operationId = readString(input.operationId, 'operationId', 128)
      const backend = await this.requireProtectedBackend()
      const store = this.load()
      const existing = store.records[principal.credentialRef]
      if (existing) {
        // A ref is single-use and single-owner: re-sealing is a no-op only for
        // the exact operation and principal that already own it.
        if (existing.operationId !== operationId || !sameTuple(existing, principal)) fail('BINDING_CHANGED', 'Credential reference already belongs to another operation')
        return this.statusOf(existing, existing.backend)
      }
      const credential: AuthenticatedCredential = {
        formatVersion: FORMAT_VERSION,
        credentialRef: principal.credentialRef,
        operationId,
        driverId: principal.driverId,
        providerInstanceId: principal.providerInstanceId,
        instanceRevision: principal.instanceRevision,
        accountId: principal.accountId,
        accountRevision: principal.accountRevision,
        bindingGeneration: principal.bindingGeneration,
        // A replacement is a new record, but its revision continues the store's
        // monotonic counter so a renderer can always order credential states.
        credentialRevision: store.revision + 1,
        secret
      }
      const ciphertext = await this.ciphertextFor(credential)
      const stored: StoredCredential = {
        credentialRef: principal.credentialRef,
        ciphertext,
        formatVersion: FORMAT_VERSION,
        operationId,
        driverId: principal.driverId,
        providerInstanceId: principal.providerInstanceId,
        instanceRevision: principal.instanceRevision,
        accountId: principal.accountId,
        accountRevision: principal.accountRevision,
        bindingGeneration: principal.bindingGeneration,
        credentialRevision: credential.credentialRevision,
        backend,
        updatedAt: this.clock().toISOString(),
        revokedAt: null
      }
      this.persist({ version: STORE_VERSION, revision: store.revision + 1, records: { ...store.records, [principal.credentialRef]: stored } })
      return this.statusOf(stored, backend)
    })
  }

  /**
   * Status reads decrypt once, so a corrupt or rotated ciphertext is visible as
   * `unavailable` while the file itself is never rewritten on failure. A
   * `shouldReEncrypt` answer is honoured with an atomic ciphertext replacement.
   */
  async inspectProviderCredential(input: ResolvedProviderCredentialStatus): Promise<CredentialStatus> {
    return this.serialize(async () => {
      const backend = this.encryption.backend()
      if (backend === 'unprotected') return this.statusOf(undefined, backend, 'Credential storage is unprotected on this system')
      if (backend === 'unavailable' || !(await this.encryption.available())) return this.statusOf(undefined, backend, 'Credential encryption is unavailable')
      let store: StoredStore
      try {
        store = this.load()
      } catch (error) {
        // An unreadable store is a visible unavailable status, never a throw:
        // the file stays untouched for explicit recovery.
        if (error instanceof SecretAuthorityError && error.code === 'CORRUPT_SECRET_STORE') return { state: 'unavailable', revision: 0, backend, updatedAt: this.clock().toISOString(), problem: error.message }
        throw error
      }
      const record = store.records[input.principal.credentialRef]
      if (!record) return this.statusOf(undefined, backend)
      if (record.revokedAt !== null || record.ciphertext === null) return this.statusOf(record, record.backend)
      if (!sameTuple(record, input.principal)) return this.statusOf(record, record.backend, 'Stored credential does not match the requested principal')
      try {
        const opened = await this.open(record.ciphertext)
        if (!sameTuple(opened.credential, record)) return this.statusOf(record, backend, 'Stored credential payload does not match its metadata')
        if (opened.shouldReEncrypt) {
          const ciphertext = await this.ciphertextFor(opened.credential)
          const replacement: StoredCredential = { ...record, ciphertext, backend, updatedAt: this.clock().toISOString() }
          this.persist({ version: STORE_VERSION, revision: store.revision + 1, records: { ...store.records, [input.principal.credentialRef]: replacement } })
          return this.statusOf(replacement, backend)
        }
        return this.statusOf(record, backend)
      } catch (error) {
        if (error instanceof SecretAuthorityError) return { state: 'unavailable', revision: record.credentialRevision, backend: record.backend, updatedAt: record.updatedAt, problem: error.message }
        throw error
      }
    })
  }

  /**
   * Revocation erases the sealed bytes and leaves an inert tombstone, so the
   * credential can never be materialized again and its ref cannot be reused.
   * Revoking an absent or already-revoked ref is an idempotent no-op.
   */
  async revokeProviderCredential(input: ResolvedProviderCredentialRevoke): Promise<CredentialStatus> {
    return this.serialize(async () => {
      const backend = this.encryption.backend()
      const store = this.load()
      const record = store.records[input.principal.credentialRef]
      if (!record) return this.statusOf(undefined, backend)
      if (record.revokedAt !== null && record.ciphertext === null) return this.statusOf(record, record.backend)
      const tombstone: StoredCredential = { ...record, ciphertext: null, revokedAt: this.clock().toISOString(), credentialRevision: record.credentialRevision + 1, updatedAt: this.clock().toISOString() }
      this.persist({ version: STORE_VERSION, revision: store.revision + 1, records: { ...store.records, [input.principal.credentialRef]: tombstone } })
      return this.statusOf(tombstone, record.backend)
    })
  }

  /**
   * Materializes exactly one launch environment. The decrypted tuple is
   * cross-checked against the durable metadata and the exact launch
   * authorization, so substituted ciphertext, swapped metadata, a stale
   * generation, or a replaced account all fail closed with no plaintext out.
   */
  async materializeProviderLaunch(input: ProviderLaunchAuthorization): Promise<ProviderLaunchSecrets> {
    return this.serialize(async () => {
      await this.requireProtectedBackend()
      const store = this.load()
      const record = store.records[input.credentialRef]
      if (!record) fail('CREDENTIAL_ABSENT', 'No credential is stored for this provider account')
      if (record.revokedAt !== null || record.ciphertext === null) fail('CREDENTIAL_REVOKED', 'This provider credential has been revoked')
      if (record.providerInstanceId !== input.providerInstanceId) fail('INSTANCE_MISMATCH', 'Stored credential belongs to another provider instance')
      if (record.accountId !== input.accountId) fail('ACCOUNT_MISMATCH', 'Stored credential belongs to another provider account')
      if (record.instanceRevision !== input.instanceRevision || record.accountRevision !== input.accountRevision || record.bindingGeneration !== input.bindingGeneration) fail('BINDING_CHANGED', 'Provider credential binding changed before materialization')
      const opened = await this.open(record.ciphertext)
      if (!sameTuple(record, opened.credential) || !sameTuple(opened.credential, input)) fail('BINDING_CHANGED', 'Credential payload does not authenticate to the admitted launch principal')
      if (opened.shouldReEncrypt) {
        const ciphertext = await this.ciphertextFor(opened.credential)
        const rotated: StoredCredential = { ...record, ciphertext, backend: this.encryption.backend(), updatedAt: this.clock().toISOString() }
        this.persist({ version: STORE_VERSION, revision: store.revision + 1, records: { ...store.records, [input.credentialRef]: rotated } })
      }
      const names = this.environments[input.driverId]
      if (!names || names.length === 0) fail('AUTHORIZATION_INVALID', `Driver ${input.driverId} declares no managed credential environment`)
      const environment: Record<string, string> = {}
      for (const name of names) environment[name] = opened.credential.secret
      const credentialRevision = record.credentialRevision
      opened.credential.secret = ''
      return { environment, credentialRevision }
    })
  }
}


export type ProviderCredentialAuthorityOptions = Readonly<{
  catalog: ProviderCatalog
  authority: ProviderSecretAuthority
}>

/**
 * Main-process orchestration of the provider credential saga.
 *
 * No single transaction spans the Catalog and Secret Authority, so each
 * create/replace/revoke is a durable Catalog intent advanced through exact
 * compare-and-set steps in Secret Authority. Every entry point returns only a
 * sanitized Catalog projection plus a freshly read `CredentialStatus`: no ref,
 * generation, or operation id leaves this class, and no caller may name one.
 *
 * In-flight limit: revocation prevents every future materialization but cannot
 * retract bytes already consumed by an admitted OS child spawn.
 */
export class ProviderCredentialAuthority {
  private readonly catalog: ProviderCatalog
  private readonly secrets: ProviderSecretAuthority

  constructor(options: ProviderCredentialAuthorityOptions) {
    this.catalog = options.catalog
    this.secrets = options.authority
  }

  /** Create or replace one instance/account credential; returns no internal identity. */
  async write(request: ProviderCredentialWriteRequest): Promise<ProviderCredentialResult> {
    const scope = this.catalog.credentialScope(request.providerInstanceId, request.accountId)
    if (scope.instanceRevision !== request.expectedInstanceRevision || scope.accountRevision !== request.expectedAccountRevision) throw new SecretAuthorityError('BINDING_CHANGED', 'Provider revisions changed since this request was prepared')
    const operationId = randomUUID()
    const stagedRef = this.secrets.reserveProviderCredentialRef()
    // Persist the intent and its ref before sealing any material, so an
    // interrupted write is reconcilable from durable state alone.
    const intent = this.catalog.stageCredentialReplace({ operationId, providerInstanceId: request.providerInstanceId, accountId: request.accountId, expectedInstanceRevision: scope.instanceRevision, expectedAccountRevision: scope.accountRevision, stagedCredentialRef: stagedRef })
    const targetGeneration = intent.targetBindingGeneration
    if (targetGeneration === null) throw new SecretAuthorityError('AUTHORIZATION_INVALID', 'Credential intent has no target binding generation')
    // The record authenticates the revision the winning bind publishes, not the
    // revision the caller saw: publication always advances it by exactly one, and
    // a lost compare-and-set revokes this record anyway.
    const target: ResolvedProviderCredentialPrincipal = { driverId: scope.driverId, providerInstanceId: request.providerInstanceId, instanceRevision: scope.instanceRevision + 1, accountId: request.accountId, accountRevision: scope.accountRevision, credentialRef: stagedRef, bindingGeneration: targetGeneration }
    try {
      // Seal under the staged ref. The authority never picks a second ref.
      await this.secrets.putProviderCredential({ operationId, principal: target, secret: request.secret })
      const bound = this.catalog.bindStagedCredential({ operationId, providerInstanceId: request.providerInstanceId, accountId: request.accountId, expectedInstanceRevision: scope.instanceRevision, expectedAccountRevision: scope.accountRevision, targetCredentialRef: stagedRef, targetBindingGeneration: targetGeneration, expectedBindingGeneration: intent.priorBindingGeneration ?? 0 })
      if (!bound) {
        // A lost compare-and-set revokes the staged ref and aborts; the caller
        // learns only that the credential changed underneath it.
        await this.secrets.revokeProviderCredential({ principal: target })
        this.catalog.closeCredentialOperation({ operationId, state: 'aborted' })
        throw new SecretAuthorityError('BINDING_CHANGED', 'Provider credential changed while this request was in flight')
      }
      // A winning bind revokes the superseded ref only after the Catalog
      // published the target generation, then closes the saga.
      if (intent.priorCredentialRef !== null && intent.priorBindingGeneration !== null) {
        await this.secrets.revokeProviderCredential({ principal: { ...target, credentialRef: asCredentialRef(intent.priorCredentialRef), bindingGeneration: intent.priorBindingGeneration } })
      }
      this.catalog.closeCredentialOperation({ operationId, state: 'complete' })
    } catch (error) {
      if (!(error instanceof SecretAuthorityError && error.code === 'BINDING_CHANGED')) this.abandon(operationId)
      throw error
    }
    return this.result(request.providerInstanceId, request.accountId)
  }

  /** Revoke the exact live credential first, then compare-and-set retire it. */
  async revoke(request: ProviderCredentialRevokeRequest): Promise<ProviderCredentialResult> {
    const scope = this.catalog.credentialScope(request.providerInstanceId, request.accountId)
    if (scope.instanceRevision !== request.expectedInstanceRevision || scope.accountRevision !== request.expectedAccountRevision) throw new SecretAuthorityError('BINDING_CHANGED', 'Provider revisions changed since this request was prepared')
    const operationId = randomUUID()
    const intent = this.catalog.stageCredentialRevoke({ operationId, providerInstanceId: request.providerInstanceId, accountId: request.accountId, expectedInstanceRevision: scope.instanceRevision, expectedAccountRevision: scope.accountRevision })
    if (intent.priorCredentialRef === null || intent.priorBindingGeneration === null) throw new SecretAuthorityError('CREDENTIAL_ABSENT', 'No credential is bound to this provider account')
    const principal: ResolvedProviderCredentialPrincipal = { driverId: scope.driverId, providerInstanceId: request.providerInstanceId, instanceRevision: scope.instanceRevision, accountId: request.accountId, accountRevision: scope.accountRevision, credentialRef: asCredentialRef(intent.priorCredentialRef), bindingGeneration: intent.priorBindingGeneration }
    let revoked: CredentialStatus
    try {
      revoked = await this.secrets.revokeProviderCredential({ principal })
      this.catalog.retireCredentialBindingForOperation({ providerInstanceId: request.providerInstanceId, accountId: request.accountId, expectedInstanceRevision: scope.instanceRevision, expectedAccountRevision: scope.accountRevision, expectedBindingGeneration: intent.priorBindingGeneration, credentialOperationId: operationId })
    } catch (error) {
      this.abandon(operationId)
      throw error
    }
    // The status is read before retirement because after it the account simply
    // has no binding; the user still needs to see that this exact credential
    // was revoked rather than never existing.
    return { snapshot: this.catalog.snapshot(), status: revoked }
  }

  /**
   * Status only. An unbound account reports the backend's own answer rather
   * than throwing: a missing credential is a normal state the UI must render.
   */
  async status(request: ProviderCredentialStatusRequest): Promise<ProviderCredentialResult> {
    const scope = this.catalog.credentialScope(request.providerInstanceId, request.accountId)
    const binding = this.catalog.credentialBinding(request.providerInstanceId, request.accountId)
    const principal: ResolvedProviderCredentialPrincipal = binding === null
      ? { driverId: scope.driverId, providerInstanceId: request.providerInstanceId, instanceRevision: scope.instanceRevision, accountId: request.accountId, accountRevision: scope.accountRevision, credentialRef: this.secrets.reserveProviderCredentialRef(), bindingGeneration: 1 }
      : { driverId: binding.driverId, providerInstanceId: binding.providerInstanceId, instanceRevision: binding.instanceRevision, accountId: binding.accountId, accountRevision: binding.accountRevision, credentialRef: asCredentialRef(binding.credentialRef), bindingGeneration: binding.bindingGeneration }
    return { snapshot: this.catalog.snapshot(), status: await this.secrets.inspectProviderCredential({ principal }) }
  }

  private async result(providerInstanceId: string, accountId: string): Promise<ProviderCredentialResult> {
    return this.status({ providerInstanceId, accountId })
  }

  /** A failed saga never silently leaves its intent incomplete. */
  private abandon(operationId: string): void {
    try {
      const operation = this.catalog.credentialOperation(operationId)
      if (operation && (operation.state === 'pending' || operation.state === 'catalog-bound')) this.catalog.closeCredentialOperation({ operationId, state: 'aborted' })
    } catch {
      // Startup reconciliation owns whatever is left incomplete.
    }
  }

  /**
   * Startup reconciliation, run before any credential handler registers.
   *
   * Every incomplete intent is driven to a terminal state idempotently. A state
   * that cannot be resolved without operator input is left intact and reported:
   * the saga never guesses which of two live bindings the user meant.
   */
  async reconcile(): Promise<{ resolved: number; blocked: string[] }> {
    const blocked: string[] = []
    let resolved = 0
    for (const operation of this.catalog.incompleteCredentialOperations()) {
      if (operation.providerInstanceId === null || operation.accountId === null) {
        blocked.push(operation.id)
        continue
      }
      const providerInstanceId = operation.providerInstanceId
      const accountId = operation.accountId
      const binding = this.catalog.credentialBinding(providerInstanceId, accountId)
      if (operation.kind === 'create-replace') {
        if (operation.stagedCredentialRef === null || operation.targetBindingGeneration === null || operation.priorCredentialRef === operation.stagedCredentialRef) {
          blocked.push(operation.id)
          continue
        }
        const staged: ResolvedProviderCredentialPrincipal = { ...this.principal(operation, binding), credentialRef: asCredentialRef(operation.stagedCredentialRef), bindingGeneration: operation.targetBindingGeneration }
        if (binding !== null && binding.credentialRef === operation.stagedCredentialRef) {
          // The Catalog published the target: revoke the superseded ref, then complete.
          if (operation.priorCredentialRef !== null && operation.priorBindingGeneration !== null) {
            await this.secrets.revokeProviderCredential({ principal: { ...this.principal(operation, binding), credentialRef: asCredentialRef(operation.priorCredentialRef), bindingGeneration: operation.priorBindingGeneration } }).catch(() => undefined)
          }
          this.catalog.closeCredentialOperation({ operationId: operation.id, state: 'complete' })
          resolved++
          continue
        }
        if ((binding?.credentialRef ?? null) === operation.priorCredentialRef && (binding?.bindingGeneration ?? null) === operation.priorBindingGeneration) {
          // The bind never landed: revoke the staged ref and abort.
          await this.secrets.revokeProviderCredential({ principal: staged }).catch(() => undefined)
          this.catalog.closeCredentialOperation({ operationId: operation.id, state: 'aborted' })
          resolved++
          continue
        }
        // A third binding exists: fail closed for explicit recovery.
        blocked.push(operation.id)
        continue
      }
      if (operation.priorCredentialRef === null || operation.priorBindingGeneration === null) {
        blocked.push(operation.id)
        continue
      }
      const prior = { ...this.principal(operation, binding), credentialRef: asCredentialRef(operation.priorCredentialRef), bindingGeneration: operation.priorBindingGeneration }
      if (binding === null) {
        // Retirement already landed before the crash.
        this.catalog.closeCredentialOperation({ operationId: operation.id, state: 'complete' })
        resolved++
        continue
      }
      if (binding.credentialRef !== operation.priorCredentialRef || binding.bindingGeneration !== operation.priorBindingGeneration) {
        // A concurrent replacement already superseded this operation: the old
        // ref stays revoked, the new one stays active, and nothing is orphaned.
        await this.secrets.revokeProviderCredential({ principal: prior }).catch(() => undefined)
        this.catalog.closeCredentialOperation({ operationId: operation.id, state: 'complete' })
        resolved++
        continue
      }
      await this.secrets.revokeProviderCredential({ principal: prior }).catch(() => undefined)
      try {
        this.catalog.retireCredentialBindingForOperation({ providerInstanceId, accountId, expectedInstanceRevision: binding.instanceRevision, expectedAccountRevision: binding.accountRevision, expectedBindingGeneration: operation.priorBindingGeneration, credentialOperationId: operation.id })
      } catch {
        blocked.push(operation.id)
        continue
      }
      resolved++
    }
    return { resolved, blocked }
  }

  private principal(operation: ProviderCredentialOperation, binding: ProviderCredentialBinding | null): ResolvedProviderCredentialPrincipal {
    if (operation.providerInstanceId === null || operation.accountId === null) throw new SecretAuthorityError('AUTHORIZATION_INVALID', 'Credential operation is not bound to a provider account')
    if (binding !== null) return { driverId: binding.driverId, providerInstanceId: binding.providerInstanceId, instanceRevision: binding.instanceRevision, accountId: binding.accountId, accountRevision: binding.accountRevision, credentialRef: asCredentialRef(binding.credentialRef), bindingGeneration: binding.bindingGeneration }
    const scope = this.catalog.credentialScope(operation.providerInstanceId, operation.accountId)
    return { driverId: scope.driverId, providerInstanceId: operation.providerInstanceId, instanceRevision: operation.instanceRevision ?? scope.instanceRevision, accountId: operation.accountId, accountRevision: operation.accountRevision ?? scope.accountRevision, credentialRef: asCredentialRef(operation.priorCredentialRef ?? operation.stagedCredentialRef ?? randomUUID()), bindingGeneration: operation.priorBindingGeneration ?? operation.targetBindingGeneration ?? 1 }
  }
}
