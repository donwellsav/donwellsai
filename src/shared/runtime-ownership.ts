import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, mkdirSync, openSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname } from 'node:path'
import type { ProcessIdentity, ProcessIdentityVerdict } from './child-process/process-spec'

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
}

export type RuntimeOwnerObservation =
  | { status: 'vacant' }
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
  endpoint: string
}

export type LegacyRecoveryRecord = LegacyRecoveryInput & {
  id: string
  state: 'committed'
  createdAt: string
  updatedAt: string
}

export class RuntimeOwnershipError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RuntimeOwnershipError'
  }
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

function rowHash(row: RuntimeOwner): string {
  return createHash('sha256').update(JSON.stringify({
    kind: row.kind,
    owner_id: row.ownerId,
    generation: row.generation,
    state: row.state,
    identity_json: identityJson(row.identity),
    endpoint: row.endpoint,
    auth_token: row.authToken,
    locator_sha256: row.locatorSha256
  })).digest('hex')
}

function parseRow(row: Record<string, unknown>): RuntimeOwner {
  const kindValue = String(row['kind'])
  assertKind(kindValue)
  const kind = kindValue
  const ownerId = String(row['owner_id'])
  assertOwnerId(ownerId)
  const generation = Number(row['generation'])
  if (!Number.isSafeInteger(generation) || generation < 1) throw new RuntimeOwnershipError('INVALID_ROW', 'runtime owner generation was invalid')
  const state = row['state']
  if (state !== 'preparing' && state !== 'active') throw new RuntimeOwnershipError('INVALID_ROW', 'runtime owner state was invalid')
  let identity: ProcessIdentity
  try {
    identity = JSON.parse(String(row['identity_json'])) as ProcessIdentity
  } catch {
    throw new RuntimeOwnershipError('INVALID_ROW', 'runtime owner identity was malformed')
  }
  if (typeof identity !== 'object' || identity === null || typeof identity.pid !== 'number' || typeof identity.bootId !== 'string' || typeof identity.startedAt !== 'string' || typeof identity.executablePath !== 'string' || (identity.family !== 'donwells-app' && identity.family !== 'terminal-daemon')) {
    throw new RuntimeOwnershipError('INVALID_ROW', 'runtime owner identity was malformed')
  }
  const endpoint = String(row['endpoint'])
  const authToken = String(row['auth_token'])
  const locatorSha256 = row['locator_sha256'] === null ? null : String(row['locator_sha256'])
  if (!endpoint || !authToken) throw new RuntimeOwnershipError('INVALID_ROW', 'runtime owner endpoint or token was empty')
  assertHash(locatorSha256)
  return { kind, ownerId, generation, state, identity, endpoint, authToken, locatorSha256 }
}

function rowFromObservation(db: DatabaseSync, kind: RuntimeOwnerKind): { owner: RuntimeOwner; rowSha256: string } | null {
  const raw = db.prepare('SELECT kind, owner_id, generation, state, identity_json, endpoint, auth_token, locator_sha256 FROM runtime_owners WHERE kind = ?').get(kind) as Record<string, unknown> | undefined
  if (!raw) return null
  const owner = parseRow(raw)
  return { owner, rowSha256: rowHash(owner) }
}

function now(): string {
  return new Date().toISOString()
}

type StoreOptions = { readOnly?: boolean }

export class RuntimeOwnershipStore {
  private readonly db: DatabaseSync
  private readonly readOnly: boolean

