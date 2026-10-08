import { createHash, randomUUID } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ProcessIdentity, ProcessIdentityVerdict } from './child-process/process-spec'
import { canonicalPrivateDirectory, privateRuntimeFileIdentityReader, privateRuntimeFileReader, readPrivateRuntimeFile, runtimeAuthorityLock, RuntimeFileSecurityError, type RuntimeAuthorityLock, type RuntimeFileIdentity, type RuntimeFileIdentityReader, type RuntimeFileReader } from './runtime-file-security'

export type RuntimeOwnerKind = 'donwells-app' | 'terminal-daemon'
export type RuntimeOwner = {
  kind: RuntimeOwnerKind
  ownerId: string
  generation: number
  state: 'preparing' | 'active'
  identity: ProcessIdentity
  endpoint: string
  authToken: string
  locatorSha256: string | null
  endpointFileIdentity: RuntimeFileIdentity | null
}

export type RuntimeOwnerObservation =
  | { status: 'vacant'; lastGeneration: number }
  | { status: 'present'; owner: RuntimeOwner; rowSha256: string }

export type RuntimeLocator = {
  version: 2
  ownerId: string
  ownerGeneration: number
  socketPath: string
  authToken: string
  processIdentity: ProcessIdentity
}

export type LegacyRecoveryInput = {
  id?: string
  kind: RuntimeOwnerKind
  expectedFingerprint: string
  fileIdentity: Record<string, string>
  evidencePath: string
  evidenceFileIdentity: Record<string, string>
  endpoint: string
  recordType: 'legacy' | 'orphan-v2'
}
export type LegacyRecoveryMatch = Pick<LegacyRecoveryInput, 'kind' | 'expectedFingerprint' | 'fileIdentity' | 'endpoint' | 'recordType'>

export type LegacyRecoveryRecord = LegacyRecoveryInput & {
  id: string
  state: 'committed'
  createdAt: string
  updatedAt: string
}

export type RuntimeEndpointCleanupPredecessor = {
  ownerId: string
  generation: number
  endpoint: string
  endpointFileIdentity: RuntimeFileIdentity
}

export type RuntimeEndpointCleanup = {
  id: string
  kind: RuntimeOwnerKind
  successorOwnerId: string
  successorGeneration: number
  predecessorOwnerId: string
  predecessorGeneration: number
  endpoint: string
  quarantinePath: string
  expectedFileIdentity: RuntimeFileIdentity
  createdAt: string
}

export class RuntimeOwnershipError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RuntimeOwnershipError'
  }
}
export function readVerifiedRecoveryEvidence(record: LegacyRecoveryRecord, reader: RuntimeFileReader = privateRuntimeFileReader()): Buffer {
  let evidence
  try {
    evidence = readPrivateRuntimeFile(record.evidencePath, 64 * 1024, reader)
  } catch (error) {
    throw new RuntimeOwnershipError('RECOVERY_EVIDENCE_INVALID', error instanceof Error ? error.message : String(error))
  }
  if (evidence.sha256 !== record.expectedFingerprint
    || JSON.stringify(evidence.fileIdentity) !== JSON.stringify(record.evidenceFileIdentity)) {
    throw new RuntimeOwnershipError('RECOVERY_EVIDENCE_INVALID', 'runtime recovery evidence identity or bytes changed')
  }
  return evidence.bytes
}

const OWNER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HASH = /^[a-f0-9]{64}$/

function assertKind(kind: string): asserts kind is RuntimeOwnerKind {
  if (kind !== 'donwells-app' && kind !== 'terminal-daemon') throw new RuntimeOwnershipError('INVALID_OWNER', 'runtime owner kind was invalid')
}

function assertOwnerId(ownerId: string): void {
  if (!OWNER_ID.test(ownerId)) throw new RuntimeOwnershipError('INVALID_OWNER', 'runtime owner ID was invalid')
}

function assertHash(value: string | null): void {
  if (value !== null && !HASH.test(value)) throw new RuntimeOwnershipError('INVALID_HASH', 'runtime locator hash was invalid')
}

function identityJson(identity: ProcessIdentity): string {
  return JSON.stringify(identity)
}

function endpointIdentityJson(identity: RuntimeFileIdentity | null): string | null {
  if (identity === null) return null
  const serialized = JSON.stringify(identity)
  parseEndpointIdentity(serialized)
  return serialized
}

function parseEndpointIdentity(value: unknown): RuntimeFileIdentity | null {
  if (value === null) return null
  let identity: unknown
  try { identity = JSON.parse(String(value)) } catch {
    throw new RuntimeOwnershipError('OWNER_CORRUPT', 'persisted runtime endpoint identity was malformed')
  }
  if (typeof identity !== 'object' || identity === null || Array.isArray(identity)) {
    throw new RuntimeOwnershipError('OWNER_CORRUPT', 'persisted runtime endpoint identity was malformed')
  }
  const fields = identity as Record<string, unknown>
  if (fields['platform'] === 'posix' && typeof fields['device'] === 'string' && fields['device'] && typeof fields['inode'] === 'string' && fields['inode']) {
    return { platform: 'posix', device: fields['device'], inode: fields['inode'] }
  }
  if (fields['platform'] === 'win32' && typeof fields['volumeSerial'] === 'string' && fields['volumeSerial'] && typeof fields['fileId'] === 'string' && fields['fileId']) {
    return { platform: 'win32', volumeSerial: fields['volumeSerial'], fileId: fields['fileId'] }
  }
  throw new RuntimeOwnershipError('OWNER_CORRUPT', 'persisted runtime endpoint identity was malformed')
}

function rowHash(row: RuntimeOwner): string {
  return createHash('sha256').update(JSON.stringify({
    kind: row.kind,
    owner_id: row.ownerId,
    generation: row.generation,
    state: row.state,
    identity_json: identityJson(row.identity),
    endpoint: row.endpoint,
    auth_token: row.authToken,
    endpoint_identity_json: endpointIdentityJson(row.endpointFileIdentity),
    locator_sha256: row.locatorSha256
  })).digest('hex')
}

