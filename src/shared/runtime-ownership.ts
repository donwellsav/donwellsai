import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, openSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { basename, dirname, join } from 'node:path'
import type { ProcessIdentity, ProcessIdentityVerdict } from './child-process/process-spec'
import { canonicalPrivateDirectory, privateRuntimeFileReader, readPrivateRuntimeFile, type RuntimeFileReader } from './runtime-file-security'

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
  endpoint: string
}
export type LegacyRecoveryMatch = Pick<LegacyRecoveryInput, 'kind' | 'expectedFingerprint' | 'fileIdentity' | 'endpoint'>

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
  const endpoint = String(row['endpoint'])
  const authToken = String(row['auth_token'])
  const locatorSha256 = row['locator_sha256'] === null ? null : String(row['locator_sha256'])
  if (!endpoint || !authToken || (state === 'preparing' && locatorSha256 !== null) || (state === 'active' && (locatorSha256 === null || !HASH.test(locatorSha256)))) {
    throw new RuntimeOwnershipError('OWNER_CORRUPT', 'persisted runtime owner fields violated state invariants')
  }
  return { kind, ownerId, generation, state, identity, endpoint, authToken, locatorSha256 }
}

function lastGeneration(db: DatabaseSync, kind: RuntimeOwnerKind): number {
  const row = db.prepare('SELECT last_generation FROM runtime_owner_generations WHERE kind = ?').get(kind) as Record<string, unknown> | undefined
  if (!row) return 0
  const generation = Number(row['last_generation'])
  if (!Number.isSafeInteger(generation) || generation < 1) throw new RuntimeOwnershipError('OWNER_CORRUPT', 'persisted runtime generation watermark was invalid')
  return generation
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

type StoreOptions = { readOnly?: boolean; fileReader?: RuntimeFileReader }

export class RuntimeOwnershipStore {
  readonly databasePath: string
  private readonly db: DatabaseSync
  private readonly fileReader: RuntimeFileReader
  private readonly readOnly: boolean
  constructor(databasePath: string, options: StoreOptions = {}) {
    this.readOnly = options.readOnly === true
    this.fileReader = options.fileReader ?? privateRuntimeFileReader()
    const directory = canonicalPrivateDirectory(dirname(databasePath), { create: !this.readOnly })
    this.databasePath = join(directory, basename(databasePath))
    try {
      const descriptor = openSync(this.databasePath, this.readOnly ? 'r' : 'wx', 0o600)
      closeSync(descriptor)
    } catch (error) {
      if (!this.readOnly && (error as NodeJS.ErrnoException).code === 'EEXIST') {
        // Existing files are checked through the native same-handle boundary below.
      } else {
        throw error
      }
    }
    let validatedIdentity: string
    try {
      validatedIdentity = JSON.stringify(readPrivateRuntimeFile(this.databasePath, 8 * 1024 * 1024, this.fileReader).fileIdentity)
    } catch (error) {
      throw new RuntimeOwnershipError('DATABASE_UNSAFE', error instanceof Error ? error.message : String(error))
    }
    this.db = this.readOnly ? new DatabaseSync(this.databasePath, { readOnly: true }) : new DatabaseSync(this.databasePath)
    try {
      const openedIdentity = JSON.stringify(readPrivateRuntimeFile(this.databasePath, 8 * 1024 * 1024, this.fileReader).fileIdentity)
      if (openedIdentity !== validatedIdentity) throw new RuntimeOwnershipError('DATABASE_CHANGED', 'runtime ownership database path changed while it was opened')
    } catch (error) {
      this.db.close()
      if (error instanceof RuntimeOwnershipError) throw error
      throw new RuntimeOwnershipError('DATABASE_UNSAFE', error instanceof Error ? error.message : String(error))
    }
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
        CREATE TABLE runtime_owner_generations (
          kind TEXT PRIMARY KEY,
          last_generation INTEGER NOT NULL
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
        PRAGMA user_version=2;
      `)
    } else if (version === 1 && !this.readOnly) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE runtime_owner_generations (
          kind TEXT PRIMARY KEY,
          last_generation INTEGER NOT NULL
        );
        INSERT INTO runtime_owner_generations(kind,last_generation)
          SELECT kind, MAX(generation) FROM runtime_owners GROUP BY kind;
        PRAGMA user_version=2;
        COMMIT;
      `)
    } else if (version !== 2) {
      this.db.close()
      throw new RuntimeOwnershipError('SCHEMA_UNSUPPORTED', 'runtime ownership database schema is unsupported')
    }
    try {
      const ownerRows = this.db.prepare('SELECT kind, owner_id, generation, state, identity_json, endpoint, auth_token, locator_sha256 FROM runtime_owners').all() as Array<Record<string, unknown>>
      for (const row of ownerRows) {
        const owner = parseRow(row)
        if (lastGeneration(this.db, owner.kind) !== owner.generation) throw new RuntimeOwnershipError('OWNER_CORRUPT', 'runtime generation watermark did not match its owner row')
      }
      const generationRows = this.db.prepare('SELECT kind, last_generation FROM runtime_owner_generations').all() as Array<Record<string, unknown>>
      for (const row of generationRows) {
        const kind = String(row['kind'])
        if (kind !== 'donwells-app' && kind !== 'terminal-daemon') throw new RuntimeOwnershipError('OWNER_CORRUPT', 'persisted runtime generation kind was invalid')
        lastGeneration(this.db, kind)
      }
    } catch (error) {
      this.db.close()
      throw error
    }
    this.validateAuxiliaryFiles()
  }

  private validateAuxiliaryFiles(): void {
    for (const suffix of ['-wal', '-shm']) {
      const path = this.databasePath + suffix
      if (!existsSync(path)) continue
      try {
        readPrivateRuntimeFile(path, 8 * 1024 * 1024, this.fileReader)
      } catch (error) {
        this.db.close()
        throw new RuntimeOwnershipError('DATABASE_UNSAFE', error instanceof Error ? error.message : String(error))
      }
    }
  }
  close(): void {
    this.db.close()
  }

  observe(kind: RuntimeOwnerKind): RuntimeOwnerObservation {
    assertKind(kind)
    const result = rowFromObservation(this.db, kind)
    const generation = lastGeneration(this.db, kind)
    if (result && result.owner.generation !== generation) throw new RuntimeOwnershipError('OWNER_CORRUPT', 'runtime generation watermark did not match its owner row')
    return result ? { status: 'present', owner: result.owner, rowSha256: result.rowSha256 } : { status: 'vacant', lastGeneration: generation }
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
      const generationWatermark = lastGeneration(this.db, candidate.kind)
      if (observed.status === 'vacant'
        ? current !== null || generationWatermark !== observed.lastGeneration
        : current === null || current.rowSha256 !== observed.rowSha256 || generationWatermark !== current.owner.generation) {
        throw new RuntimeOwnershipError('OWNER_CHANGED', 'runtime owner changed after observation')
      }
      const generation = generationWatermark + 1
      if (candidate.identity.family !== candidate.kind || candidate.identity.generation !== candidate.ownerId + ':' + generation) {
        throw new RuntimeOwnershipError('OWNER_MISMATCH', 'runtime process identity generation did not match its owner row')
      }
      const owner: RuntimeOwner = { ...candidate, generation, state: 'preparing', locatorSha256: null }
      this.db.prepare('INSERT INTO runtime_owner_generations(kind,last_generation) VALUES(?,?) ON CONFLICT(kind) DO UPDATE SET last_generation=excluded.last_generation').run(owner.kind, generation)
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

  findLegacyRecovery(match: LegacyRecoveryMatch): LegacyRecoveryRecord | null {
    assertKind(match.kind)
    if (!HASH.test(match.expectedFingerprint)) throw new RuntimeOwnershipError('INVALID_RECOVERY', 'legacy recovery fingerprint was invalid')
    const rows = this.db.prepare('SELECT id, kind, expected_fingerprint, state, detail_json, created_at, updated_at FROM runtime_recovery_operations WHERE kind=? AND expected_fingerprint=? AND state=?').all(match.kind, match.expectedFingerprint, 'committed') as Array<Record<string, unknown>>
    for (const row of rows) {
      let detail: { fileIdentity: Record<string, string>; evidencePath: string; endpoint: string }
      try { detail = JSON.parse(String(row['detail_json'])) as typeof detail } catch { throw new RuntimeOwnershipError('INVALID_RECOVERY', 'legacy recovery detail was malformed') }
      if (JSON.stringify(detail.fileIdentity) !== JSON.stringify(match.fileIdentity) || detail.endpoint !== match.endpoint) continue
      return {
        id: String(row['id']),
        kind: match.kind,
        expectedFingerprint: String(row['expected_fingerprint']),
        fileIdentity: detail.fileIdentity,
        evidencePath: detail.evidencePath,
        endpoint: detail.endpoint,
        state: 'committed',
        createdAt: String(row['created_at']),
        updatedAt: String(row['updated_at'])
      }
    }
    return null
  }
  recordLegacyRecovery(input: LegacyRecoveryInput): LegacyRecoveryRecord {
    if (this.readOnly) throw new RuntimeOwnershipError('READ_ONLY', 'runtime ownership database is read-only')
    assertKind(input.kind)
    if (!HASH.test(input.expectedFingerprint)) throw new RuntimeOwnershipError('INVALID_RECOVERY', 'legacy recovery fingerprint was invalid')
    const id = input.id ?? randomUUID()
    const existing = this.db.prepare('SELECT id, kind, expected_fingerprint, state, detail_json, created_at, updated_at FROM runtime_recovery_operations WHERE id=?').get(id) as Record<string, unknown> | undefined
    if (existing) {
      let detail: { fileIdentity: Record<string, string>; evidencePath: string; endpoint: string }
      try { detail = JSON.parse(String(existing['detail_json'])) as typeof detail } catch { throw new RuntimeOwnershipError('INVALID_RECOVERY', 'legacy recovery detail was malformed') }
      if (existing['kind'] !== input.kind || existing['expected_fingerprint'] !== input.expectedFingerprint
        || JSON.stringify(detail.fileIdentity) !== JSON.stringify(input.fileIdentity)
        || detail.evidencePath !== input.evidencePath || detail.endpoint !== input.endpoint) {
        throw new RuntimeOwnershipError('RECOVERY_DUPLICATE', 'legacy recovery ID is bound to different evidence or endpoint')
      }
      return {
        id: String(existing['id']), kind: input.kind, expectedFingerprint: String(existing['expected_fingerprint']),
        fileIdentity: detail.fileIdentity, evidencePath: detail.evidencePath, endpoint: detail.endpoint,
        state: 'committed', createdAt: String(existing['created_at']), updatedAt: String(existing['updated_at'])
      }
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