  constructor(readonly databasePath: string, options: StoreOptions = {}) {
    this.readOnly = options.readOnly === true
    const directory = dirname(databasePath)
    if (!this.readOnly) mkdirSync(directory, { recursive: true, mode: 0o700 })
    try {
      const descriptor = openSync(databasePath, this.readOnly ? 'r' : 'wx', 0o600)
      closeSync(descriptor)
    } catch (error) {
      if (!this.readOnly && (error as NodeJS.ErrnoException).code === 'EEXIST') {
        // Existing files are checked below.
      } else {
        throw error
      }
    }
    const stat = statSync(databasePath)
    if (!stat.isFile() || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))) {
      throw new RuntimeOwnershipError('DATABASE_UNSAFE', 'runtime ownership database must be a private file')
    }
    if (!this.readOnly && process.platform !== 'win32') chmodSync(databasePath, 0o600)
    this.db = this.readOnly ? new DatabaseSync(databasePath, { readOnly: true }) : new DatabaseSync(databasePath)
    if (this.readOnly) {
      this.db.exec('PRAGMA busy_timeout=1000')
    } else {
      this.db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL')
    }
    const version = Number((this.db.prepare('PRAGMA user_version').get() as Record<string, unknown>)['user_version'])
    if (version === 0 && !this.readOnly) {
      this.db.exec(`
        CREATE TABLE runtime_owners (
          kind TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('preparing','active')),
          identity_json TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          auth_token TEXT NOT NULL,
          locator_sha256 TEXT,
          claimed_at TEXT NOT NULL,
          activated_at TEXT
        );
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
        CREATE TABLE runtime_recovery_operations (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          expected_fingerprint TEXT NOT NULL,
          state TEXT NOT NULL,
          detail_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        PRAGMA user_version=1;
      `)
    } else if (version !== 1) {
      this.db.close()
      throw new RuntimeOwnershipError('SCHEMA_UNSUPPORTED', 'runtime ownership database schema is unsupported')
    }
  }

  close(): void {
    this.db.close()
  }

  observe(kind: RuntimeOwnerKind): RuntimeOwnerObservation {
    assertKind(kind)
    const result = rowFromObservation(this.db, kind)
    return result ? { status: 'present', owner: result.owner, rowSha256: result.rowSha256 } : { status: 'vacant' }
  }

  prepareClaim(candidate: Omit<RuntimeOwner, 'generation' | 'state' | 'locatorSha256'>, observed: RuntimeOwnerObservation, verdict: ProcessIdentityVerdict | null): RuntimeOwner {
    if (this.readOnly) throw new RuntimeOwnershipError('READ_ONLY', 'runtime ownership database is read-only')
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
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = rowFromObservation(this.db, candidate.kind)
      if (observed.status === 'vacant' ? current !== null : current === null || current.rowSha256 !== observed.rowSha256) {
        throw new RuntimeOwnershipError('OWNER_CHANGED', 'runtime owner changed after observation')
      }
      const generation = current ? current.owner.generation + 1 : 1
      const owner: RuntimeOwner = { ...candidate, generation, state: 'preparing', locatorSha256: null }
      if (current) {
        this.db.prepare(`UPDATE runtime_owners SET owner_id=?, generation=?, state=?, identity_json=?, endpoint=?, auth_token=?, locator_sha256=NULL, claimed_at=?, activated_at=NULL WHERE kind=?`).run(
          owner.ownerId, owner.generation, owner.state, identityJson(owner.identity), owner.endpoint, owner.authToken, claimedAt, owner.kind)
      } else {
        this.db.prepare(`INSERT INTO runtime_owners(kind,owner_id,generation,state,identity_json,endpoint,auth_token,locator_sha256,claimed_at,activated_at) VALUES(?,?,?,?,?,?,?,NULL,?,NULL)`).run(
          owner.kind, owner.ownerId, owner.generation, owner.state, identityJson(owner.identity), owner.endpoint, owner.authToken, claimedAt)
      }
      this.audit(owner.kind, 'prepare', observed.status === 'present' ? observed.rowSha256 : null, owner, { verdict: verdict?.status ?? null })
      this.db.exec('COMMIT')
      return owner
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  activate(owner: RuntimeOwner, locatorSha256: string): RuntimeOwner {
    if (this.readOnly) throw new RuntimeOwnershipError('READ_ONLY', 'runtime ownership database is read-only')
    assertHash(locatorSha256)
    if (owner.state !== 'preparing') throw new RuntimeOwnershipError('OWNER_STATE', 'only a preparing owner can activate')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = rowFromObservation(this.db, owner.kind)
      if (!current || current.owner.ownerId !== owner.ownerId || current.owner.generation !== owner.generation || current.owner.state !== 'preparing') throw new RuntimeOwnershipError('OWNER_CHANGED', 'runtime owner changed before activation')
      this.db.prepare('UPDATE runtime_owners SET state=?, locator_sha256=?, activated_at=? WHERE kind=? AND owner_id=? AND generation=?').run('active', locatorSha256, now(), owner.kind, owner.ownerId, owner.generation)
      const active = { ...owner, state: 'active' as const, locatorSha256 }
      this.audit(owner.kind, 'activate', current.rowSha256, active, {})
      this.db.exec('COMMIT')
      return active
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  republishActive(owner: RuntimeOwner, expectedLocatorSha256: string | null, nextLocatorSha256: string): RuntimeOwner {
    if (this.readOnly) throw new RuntimeOwnershipError('READ_ONLY', 'runtime ownership database is read-only')
    assertHash(expectedLocatorSha256)
    assertHash(nextLocatorSha256)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = rowFromObservation(this.db, owner.kind)
      if (!current || current.owner.ownerId !== owner.ownerId || current.owner.generation !== owner.generation || current.owner.state !== 'active' || current.owner.locatorSha256 !== expectedLocatorSha256) throw new RuntimeOwnershipError('OWNER_CHANGED', 'runtime owner changed before republish')
      this.db.prepare('UPDATE runtime_owners SET locator_sha256=? WHERE kind=? AND owner_id=? AND generation=?').run(nextLocatorSha256, owner.kind, owner.ownerId, owner.generation)
      const active = { ...current.owner, locatorSha256: nextLocatorSha256 }
      this.audit(owner.kind, 'republish', current.rowSha256, active, { expectedLocatorSha256 })
      this.db.exec('COMMIT')
      return active
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  resolveActive(kind: RuntimeOwnerKind, locator: RuntimeLocator, locatorSha256: string): RuntimeOwner {
    assertHash(locatorSha256)
    const current = rowFromObservation(this.db, kind)
    if (!current || current.owner.state !== 'active') throw new RuntimeOwnershipError('OWNER_UNAVAILABLE', 'no active runtime owner is recorded')
    const owner = current.owner
    if (owner.locatorSha256 !== locatorSha256 || locator.version !== 2 || locator.ownerId !== owner.ownerId || locator.ownerGeneration !== owner.generation || locator.socketPath !== owner.endpoint || locator.authToken !== owner.authToken || JSON.stringify(locator.processIdentity) !== identityJson(owner.identity)) {
      throw new RuntimeOwnershipError('OWNER_MISMATCH', 'runtime locator does not match the active owner')
    }
    return owner
  }

  release(owner: RuntimeOwner): boolean {
    if (this.readOnly) throw new RuntimeOwnershipError('READ_ONLY', 'runtime ownership database is read-only')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.db.prepare('DELETE FROM runtime_owners WHERE kind=? AND owner_id=? AND generation=?').run(owner.kind, owner.ownerId, owner.generation)
      const deleted = Number(result.changes) === 1
      if (deleted) this.audit(owner.kind, 'release', rowHash(owner), owner, {})
      this.db.exec('COMMIT')
      return deleted
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  recordLegacyRecovery(input: LegacyRecoveryInput): LegacyRecoveryRecord {
    if (this.readOnly) throw new RuntimeOwnershipError('READ_ONLY', 'runtime ownership database is read-only')
    assertKind(input.kind)
    if (!HASH.test(input.expectedFingerprint)) throw new RuntimeOwnershipError('INVALID_RECOVERY', 'legacy recovery fingerprint was invalid')
    const id = input.id ?? randomUUID()
    const existing = this.db.prepare('SELECT id, kind, expected_fingerprint, state, detail_json, created_at, updated_at FROM runtime_recovery_operations WHERE id=?').get(id) as Record<string, unknown> | undefined
    if (existing) {
      const detail = JSON.parse(String(existing['detail_json'])) as { fileIdentity: Record<string, string>; evidencePath: string; endpoint: string }
      if (existing['kind'] !== input.kind || existing['expected_fingerprint'] !== input.expectedFingerprint || detail.evidencePath !== input.evidencePath) throw new RuntimeOwnershipError('RECOVERY_DUPLICATE', 'legacy recovery ID is bound to different evidence')
      return { ...input, id, state: 'committed', createdAt: String(existing['created_at']), updatedAt: String(existing['updated_at']) }
    }
    const createdAt = now()
    this.db.prepare('INSERT INTO runtime_recovery_operations(id,kind,expected_fingerprint,state,detail_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(
      id, input.kind, input.expectedFingerprint, 'committed', JSON.stringify({ fileIdentity: input.fileIdentity, evidencePath: input.evidencePath, endpoint: input.endpoint }), createdAt, createdAt)
    return { ...input, id, state: 'committed', createdAt, updatedAt: createdAt }
  }

  private audit(kind: RuntimeOwnerKind, action: string, priorRowSha256: string | null, owner: RuntimeOwner, detail: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO runtime_ownership_audit(kind,action,prior_row_sha256,owner_id,generation,detail_json,created_at) VALUES(?,?,?,?,?,?,?)').run(
      kind, action, priorRowSha256, owner.ownerId, owner.generation, JSON.stringify(detail), now())
  }
}