function parseRow(row: Record<string, unknown>): RuntimeOwner {
  const kindValue = row['kind']
  if (kindValue !== 'donwells-app' && kindValue !== 'terminal-daemon') throw new RuntimeOwnershipError('OWNER_CORRUPT', 'persisted runtime owner kind was invalid')
  const kind = kindValue
  const ownerId = String(row['owner_id'])
  if (!OWNER_ID.test(ownerId)) throw new RuntimeOwnershipError('OWNER_CORRUPT', 'persisted runtime owner ID was invalid')
  const generation = Number(row['generation'])
  if (!Number.isSafeInteger(generation) || generation < 1) throw new RuntimeOwnershipError('OWNER_CORRUPT', 'persisted runtime owner generation was invalid')
  const state = row['state']
  if (state !== 'preparing' && state !== 'active') throw new RuntimeOwnershipError('OWNER_CORRUPT', 'persisted runtime owner state was invalid')
  let identity: ProcessIdentity
  try {
    identity = JSON.parse(String(row['identity_json'])) as ProcessIdentity
  } catch {
    throw new RuntimeOwnershipError('OWNER_CORRUPT', 'persisted runtime owner identity was malformed')
  }
  if (typeof identity !== 'object' || identity === null || !Number.isSafeInteger(identity.pid) || identity.pid < 1
    || typeof identity.bootId !== 'string' || !identity.bootId || typeof identity.startedAt !== 'string' || !identity.startedAt
    || typeof identity.executablePath !== 'string' || !identity.executablePath || identity.family !== kind
    || typeof identity.capturedAt !== 'string' || !identity.capturedAt || identity.generation !== ownerId + ':' + generation) {
    throw new RuntimeOwnershipError('OWNER_CORRUPT', 'persisted runtime owner identity did not match its authority row')
  }
  const endpoint = row['endpoint']
  const authToken = row['auth_token']
  const locatorSha256 = row['locator_sha256'] === null ? null : String(row['locator_sha256'])
  const endpointFileIdentity = parseEndpointIdentity(row['endpoint_identity_json'])
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 4096 || endpoint.includes('\0')
    || typeof authToken !== 'string' || authToken.length === 0 || authToken.length > 16 * 1024 || authToken.includes('\0')
    || (state === 'preparing' && locatorSha256 !== null) || (state === 'active' && (locatorSha256 === null || !HASH.test(locatorSha256)))) {
    throw new RuntimeOwnershipError('OWNER_CORRUPT', 'persisted runtime owner fields violated state invariants')
  }
  return { kind, ownerId, generation, state, identity, endpoint, authToken, locatorSha256, endpointFileIdentity }
}

function lastGeneration(db: DatabaseSync, kind: RuntimeOwnerKind): number {
  const row = db.prepare('SELECT last_generation FROM runtime_owner_generations WHERE kind = ?').get(kind) as Record<string, unknown> | undefined
  if (!row) return 0
  const generation = Number(row['last_generation'])
  if (!Number.isSafeInteger(generation) || generation < 1) throw new RuntimeOwnershipError('OWNER_CORRUPT', 'persisted runtime generation watermark was invalid')
  return generation
}

function rowFromObservation(db: DatabaseSync, kind: RuntimeOwnerKind): { owner: RuntimeOwner; rowSha256: string } | null {
  const endpointIdentityColumn = Number((db.prepare('PRAGMA user_version').get() as Record<string, unknown>)['user_version']) >= 5
    ? 'endpoint_identity_json'
    : 'NULL AS endpoint_identity_json'
  const raw = db.prepare('SELECT kind, owner_id, generation, state, identity_json, endpoint, auth_token, locator_sha256, ' + endpointIdentityColumn + ' FROM runtime_owners WHERE kind = ?').get(kind) as Record<string, unknown> | undefined
  if (!raw) return null
  const owner = parseRow(raw)
  return { owner, rowSha256: rowHash(owner) }
}

function now(): string {
  return new Date().toISOString()
}

function parseRecoveryDetail(value: unknown): Pick<LegacyRecoveryInput, 'fileIdentity' | 'evidencePath' | 'evidenceFileIdentity' | 'endpoint' | 'recordType'> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RuntimeOwnershipError('INVALID_RECOVERY', 'runtime recovery detail was malformed')
  const detail = value as Record<string, unknown>
  if (typeof detail['fileIdentity'] !== 'object' || detail['fileIdentity'] === null || Array.isArray(detail['fileIdentity'])
    || typeof detail['evidenceFileIdentity'] !== 'object' || detail['evidenceFileIdentity'] === null || Array.isArray(detail['evidenceFileIdentity'])
    || typeof detail['evidencePath'] !== 'string' || detail['evidencePath'].length === 0 || detail['evidencePath'].includes('\0')
    || typeof detail['endpoint'] !== 'string' || detail['endpoint'].length === 0 || detail['endpoint'].includes('\0')
    || (detail['recordType'] !== 'legacy' && detail['recordType'] !== 'orphan-v2')) {
    throw new RuntimeOwnershipError('INVALID_RECOVERY', 'runtime recovery detail violated its schema')
  }
  return {
    fileIdentity: detail['fileIdentity'] as Record<string, string>,
    evidencePath: detail['evidencePath'],
    evidenceFileIdentity: detail['evidenceFileIdentity'] as Record<string, string>,
    endpoint: detail['endpoint'],
    recordType: detail['recordType']
  }
}

function parseEndpointCleanup(row: Record<string, unknown>): RuntimeEndpointCleanup {
  const kind = row['kind']
  if (kind !== 'donwells-app' && kind !== 'terminal-daemon') throw new RuntimeOwnershipError('CLEANUP_CORRUPT', 'endpoint cleanup kind was invalid')
  const id = String(row['id'])
  const successorOwnerId = String(row['successor_owner_id'])
  const predecessorOwnerId = String(row['predecessor_owner_id'])
  const successorGeneration = Number(row['successor_generation'])
  const predecessorGeneration = Number(row['predecessor_generation'])
  const endpoint = row['endpoint']
  const quarantinePath = row['quarantine_path']
  const createdAt = row['created_at']
  const expectedFileIdentity = parseEndpointIdentity(row['expected_identity_json'])
  if (!OWNER_ID.test(id) || !OWNER_ID.test(successorOwnerId) || !OWNER_ID.test(predecessorOwnerId) || successorOwnerId === predecessorOwnerId
    || !Number.isSafeInteger(successorGeneration) || !Number.isSafeInteger(predecessorGeneration) || predecessorGeneration < 1 || successorGeneration <= predecessorGeneration
    || typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 4096 || endpoint.includes('\0')
    || typeof quarantinePath !== 'string' || quarantinePath !== endpoint + '.cleanup-' + id || quarantinePath.length > 4096 || quarantinePath.includes('\0')
    || expectedFileIdentity === null || typeof createdAt !== 'string' || createdAt.length === 0) {
    throw new RuntimeOwnershipError('CLEANUP_CORRUPT', 'endpoint cleanup record violated its schema')
  }
  return { id, kind, successorOwnerId, successorGeneration, predecessorOwnerId, predecessorGeneration, endpoint, quarantinePath, expectedFileIdentity, createdAt }
}

function sameEndpointCleanup(left: RuntimeEndpointCleanup, right: RuntimeEndpointCleanup): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
type StoreOptions = {
  readOnly?: boolean
  authorityLock?: RuntimeAuthorityLock
  identityReader?: RuntimeFileIdentityReader
}

function identityKey(identity: RuntimeFileIdentity): string {
  return JSON.stringify(identity)
}

function sameOwner(left: RuntimeOwner, right: RuntimeOwner): boolean {
  return rowHash(left) === rowHash(right)
}

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

/**
 * DDL fragments shared by the bootstrap and the pre-v5 migration branches.
 * Each fragment is emitted at the depth it has always had inside
 * initializeSchema's templates, so the assembled statements stay byte-identical
 * to the inline SQL they replace.
 */
const STATEMENT_INDENT = '      '
const NESTED_INDENT = '        '

function createTableDdl(name: string, columns: readonly string[], ifNotExists = false): string {
  const header = `${STATEMENT_INDENT}CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${name} (`
  return [header, ...columns.map((column) => `${NESTED_INDENT}${column}`), `${STATEMENT_INDENT});`].join('\n')
}

const RUNTIME_OWNER_GENERATION_COLUMNS: readonly string[] = [
  'kind TEXT PRIMARY KEY,',
  'last_generation INTEGER NOT NULL'
]

const RUNTIME_RECOVERY_OPERATION_COLUMNS: readonly string[] = [
  'id TEXT PRIMARY KEY,',
  'kind TEXT NOT NULL,',
  'expected_fingerprint TEXT NOT NULL,',
  'state TEXT NOT NULL,',
  'detail_json TEXT NOT NULL,',
  'created_at TEXT NOT NULL,',
  'updated_at TEXT NOT NULL'
]

const RUNTIME_OWNER_ENDPOINT_HISTORY_COLUMNS: readonly string[] = [
  'endpoint TEXT PRIMARY KEY,',
  'kind TEXT NOT NULL,',
  'owner_id TEXT NOT NULL,',
  'generation INTEGER NOT NULL,',
  'created_at TEXT NOT NULL'
]

const RUNTIME_ENDPOINT_CLEANUP_COLUMNS: readonly string[] = [
  'id TEXT PRIMARY KEY,',
  'kind TEXT NOT NULL,',
  'successor_owner_id TEXT NOT NULL,',
  'successor_generation INTEGER NOT NULL,',
  'predecessor_owner_id TEXT NOT NULL,',
  'predecessor_generation INTEGER NOT NULL,',
  'endpoint TEXT NOT NULL UNIQUE,',
  'quarantine_path TEXT NOT NULL UNIQUE,',
  'expected_identity_json TEXT NOT NULL,',
  'created_at TEXT NOT NULL'
]

const RUNTIME_OWNER_GENERATION_BACKFILL_DDL = `${STATEMENT_INDENT}INSERT INTO runtime_owner_generations(kind,last_generation)\n${NESTED_INDENT}SELECT kind, MAX(generation) FROM runtime_owners GROUP BY kind;`
const RUNTIME_OWNER_IDENTITY_INDEX_DDL = `${STATEMENT_INDENT}CREATE UNIQUE INDEX runtime_owner_identity_generation ON runtime_owners(owner_id, generation);`
const RUNTIME_ENDPOINT_HISTORY_BACKFILL_DDL = `${STATEMENT_INDENT}INSERT INTO runtime_owner_endpoint_history(endpoint,kind,owner_id,generation,created_at)\n${NESTED_INDENT}SELECT endpoint, kind, owner_id, generation, claimed_at FROM runtime_owners;`
const RUNTIME_ENDPOINT_IDENTITY_COLUMN_DDL = `${STATEMENT_INDENT}ALTER TABLE runtime_owners ADD COLUMN endpoint_identity_json TEXT;`

/** Tail shared by the v1, v2 and v3 branches; every statement in it is idempotent. */
function preVersion5RecoveryDdl(): string {
  return [
    createTableDdl('runtime_recovery_operations', RUNTIME_RECOVERY_OPERATION_COLUMNS, true),
    createTableDdl('runtime_owner_endpoint_history', RUNTIME_OWNER_ENDPOINT_HISTORY_COLUMNS),
    RUNTIME_ENDPOINT_HISTORY_BACKFILL_DDL,
    RUNTIME_ENDPOINT_IDENTITY_COLUMN_DDL,
    `${STATEMENT_INDENT}PRAGMA user_version=5;`
  ].join('\n')
}

function initializeSchema(db: DatabaseSync, readOnly: boolean): void {
  const version = Number((db.prepare('PRAGMA user_version').get() as Record<string, unknown>)['user_version'])
  if (version === 0 && !readOnly) {
    db.exec(`
      CREATE TABLE runtime_owners (
        kind TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('preparing','active')),
        identity_json TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        auth_token TEXT NOT NULL,
        locator_sha256 TEXT,
        endpoint_identity_json TEXT,
        claimed_at TEXT NOT NULL,
        activated_at TEXT
      );
${RUNTIME_OWNER_IDENTITY_INDEX_DDL}
${createTableDdl('runtime_owner_generations', RUNTIME_OWNER_GENERATION_COLUMNS)}
      CREATE TABLE runtime_ownership_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        action TEXT NOT NULL,
        prior_row_sha256 TEXT,
        owner_id TEXT,
        generation INTEGER,
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
${createTableDdl('runtime_recovery_operations', RUNTIME_RECOVERY_OPERATION_COLUMNS)}
${createTableDdl('runtime_owner_endpoint_history', RUNTIME_OWNER_ENDPOINT_HISTORY_COLUMNS)}
${createTableDdl('runtime_endpoint_cleanups', RUNTIME_ENDPOINT_CLEANUP_COLUMNS)}
      PRAGMA user_version=6;
    `)
  } else if (version === 1 && !readOnly) {
    db.exec(`
${createTableDdl('runtime_owner_generations', RUNTIME_OWNER_GENERATION_COLUMNS)}
${RUNTIME_OWNER_GENERATION_BACKFILL_DDL}
${RUNTIME_OWNER_IDENTITY_INDEX_DDL}
${preVersion5RecoveryDdl()}
    `)
  } else if (version === 2 && !readOnly) {
    db.exec(`
${RUNTIME_OWNER_IDENTITY_INDEX_DDL}
${preVersion5RecoveryDdl()}
    `)
  } else if (version === 3 && !readOnly) {
    db.exec(`
${preVersion5RecoveryDdl()}
    `)
  } else if (version === 4 && !readOnly) {
    db.exec(`
${RUNTIME_ENDPOINT_IDENTITY_COLUMN_DDL}
      PRAGMA user_version=5;
    `)
  } else if (version !== 5 && version !== 6 && !(readOnly && (version === 3 || version === 4))) {
    throw new RuntimeOwnershipError('SCHEMA_UNSUPPORTED', 'runtime ownership database schema is unsupported')
  }
  if (!readOnly && version >= 1 && version <= 5) {
    db.exec(`
${createTableDdl('runtime_endpoint_cleanups', RUNTIME_ENDPOINT_CLEANUP_COLUMNS)}
      PRAGMA user_version=6;
    `)
  }
}

function validateDatabase(db: DatabaseSync): void {
  const ownerRows = db.prepare('SELECT kind FROM runtime_owners').all() as Array<Record<string, unknown>>
  for (const row of ownerRows) {
    const kind = String(row['kind'])
    if (kind !== 'donwells-app' && kind !== 'terminal-daemon') throw new RuntimeOwnershipError('OWNER_CORRUPT', 'persisted runtime owner kind was invalid')
    const current = rowFromObservation(db, kind)
    if (!current || lastGeneration(db, kind) !== current.owner.generation) throw new RuntimeOwnershipError('OWNER_CORRUPT', 'runtime generation watermark did not match its owner row')
  }
  const generationRows = db.prepare('SELECT kind, last_generation FROM runtime_owner_generations').all() as Array<Record<string, unknown>>
  for (const row of generationRows) {
    const kind = String(row['kind'])
    if (kind !== 'donwells-app' && kind !== 'terminal-daemon') throw new RuntimeOwnershipError('OWNER_CORRUPT', 'persisted runtime generation kind was invalid')
    lastGeneration(db, kind)
  }
  const version = Number((db.prepare('PRAGMA user_version').get() as Record<string, unknown>)['user_version'])
  if (version >= 6) {
    const cleanupRows = db.prepare('SELECT id, kind, successor_owner_id, successor_generation, predecessor_owner_id, predecessor_generation, endpoint, quarantine_path, expected_identity_json, created_at FROM runtime_endpoint_cleanups').all() as Array<Record<string, unknown>>
    for (const row of cleanupRows) parseEndpointCleanup(row)
  }
}

export class RuntimeOwnershipStore {
  readonly databasePath: string
  private readonly readOnly: boolean
  private readonly withAuthorityLock: RuntimeAuthorityLock
  private readonly readIdentity: RuntimeFileIdentityReader
  private authorityIdentity: string | null = null
  private closed = false

  constructor(databasePath: string, options: StoreOptions = {}) {
    this.readOnly = options.readOnly === true
    this.withAuthorityLock = options.authorityLock ?? runtimeAuthorityLock()
    this.readIdentity = options.identityReader ?? privateRuntimeFileIdentityReader()
    const directory = canonicalPrivateDirectory(dirname(databasePath), { create: !this.readOnly, requireCanonical: true })
    this.databasePath = join(directory, basename(databasePath))
    this.withDatabase(!this.readOnly, db => {
      initializeSchema(db, this.readOnly)
      validateDatabase(db)
    }, db => {
      initializeSchema(db, true)
      validateDatabase(db)
      if (Number((db.prepare('PRAGMA user_version').get() as Record<string, unknown>)['user_version']) !== 6) {
        throw new RuntimeOwnershipError('SCHEMA_UNSUPPORTED', 'runtime ownership database migration did not commit')
      }
    })
  }

  private ensureAuthorityFile(): void {
    try {
      this.readIdentity(this.databasePath)
    } catch (error) {
      if (!(error instanceof RuntimeFileSecurityError) || error.code !== 'not-found' || this.readOnly) throw error
      closeSync(openSync(this.databasePath, 'wx', 0o600))
    }
  }

  private assertAuthorityIdentity(): void {
    const identity = identityKey(this.readIdentity(this.databasePath))
    if (this.authorityIdentity === null) this.authorityIdentity = identity
    else if (identity !== this.authorityIdentity) {
      throw new RuntimeOwnershipError('DATABASE_CHANGED', 'runtime ownership database identity changed during use')
    }
  }

  private openDatabase(readOnly: boolean, databasePath = this.databasePath): DatabaseSync {
    const db = new DatabaseSync(databasePath, { readOnly })
    try {
      db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000')
      if (!readOnly) {
        const mode = db.prepare('PRAGMA journal_mode=WAL').get() as Record<string, unknown>
        if (String(mode['journal_mode']).toLowerCase() !== 'wal') {
          throw new RuntimeOwnershipError('DATABASE_UNSAFE', 'runtime ownership database could not enter WAL mode')
        }
        db.exec('PRAGMA synchronous=FULL')
      }
      return db
    } catch (error) {
      db.close()
      if (error instanceof RuntimeOwnershipError) throw error
      throw new RuntimeOwnershipError('DATABASE_UNSAFE', 'runtime ownership database setup failed: ' + (error instanceof Error ? error.message : String(error)))
    }
  }
  private checkpointWal(db: DatabaseSync): void {
    let checkpoint: Record<string, unknown>
    try {
      checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as Record<string, unknown>
    } catch (error) {
      throw new RuntimeOwnershipError('DATABASE_UNSAFE', 'runtime ownership WAL checkpoint failed: ' + (error instanceof Error ? error.message : String(error)))
    }
    if (Number(checkpoint['busy']) !== 0 || Number(checkpoint['log']) !== 0 || Number(checkpoint['checkpointed']) !== 0) {
      throw new RuntimeOwnershipError('DATABASE_UNSAFE', 'runtime ownership WAL checkpoint did not reach a durable empty state')
    }
  }

  private withDatabase<T>(write: boolean, operation: (db: DatabaseSync) => T, verify?: (db: DatabaseSync, result: T) => void): T {
    if (this.closed) throw new RuntimeOwnershipError('DATABASE_CLOSED', 'runtime ownership database is closed')
    if (write && this.readOnly) throw new RuntimeOwnershipError('READ_ONLY', 'runtime ownership database is read-only')
    if (write && !verify) throw new RuntimeOwnershipError('DATABASE_UNSAFE', 'runtime ownership mutation had no durability verification')
    if (this.readOnly) this.ensureAuthorityFile()
    return this.withAuthorityLock(this.databasePath, stablePath => {
      this.ensureAuthorityFile()
      this.assertAuthorityIdentity()
      const db = this.openDatabase(this.readOnly, stablePath)
      let result: T
      try {
        if (write) db.exec('BEGIN IMMEDIATE')
        result = operation(db)
        if (write) {
          this.assertAuthorityIdentity()
          try { db.exec('COMMIT') } catch (error) {
            throw new RuntimeOwnershipError('DATABASE_UNSAFE', 'runtime ownership transaction commit failed: ' + (error instanceof Error ? error.message : String(error)))
          }
          this.checkpointWal(db)
        }
      } finally {
        db.close()
      }
      this.assertAuthorityIdentity()
      if (write) {
        const verifier = this.openDatabase(true, stablePath)
        try { verify!(verifier, result) } finally { verifier.close() }
        this.assertAuthorityIdentity()
      }
      return result
    }, { readOnly: this.readOnly })
  }
  private assertOwnerCommitted(db: DatabaseSync, expected: RuntimeOwner): void {
    const committed = rowFromObservation(db, expected.kind)
    if (!committed || !sameOwner(committed.owner, expected) || lastGeneration(db, expected.kind) !== expected.generation) {
      throw new RuntimeOwnershipError('DATABASE_UNSAFE', 'runtime ownership mutation was not durable at the canonical authority')
    }
  }

  close(): void {
    this.closed = true
  }

  observe(kind: RuntimeOwnerKind): RuntimeOwnerObservation {
    assertKind(kind)
    return this.withDatabase(false, db => {
      const result = rowFromObservation(db, kind)
      const generation = lastGeneration(db, kind)
      if (result && result.owner.generation !== generation) throw new RuntimeOwnershipError('OWNER_CORRUPT', 'runtime generation watermark did not match its owner row')
      return result ? { status: 'present', owner: result.owner, rowSha256: result.rowSha256 } : { status: 'vacant', lastGeneration: generation }
    })
  }

  prepareClaim(candidate: Omit<RuntimeOwner, 'generation' | 'state' | 'locatorSha256' | 'endpointFileIdentity'>, observed: RuntimeOwnerObservation, verdict: ProcessIdentityVerdict | null): RuntimeOwner {
    assertKind(candidate.kind)
    assertOwnerId(candidate.ownerId)
    if (!candidate.endpoint || !candidate.authToken) throw new RuntimeOwnershipError('INVALID_OWNER', 'runtime owner endpoint or token was empty')
    if (observed.status === 'present') {
      if (verdict === null) throw new RuntimeOwnershipError('OWNER_INDETERMINATE', 'existing runtime owner has no identity verdict')
      if (verdict.status === 'indeterminate') throw new RuntimeOwnershipError('OWNER_INDETERMINATE', verdict.reason + ': ' + verdict.detail)
      if (verdict.status === 'valid') throw new RuntimeOwnershipError('OWNER_LIVE', 'existing runtime owner is still valid')
    }
    if (observed.status === 'vacant' && verdict !== null) throw new RuntimeOwnershipError('OWNER_CHANGED', 'vacant runtime owner cannot have a prior verdict')
    const claimedAt = now()
    return this.withDatabase(true, db => {
      const current = rowFromObservation(db, candidate.kind)
      const generationWatermark = lastGeneration(db, candidate.kind)
      if (observed.status === 'vacant'
        ? current !== null || generationWatermark !== observed.lastGeneration
        : current === null || current.rowSha256 !== observed.rowSha256 || generationWatermark !== current.owner.generation) {
        throw new RuntimeOwnershipError('OWNER_CHANGED', 'runtime owner changed after observation')
      }
      const generation = generationWatermark + 1
      if (candidate.identity.family !== candidate.kind || candidate.identity.generation !== candidate.ownerId + ':' + generation) {
        throw new RuntimeOwnershipError('OWNER_MISMATCH', 'runtime process identity generation did not match its owner row')
      }
      if (candidate.endpoint.length > 4096 || candidate.endpoint.includes('\0')) {
        throw new RuntimeOwnershipError('INVALID_OWNER', 'runtime owner endpoint was malformed')
      }
      const priorEndpoint = db.prepare('SELECT kind, owner_id, generation FROM runtime_owner_endpoint_history WHERE endpoint=?').get(candidate.endpoint) as Record<string, unknown> | undefined
      if (priorEndpoint) {
        throw new RuntimeOwnershipError('ENDPOINT_REUSED', 'runtime owner endpoint was already bound to a prior generation')
      }
      db.prepare('INSERT INTO runtime_owner_endpoint_history(endpoint,kind,owner_id,generation,created_at) VALUES(?,?,?,?,?)').run(candidate.endpoint, candidate.kind, candidate.ownerId, generation, claimedAt)
      const owner: RuntimeOwner = { ...candidate, generation, state: 'preparing', locatorSha256: null, endpointFileIdentity: null }
      db.prepare('INSERT INTO runtime_owner_generations(kind,last_generation) VALUES(?,?) ON CONFLICT(kind) DO UPDATE SET last_generation=excluded.last_generation').run(owner.kind, generation)
      if (current) {
        db.prepare(`UPDATE runtime_owners SET owner_id=?, generation=?, state=?, identity_json=?, endpoint=?, auth_token=?, locator_sha256=NULL, endpoint_identity_json=NULL, claimed_at=?, activated_at=NULL WHERE kind=?`).run(
          owner.ownerId, owner.generation, owner.state, identityJson(owner.identity), owner.endpoint, owner.authToken, claimedAt, owner.kind)
      } else {
        db.prepare(`INSERT INTO runtime_owners(kind,owner_id,generation,state,identity_json,endpoint,auth_token,locator_sha256,endpoint_identity_json,claimed_at,activated_at) VALUES(?,?,?,?,?,?,?,NULL,NULL,?,NULL)`).run(
          owner.kind, owner.ownerId, owner.generation, owner.state, identityJson(owner.identity), owner.endpoint, owner.authToken, claimedAt)
      }
      this.audit(db, owner.kind, 'prepare', observed.status === 'present' ? observed.rowSha256 : null, owner, { verdict: verdict?.status ?? null })
      return owner
    }, (db, prepared) => {
      this.assertOwnerCommitted(db, prepared)
      const endpoint = db.prepare('SELECT owner_id, generation FROM runtime_owner_endpoint_history WHERE endpoint=?').get(prepared.endpoint) as Record<string, unknown> | undefined
      if (!endpoint || endpoint['owner_id'] !== prepared.ownerId || Number(endpoint['generation']) !== prepared.generation) {
        throw new RuntimeOwnershipError('DATABASE_UNSAFE', 'runtime endpoint reservation was not durable at the canonical authority')
      }
    })
  }

  recordBoundEndpoint(owner: RuntimeOwner, endpointFileIdentity: RuntimeFileIdentity): RuntimeOwner {
    const serializedIdentity = endpointIdentityJson(endpointFileIdentity)
    return this.withDatabase(true, db => {
      const current = rowFromObservation(db, owner.kind)
      if (!current || current.owner.ownerId !== owner.ownerId || current.owner.generation !== owner.generation || current.owner.state !== 'preparing') {
        throw new RuntimeOwnershipError('OWNER_CHANGED', 'runtime owner changed before endpoint identity publication')
      }
      db.prepare('UPDATE runtime_owners SET endpoint_identity_json=? WHERE kind=? AND owner_id=? AND generation=? AND state=?').run(
        serializedIdentity, owner.kind, owner.ownerId, owner.generation, 'preparing')
      const bound = { ...current.owner, endpointFileIdentity }
      this.audit(db, owner.kind, 'bind-endpoint', current.rowSha256, bound, {})
      return bound
    }, (db, bound) => this.assertOwnerCommitted(db, bound))
  }

  activate(owner: RuntimeOwner, locatorSha256: string): RuntimeOwner {
    assertHash(locatorSha256)
    if (owner.state !== 'preparing') throw new RuntimeOwnershipError('OWNER_STATE', 'only a preparing owner can activate')
    return this.withDatabase(true, db => {
      const current = rowFromObservation(db, owner.kind)
      if (!current || current.owner.ownerId !== owner.ownerId || current.owner.generation !== owner.generation || current.owner.state !== 'preparing') throw new RuntimeOwnershipError('OWNER_CHANGED', 'runtime owner changed before activation')
      db.prepare('UPDATE runtime_owners SET state=?, locator_sha256=?, activated_at=? WHERE kind=? AND owner_id=? AND generation=?').run('active', locatorSha256, now(), owner.kind, owner.ownerId, owner.generation)
      const active = { ...current.owner, state: 'active' as const, locatorSha256 }
      this.audit(db, owner.kind, 'activate', current.rowSha256, active, {})
      return active
    }, (db, active) => this.assertOwnerCommitted(db, active))
  }

  republishActive(owner: RuntimeOwner, expectedLocatorSha256: string | null, nextLocatorSha256: string): RuntimeOwner {
    assertHash(expectedLocatorSha256)
    assertHash(nextLocatorSha256)
    return this.withDatabase(true, db => {
      const current = rowFromObservation(db, owner.kind)
      if (!current || current.owner.ownerId !== owner.ownerId || current.owner.generation !== owner.generation || current.owner.state !== 'active' || current.owner.locatorSha256 !== expectedLocatorSha256) throw new RuntimeOwnershipError('OWNER_CHANGED', 'runtime owner changed before republish')
      db.prepare('UPDATE runtime_owners SET locator_sha256=? WHERE kind=? AND owner_id=? AND generation=?').run(nextLocatorSha256, owner.kind, owner.ownerId, owner.generation)
      const active = { ...current.owner, locatorSha256: nextLocatorSha256 }
      this.audit(db, owner.kind, 'republish', current.rowSha256, active, { expectedLocatorSha256 })
      return active
    }, (db, active) => this.assertOwnerCommitted(db, active))
  }

  resolveActive(kind: RuntimeOwnerKind, locator: RuntimeLocator, locatorSha256: string): RuntimeOwner {
    assertHash(locatorSha256)
    return this.withDatabase(false, db => {
      const current = rowFromObservation(db, kind)
      if (!current || current.owner.state !== 'active') throw new RuntimeOwnershipError('OWNER_UNAVAILABLE', 'no active runtime owner is recorded')
      const owner = current.owner
      if (owner.locatorSha256 !== locatorSha256 || locator.version !== 2 || locator.ownerId !== owner.ownerId || locator.ownerGeneration !== owner.generation || locator.socketPath !== owner.endpoint || locator.authToken !== owner.authToken || JSON.stringify(locator.processIdentity) !== identityJson(owner.identity)) {
        throw new RuntimeOwnershipError('OWNER_MISMATCH', 'runtime locator does not match the active owner')
      }
      return owner
    })
  }

  release(owner: RuntimeOwner): boolean {
    return this.withDatabase(true, db => {
      const result = db.prepare('DELETE FROM runtime_owners WHERE kind=? AND owner_id=? AND generation=?').run(owner.kind, owner.ownerId, owner.generation)
      const deleted = Number(result.changes) === 1
      if (deleted) this.audit(db, owner.kind, 'release', rowHash(owner), owner, {})
      return deleted
    }, (db, deleted) => {
      if (deleted && db.prepare('SELECT 1 FROM runtime_owners WHERE kind=? AND owner_id=? AND generation=?').get(owner.kind, owner.ownerId, owner.generation)) {
        throw new RuntimeOwnershipError('DATABASE_UNSAFE', 'runtime owner release was not durable at the canonical authority')
      }
    })
  }
  abandonPreparing(owner: RuntimeOwner): boolean {
    if (owner.state !== 'preparing') return false
    return this.withDatabase(true, db => {
      const deleted = Number(db.prepare('DELETE FROM runtime_owners WHERE kind=? AND owner_id=? AND generation=? AND state=?').run(
        owner.kind, owner.ownerId, owner.generation, 'preparing').changes) === 1
      if (deleted) this.audit(db, owner.kind, 'abandon-preparing', rowHash(owner), owner, {})
      return deleted
    }, (db, deleted) => {
      if (deleted && db.prepare('SELECT 1 FROM runtime_owners WHERE kind=? AND owner_id=? AND generation=?').get(owner.kind, owner.ownerId, owner.generation)) {
        throw new RuntimeOwnershipError('DATABASE_UNSAFE', 'runtime owner abandonment was not durable at the canonical authority')
      }
    })
  }

  beginEndpointCleanup(successor: RuntimeOwner, predecessor: RuntimeEndpointCleanupPredecessor): RuntimeEndpointCleanup {
    assertKind(successor.kind)
    assertOwnerId(successor.ownerId)
    assertHash(successor.locatorSha256)
    if (successor.state !== 'active') throw new RuntimeOwnershipError('INVALID_TRANSITION', 'endpoint cleanup successor was not active')
    if (!OWNER_ID.test(predecessor.ownerId) || predecessor.ownerId === successor.ownerId
      || !Number.isSafeInteger(predecessor.generation) || predecessor.generation < 1 || predecessor.generation >= successor.generation
      || typeof predecessor.endpoint !== 'string' || predecessor.endpoint.length === 0 || predecessor.endpoint.length > 4096 || predecessor.endpoint.includes('\0')) {
      throw new RuntimeOwnershipError('INVALID_CLEANUP', 'endpoint cleanup predecessor was invalid')
    }
    const expectedFileIdentity = parseEndpointIdentity(endpointIdentityJson(predecessor.endpointFileIdentity))
    if (expectedFileIdentity === null) throw new RuntimeOwnershipError('INVALID_CLEANUP', 'endpoint cleanup predecessor identity was missing')
    return this.withDatabase(true, db => {
      const current = rowFromObservation(db, successor.kind)
      if (!current || !sameOwner(current.owner, successor)) throw new RuntimeOwnershipError('OBSERVATION_CONFLICT', 'runtime owner changed before endpoint cleanup intent was recorded')
      const existingRow = db.prepare('SELECT id, kind, successor_owner_id, successor_generation, predecessor_owner_id, predecessor_generation, endpoint, quarantine_path, expected_identity_json, created_at FROM runtime_endpoint_cleanups WHERE endpoint=?').get(predecessor.endpoint) as Record<string, unknown> | undefined
      if (existingRow) {
        const existing = parseEndpointCleanup(existingRow)
        if (existing.kind === successor.kind && existing.successorOwnerId === successor.ownerId && existing.successorGeneration === successor.generation
          && existing.predecessorOwnerId === predecessor.ownerId && existing.predecessorGeneration === predecessor.generation
          && identityKey(existing.expectedFileIdentity) === identityKey(expectedFileIdentity)) return existing
        throw new RuntimeOwnershipError('CLEANUP_PENDING', 'another endpoint cleanup is already pending')
      }
      const id = randomUUID().toLowerCase()
      const quarantinePath = predecessor.endpoint + '.cleanup-' + id
      if (quarantinePath.length > 4096) throw new RuntimeOwnershipError('INVALID_CLEANUP', 'endpoint cleanup quarantine path was too long')
      const createdAt = now()
      db.prepare('INSERT INTO runtime_endpoint_cleanups(id,kind,successor_owner_id,successor_generation,predecessor_owner_id,predecessor_generation,endpoint,quarantine_path,expected_identity_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(
        id, successor.kind, successor.ownerId, successor.generation, predecessor.ownerId, predecessor.generation, predecessor.endpoint, quarantinePath, endpointIdentityJson(expectedFileIdentity), createdAt)
      return { id, kind: successor.kind, successorOwnerId: successor.ownerId, successorGeneration: successor.generation, predecessorOwnerId: predecessor.ownerId, predecessorGeneration: predecessor.generation, endpoint: predecessor.endpoint, quarantinePath, expectedFileIdentity, createdAt }
    }, (db, cleanup) => {
      const row = db.prepare('SELECT id, kind, successor_owner_id, successor_generation, predecessor_owner_id, predecessor_generation, endpoint, quarantine_path, expected_identity_json, created_at FROM runtime_endpoint_cleanups WHERE id=?').get(cleanup.id) as Record<string, unknown> | undefined
      if (!row || !sameEndpointCleanup(parseEndpointCleanup(row), cleanup)) throw new RuntimeOwnershipError('DATABASE_UNSAFE', 'endpoint cleanup intent was not durable at the canonical authority')
    })
  }

  listEndpointCleanups(kind: RuntimeOwnerKind): RuntimeEndpointCleanup[] {
    assertKind(kind)
    return this.withDatabase(false, db => (db.prepare('SELECT id, kind, successor_owner_id, successor_generation, predecessor_owner_id, predecessor_generation, endpoint, quarantine_path, expected_identity_json, created_at FROM runtime_endpoint_cleanups WHERE kind=? ORDER BY created_at,id').all(kind) as Array<Record<string, unknown>>).map(parseEndpointCleanup))
  }

  completeEndpointCleanup(cleanup: RuntimeEndpointCleanup): boolean {
    const expected = parseEndpointCleanup({ id: cleanup.id, kind: cleanup.kind, successor_owner_id: cleanup.successorOwnerId, successor_generation: cleanup.successorGeneration, predecessor_owner_id: cleanup.predecessorOwnerId, predecessor_generation: cleanup.predecessorGeneration, endpoint: cleanup.endpoint, quarantine_path: cleanup.quarantinePath, expected_identity_json: endpointIdentityJson(cleanup.expectedFileIdentity), created_at: cleanup.createdAt })
    return this.withDatabase(true, db => {
      const row = db.prepare('SELECT id, kind, successor_owner_id, successor_generation, predecessor_owner_id, predecessor_generation, endpoint, quarantine_path, expected_identity_json, created_at FROM runtime_endpoint_cleanups WHERE id=?').get(expected.id) as Record<string, unknown> | undefined
      if (!row) return false
      if (!sameEndpointCleanup(parseEndpointCleanup(row), expected)) throw new RuntimeOwnershipError('CLEANUP_CONFLICT', 'endpoint cleanup record changed before completion')
      return Number(db.prepare('DELETE FROM runtime_endpoint_cleanups WHERE id=?').run(expected.id).changes) === 1
    }, db => {
      if (db.prepare('SELECT id FROM runtime_endpoint_cleanups WHERE id=?').get(expected.id)) throw new RuntimeOwnershipError('DATABASE_UNSAFE', 'endpoint cleanup completion was not durable at the canonical authority')
    })
  }

  findLegacyRecovery(match: LegacyRecoveryMatch): LegacyRecoveryRecord | null {
    assertKind(match.kind)
    if (!HASH.test(match.expectedFingerprint)) throw new RuntimeOwnershipError('INVALID_RECOVERY', 'legacy recovery fingerprint was invalid')
    return this.withDatabase(false, db => {
      const rows = db.prepare('SELECT id, kind, expected_fingerprint, state, detail_json, created_at, updated_at FROM runtime_recovery_operations WHERE kind=? AND expected_fingerprint=? AND state=?').all(match.kind, match.expectedFingerprint, 'committed') as Array<Record<string, unknown>>
      for (const row of rows) {
        let detail
        try { detail = parseRecoveryDetail(JSON.parse(String(row['detail_json']))) } catch { throw new RuntimeOwnershipError('INVALID_RECOVERY', 'legacy recovery detail was malformed') }
        if (JSON.stringify(detail.fileIdentity) !== JSON.stringify(match.fileIdentity) || detail.endpoint !== match.endpoint || detail.recordType !== match.recordType) continue
        return {
          id: String(row['id']), kind: match.kind, expectedFingerprint: String(row['expected_fingerprint']),
          fileIdentity: detail.fileIdentity, evidencePath: detail.evidencePath, evidenceFileIdentity: detail.evidenceFileIdentity,
          endpoint: detail.endpoint, recordType: detail.recordType,
          state: 'committed', createdAt: String(row['created_at']), updatedAt: String(row['updated_at'])
        }
      }
      return null
    })
  }

  recordLegacyRecovery(input: LegacyRecoveryInput): LegacyRecoveryRecord {
    assertKind(input.kind)
    if (!HASH.test(input.expectedFingerprint)) throw new RuntimeOwnershipError('INVALID_RECOVERY', 'legacy recovery fingerprint was invalid')
    const id = input.id ?? randomUUID()
    return this.withDatabase(true, db => {
      const existing = db.prepare('SELECT id, kind, expected_fingerprint, state, detail_json, created_at, updated_at FROM runtime_recovery_operations WHERE id=?').get(id) as Record<string, unknown> | undefined
      if (existing) {
        let detail
        try { detail = parseRecoveryDetail(JSON.parse(String(existing['detail_json']))) } catch { throw new RuntimeOwnershipError('INVALID_RECOVERY', 'legacy recovery detail was malformed') }
        if (existing['kind'] !== input.kind || existing['expected_fingerprint'] !== input.expectedFingerprint
          || JSON.stringify(detail.fileIdentity) !== JSON.stringify(input.fileIdentity)
          || JSON.stringify(detail.evidenceFileIdentity) !== JSON.stringify(input.evidenceFileIdentity)
          || detail.evidencePath !== input.evidencePath || detail.endpoint !== input.endpoint || detail.recordType !== input.recordType) {
          throw new RuntimeOwnershipError('RECOVERY_DUPLICATE', 'legacy recovery ID is bound to different evidence or endpoint')
        }
        return {
          id: String(existing['id']), kind: input.kind, expectedFingerprint: String(existing['expected_fingerprint']),
          fileIdentity: detail.fileIdentity, evidencePath: detail.evidencePath, evidenceFileIdentity: detail.evidenceFileIdentity,
          endpoint: detail.endpoint, recordType: detail.recordType,
          state: 'committed', createdAt: String(existing['created_at']), updatedAt: String(existing['updated_at'])
        }
      }
      const createdAt = now()
      db.prepare('INSERT INTO runtime_recovery_operations(id,kind,expected_fingerprint,state,detail_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(
        id, input.kind, input.expectedFingerprint, 'committed', JSON.stringify({ fileIdentity: input.fileIdentity, evidencePath: input.evidencePath, evidenceFileIdentity: input.evidenceFileIdentity, endpoint: input.endpoint, recordType: input.recordType }), createdAt, createdAt)
      return { ...input, id, state: 'committed', createdAt, updatedAt: createdAt }
    }, (db, recovery) => {
      const row = db.prepare('SELECT kind, expected_fingerprint, state, detail_json FROM runtime_recovery_operations WHERE id=?').get(recovery.id) as Record<string, unknown> | undefined
      if (!row || row['kind'] !== recovery.kind || row['expected_fingerprint'] !== recovery.expectedFingerprint || row['state'] !== 'committed') {
        throw new RuntimeOwnershipError('DATABASE_UNSAFE', 'runtime recovery record was not durable at the canonical authority')
      }
      const detail = parseRecoveryDetail(JSON.parse(String(row['detail_json'])))
      if (JSON.stringify(detail.fileIdentity) !== JSON.stringify(recovery.fileIdentity)
        || JSON.stringify(detail.evidenceFileIdentity) !== JSON.stringify(recovery.evidenceFileIdentity)
        || detail.evidencePath !== recovery.evidencePath || detail.endpoint !== recovery.endpoint || detail.recordType !== recovery.recordType) {
        throw new RuntimeOwnershipError('DATABASE_UNSAFE', 'runtime recovery evidence was not durable at the canonical authority')
      }
    })
  }

  private audit(db: DatabaseSync, kind: RuntimeOwnerKind, action: string, priorRowSha256: string | null, owner: RuntimeOwner, detail: Record<string, unknown>): void {
    db.prepare('INSERT INTO runtime_ownership_audit(kind,action,prior_row_sha256,owner_id,generation,detail_json,created_at) VALUES(?,?,?,?,?,?,?)').run(
      kind, action, priorRowSha256, owner.ownerId, owner.generation, JSON.stringify(detail), now())
  }
}

/** Observe authority without creating, migrating, checkpointing, or otherwise mutating it. */
export function observeRuntimeOwnerReadOnly(databasePath: string, kind: RuntimeOwnerKind): RuntimeOwnerObservation {
  assertKind(kind)
  const directory = canonicalPrivateDirectory(dirname(databasePath), { requireCanonical: true })
  const canonicalPath = join(directory, basename(databasePath))
  try {
    privateRuntimeFileIdentityReader()(canonicalPath)
  } catch (error) {
    if (error instanceof RuntimeFileSecurityError && error.code === 'not-found') return { status: 'vacant', lastGeneration: 0 }
    throw error
  }
  const store = new RuntimeOwnershipStore(canonicalPath, { readOnly: true })
  try {
    return store.observe(kind)
  } finally {
    store.close()
  }
}
