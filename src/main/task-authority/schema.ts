import { closeSync, lstatSync, openSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { TaskAuthorityError } from '@shared/task-authority'
import {
  canonicalPrivateDirectory,
  privateRuntimeFileIdentityReader,
  RuntimeFileSecurityError,
  runtimeAuthorityLock,
  type RuntimeAuthorityLock,
  type RuntimeDirectoryValidator,
  type RuntimeFileIdentity,
  type RuntimeFileIdentityReader
} from '@shared/runtime-file-security'

/**
 * Private daemon-owned SQLite authority for task facts. The daemon is the
 * eventual sole writer; this module owns file privacy validation, WAL
 * durability pragmas, schema versioning, and the single transaction wrapper
 * (`BEGIN IMMEDIATE`, foreign_keys=ON, busy_timeout=1000, WAL,
 * synchronous=FULL) used by every mutation.
 */

export const TASK_AUTHORITY_SCHEMA_VERSION = 1
export const TASK_AUTHORITY_FILE_NAME = 'task-authority.sqlite'

export class TaskAuthorityDatabaseError extends Error {
  readonly code: 'DATABASE_UNSAFE' | 'DATABASE_CLOSED' | 'SCHEMA_UNSUPPORTED' | 'DATABASE_CHANGED' | 'READ_ONLY'

  constructor(code: TaskAuthorityDatabaseError['code'], message: string) {
    super(message)
    this.name = 'TaskAuthorityDatabaseError'
    this.code = code
  }
}

/**
 * Fencing side effects (quarantine, offer expiry) must survive the error that
 * reports them. The kernel throws this wrapper after its mutation statements;
 * the transaction wrapper commits those statements and only then rethrows the
 * wrapped semantic error. Never used to persist partial ordinary mutations.
 */
export class DeferredAuthorityError extends Error {
  readonly authorityError: Error

  constructor(authorityError: Error) {
    super(authorityError.message)
    this.name = 'DeferredAuthorityError'
    this.authorityError = authorityError
  }
}

export type TaskAuthorityDatabaseOptions = Readonly<{
  /** Explicit database file path (tests). Mutually exclusive with userDataDirectory. */
  databasePath?: string
  /** Directory used to resolve <userData>/task-authority.sqlite (production daemon). */
  userDataDirectory?: string
  authorityLock?: RuntimeAuthorityLock
  identityReader?: RuntimeFileIdentityReader
  directoryValidator?: RuntimeDirectoryValidator
}>

const REQUIRED_TABLES = [
  'projects', 'tasks', 'task_dependencies', 'attempts', 'leases', 'lease_renewals',
  'handoff_offers', 'execution_specifications', 'launch_intents', 'runtime_reconciliations',
  'schedules', 'schedule_executions', 'run_groups', 'run_members', 'run_group_mutation_receipts',
  'resource_reservations', 'verification_artifacts', 'artifact_adoptions', 'task_mailbox',
  'task_events', 'authority_profile_events', 'authority_state', 'migration_sources',
  'migration_entity_mappings', 'projection_checkpoints'
] as const

function fail(code: TaskAuthorityDatabaseError['code'], message: string): never {
  throw new TaskAuthorityDatabaseError(code, message)
}

function identityKey(identity: RuntimeFileIdentity): string {
  return JSON.stringify(identity)
}

function initializeSchema(db: DatabaseSync): void {
  const version = Number((db.prepare('PRAGMA user_version').get() as Record<string, unknown>)['user_version'])
  if (version === 0) {
    const objects = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<Record<string, unknown>>
    if (objects.length > 0) {
      throw new TaskAuthorityError('MIGRATION_REQUIRED', 'task authority database is unrecognized and not empty; refusing to initialize over foreign data')
    }
    db.exec(SCHEMA_V1)
    db.exec(`PRAGMA user_version=${TASK_AUTHORITY_SCHEMA_VERSION}`)
    return
  }
  if (version !== TASK_AUTHORITY_SCHEMA_VERSION) {
    throw new TaskAuthorityError('DAEMON_UPGRADE_REQUIRED', `task authority database schema version ${version} is not supported by this daemon`)
  }
}

/** Full structural validation; run once at authority open, not per operation. */
export function validateTaskAuthorityDatabase(db: DatabaseSync): void {
  const version = Number((db.prepare('PRAGMA user_version').get() as Record<string, unknown>)['user_version'])
  if (version !== TASK_AUTHORITY_SCHEMA_VERSION) {
    throw new TaskAuthorityError('DAEMON_UPGRADE_REQUIRED', `task authority database schema version ${version} is not supported by this daemon`)
  }
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<Record<string, unknown>>
  const present: Record<string, true> = {}
  for (const row of rows) present[String(row['name'])] = true
  for (const table of REQUIRED_TABLES) {
    if (present[table] === undefined) {
      throw new TaskAuthorityError('DAEMON_UPGRADE_REQUIRED', `task authority database is missing required table "${table}"`)
    }
  }
  const check = db.prepare('PRAGMA quick_check').get() as Record<string, unknown>
  if (String(check['quick_check']) !== 'ok') {
    fail('SCHEMA_UNSUPPORTED', 'task authority database failed integrity check')
  }
}

export type TaskAuthorityDatabase = {
  readonly databasePath: string
  /** One write transaction: BEGIN IMMEDIATE, commit on success, rollback on error. Never retries semantic failures. */
  withImmediate<T>(operation: (db: DatabaseSync) => T): T
  /** Read-only connection under the shared authority lock. */
  withReadOnly<T>(operation: (db: DatabaseSync) => T): T
  close(): void
}

export function openTaskAuthorityDatabase(options: TaskAuthorityDatabaseOptions = {}): TaskAuthorityDatabase {
  if (options.databasePath !== undefined && options.userDataDirectory !== undefined) {
    fail('DATABASE_UNSAFE', 'task authority accepts either an explicit database path or a userData directory, not both')
  }
  const withAuthorityLock = options.authorityLock ?? runtimeAuthorityLock()
  const readIdentity = options.identityReader ?? privateRuntimeFileIdentityReader()
  let databasePath: string
  if (options.databasePath !== undefined) {
    if (typeof options.databasePath !== 'string' || options.databasePath.length === 0 || options.databasePath.includes('\0')) {
      fail('DATABASE_UNSAFE', 'task authority database path was malformed')
    }
    const directory = canonicalPrivateDirectory(dirname(options.databasePath), { create: true, requireCanonical: true, directoryValidator: options.directoryValidator })
    databasePath = join(directory, basename(options.databasePath))
  } else {
    const directory = canonicalPrivateDirectory(options.userDataDirectory ?? process.env['DONWELLS_TASK_AUTHORITY_DIR'] ?? '', {
      create: true,
      requireCanonical: true,
      directoryValidator: options.directoryValidator
    })
    databasePath = join(directory, TASK_AUTHORITY_FILE_NAME)
  }

  let pinnedIdentity: string | null = null
  let closed = false

  const ensureAuthorityFile = (): void => {
    let stat
    try {
      stat = lstatSync(databasePath)
    } catch {
      closeSync(openSync(databasePath, 'wx', 0o600))
      return
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail('DATABASE_UNSAFE', 'task authority database must be a regular private file, not a link or directory')
    }
    if (process.platform !== 'win32') {
      if ((process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) {
        fail('DATABASE_UNSAFE', 'task authority database must be owned by the current user with no group or world access')
      }
    }
  }

  const assertAuthorityIdentity = (): void => {
    let identity: RuntimeFileIdentity
    try {
      identity = readIdentity(databasePath)
    } catch (error) {
      if (error instanceof RuntimeFileSecurityError) {
        fail('DATABASE_UNSAFE', `task authority database failed the native private-file security contract: ${error.message}`)
      }
      throw error
    }
    const key = identityKey(identity)
    if (pinnedIdentity === null) pinnedIdentity = key
    else if (key !== pinnedIdentity) fail('DATABASE_CHANGED', 'task authority database identity changed during use')
  }

  const openConnection = (readOnly: boolean, stablePath: string): DatabaseSync => {
    const db = new DatabaseSync(stablePath, { readOnly })
    try {
      db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000')
      if (!readOnly) {
        const mode = db.prepare('PRAGMA journal_mode=WAL').get() as Record<string, unknown>
        if (String(mode['journal_mode']).toLowerCase() !== 'wal') {
          fail('DATABASE_UNSAFE', 'task authority database could not enter WAL mode on a private local filesystem')
        }
        db.exec('PRAGMA synchronous=FULL')
      }
      return db
    } catch (error) {
      db.close()
      if (error instanceof TaskAuthorityError || error instanceof TaskAuthorityDatabaseError) throw error
      fail('DATABASE_UNSAFE', 'task authority database setup failed: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  const run = <T>(write: boolean, operation: (db: DatabaseSync) => T): T => {
    if (closed) fail('DATABASE_CLOSED', 'task authority database is closed')
    return withAuthorityLock(databasePath, stablePath => {
      ensureAuthorityFile()
      assertAuthorityIdentity()
      const db = openConnection(!write, stablePath)
      try {
        initializeSchema(db)
        if (write) db.exec('BEGIN IMMEDIATE')
        try {
          let result: T
          try {
            result = operation(db)
          } catch (error) {
            if (error instanceof DeferredAuthorityError && write) {
              db.exec('COMMIT')
              db.close()
              throw error.authorityError
            }
            throw error
          }
          if (write) db.exec('COMMIT')
          db.close()
          return result
        } catch (error) {
          if (write && db.isOpen) {
            try { db.exec('ROLLBACK') } catch { /* connection teardown also discards */ }
          }
          if (db.isOpen) db.close()
          throw error
        }
      } catch (error) {
        try { if (db.isOpen) db.close() } catch { /* already closed */ }
        throw error
      }
    })
  }

  const handle: TaskAuthorityDatabase = {
    databasePath,
    withImmediate: operation => run(true, operation),
    withReadOnly: operation => run(false, operation),
    close: () => {
      if (closed) return
      closed = true
      withAuthorityLock(databasePath, stablePath => {
        ensureAuthorityFile()
        const db = openConnection(false, stablePath)
        try {
          db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        } finally {
          db.close()
        }
      })
    }
  }
  ensureAuthorityFile()
  handle.withImmediate(db => {
    initializeSchema(db)
    validateTaskAuthorityDatabase(db)
  })
  return handle
}

/**
 * Independent write-capable connection with daemon durability pragmas, without
 * the process-wide authority lock. Used by adversarial race tests (and by the
 * daemon's own crash-recovery helpers) to prove SQL-level arbitration.
 */
export function openTaskAuthorityRawConnection(databasePath: string): DatabaseSync {
  const db = new DatabaseSync(databasePath)
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL')
  return db
}

const SCHEMA_V1 = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  version INTEGER NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  external_task_id TEXT NOT NULL,
  external_task_id_canonical TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('todo','blocked','in-progress','cancelling','cancelled','done','failed','quarantined')),
  priority INTEGER NOT NULL,
  current_attempt_id TEXT,
  cancel_state TEXT NOT NULL CHECK (cancel_state IN ('none','requested')),
  entity_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, external_task_id_canonical),
  UNIQUE(project_id, id)
);
CREATE INDEX tasks_runnable_order ON tasks(project_id, status, priority, created_at, id);

CREATE TABLE task_dependencies (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  PRIMARY KEY(project_id, task_id, depends_on_task_id),
  FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id),
  FOREIGN KEY (project_id, depends_on_task_id) REFERENCES tasks(project_id, id)
);
CREATE INDEX task_dependencies_depends_on ON task_dependencies(project_id, depends_on_task_id);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  retry_of_attempt_id TEXT,
  provenance_kind TEXT NOT NULL CHECK (provenance_kind IN ('native','imported-legacy')),
  state TEXT NOT NULL CHECK (state IN ('claimed','launching','running','cancelling','cancelled','exited','completed','failed','quarantined')),
  specification_id TEXT NOT NULL,
  current_lease_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(project_id, task_id, sequence),
  UNIQUE(project_id, id),
  FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id),
  FOREIGN KEY (retry_of_attempt_id) REFERENCES attempts(id),
  CHECK (
    (provenance_kind = 'native' AND current_lease_id IS NOT NULL)
    OR (provenance_kind = 'imported-legacy' AND current_lease_id IS NULL AND state IN ('cancelled','exited','completed','failed'))
  )
);
CREATE UNIQUE INDEX one_active_attempt_per_task ON attempts(project_id, task_id)
  WHERE state IN ('claimed','launching','running','cancelling','quarantined');

CREATE TABLE leases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  issued_at_ms INTEGER NOT NULL,
  initial_expires_at_ms INTEGER NOT NULL,
  UNIQUE(project_id, task_id, attempt_id, generation),
  FOREIGN KEY (attempt_id) REFERENCES attempts(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE lease_renewals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX lease_renewals_effective_expiry ON lease_renewals(project_id, lease_id, expires_at_ms);

CREATE TABLE handoff_offers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  source_owner_id TEXT NOT NULL,
  target_owner_id TEXT NOT NULL,
  source_lease_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','cancelled','expired')),
  expires_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY (project_id, attempt_id) REFERENCES attempts(project_id, id)
);
CREATE INDEX handoff_offers_live ON handoff_offers(project_id, task_id, attempt_id, status, expires_at_ms);

CREATE TABLE execution_specifications (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  command_json TEXT NOT NULL,
  target_json TEXT NOT NULL,
  verification_json TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id)
);

CREATE TABLE launch_intents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('planned','spawning','reconciling-no-spawn','stopped')),
  session_id TEXT,
  process_identity_json TEXT,
  stop_state TEXT NOT NULL CHECK (stop_state IN ('none','requested','exited')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id, attempt_id) REFERENCES attempts(project_id, id)
);
CREATE INDEX launch_intents_attempt ON launch_intents(project_id, attempt_id, updated_at);

CREATE TABLE runtime_reconciliations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  launch_intent_sha256 TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  process_identity_json TEXT NOT NULL,
  observation_sha256 TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reason TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  UNIQUE(project_id, attempt_id, lease_id, generation, launch_intent_sha256, sequence),
  UNIQUE(project_id, attempt_id, lease_id, generation, launch_intent_sha256, verdict, observation_sha256)
);
CREATE INDEX runtime_reconciliations_latest ON runtime_reconciliations(project_id, attempt_id, lease_id, generation, launch_intent_sha256, sequence);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  definition_json TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  entity_version INTEGER NOT NULL,
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX schedules_due ON schedules(project_id, enabled, next_run_at);

CREATE TABLE schedule_executions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('due','manual')),
  idempotency_key TEXT NOT NULL,
  intent_sha256 TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_id TEXT,
  due_at TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued','running','cancelling','cancelled','succeeded','failed')),
  entity_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, schedule_id, trigger, idempotency_key),
  FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id),
  FOREIGN KEY (schedule_id) REFERENCES schedules(id)
);
CREATE INDEX schedule_executions_list ON schedule_executions(project_id, schedule_id, created_at);

CREATE TABLE run_groups (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  retry_of_run_group_id TEXT,
  concurrency INTEGER NOT NULL CHECK (concurrency >= 1),
  state TEXT NOT NULL CHECK (state IN ('active','cancelling','cancelled','completed')),
  entity_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (retry_of_run_group_id) REFERENCES run_groups(id)
);

CREATE TABLE run_members (
  run_group_id TEXT NOT NULL REFERENCES run_groups(id),
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  source_attempt_id TEXT,
  ordinal INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','claimed','launching','running','cancelling','cancelled','completed','failed','quarantined')),
  PRIMARY KEY(run_group_id, project_id, task_id),
  FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id),
  FOREIGN KEY (source_attempt_id) REFERENCES attempts(id)
);
CREATE INDEX run_members_capacity ON run_members(run_group_id)
  WHERE state IN ('claimed','launching','running','cancelling','quarantined');

CREATE TABLE run_group_mutation_receipts (
  profile_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  intent_sha256 TEXT NOT NULL,
  result_run_group_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(profile_id, request_id)
);

CREATE TABLE resource_reservations (
  id TEXT PRIMARY KEY,
  canonical_resource_key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved','quarantined','released')),
  created_at TEXT NOT NULL,
  released_at TEXT,
  FOREIGN KEY (project_id, attempt_id) REFERENCES attempts(project_id, id)
);
CREATE UNIQUE INDEX one_live_resource_reservation ON resource_reservations(canonical_resource_key)
  WHERE state IN ('reserved','quarantined');

CREATE TABLE verification_artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_id TEXT,
  lease_id TEXT,
  generation INTEGER,
  provenance_kind TEXT NOT NULL CHECK (provenance_kind IN ('native','imported-legacy')),
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  source_fingerprint TEXT,
  relationship TEXT NOT NULL CHECK (relationship IN ('attached-reference','observed-during-run')),
  attached_at TEXT NOT NULL,
  FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id),
  CHECK (
    (provenance_kind = 'native' AND lease_id IS NOT NULL AND generation IS NOT NULL)
    OR (provenance_kind = 'imported-legacy' AND lease_id IS NULL AND generation IS NULL)
  )
);
CREATE INDEX verification_artifacts_attempt ON verification_artifacts(project_id, task_id, attempt_id);

CREATE TABLE artifact_adoptions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  current_attempt_id TEXT NOT NULL,
  source_attempt_id TEXT,
  artifact_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  review_receipt_sha256 TEXT NOT NULL,
  adopted_at TEXT NOT NULL,
  UNIQUE(project_id, current_attempt_id, artifact_id),
  FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id),
  FOREIGN KEY (current_attempt_id) REFERENCES attempts(id),
  FOREIGN KEY (source_attempt_id) REFERENCES attempts(id),
  FOREIGN KEY (artifact_id) REFERENCES verification_artifacts(id)
);

CREATE TABLE task_mailbox (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_id TEXT,
  lease_id TEXT,
  generation INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('attention','progress','artifact','system')),
  payload_json TEXT NOT NULL,
  acknowledged_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id)
);
CREATE INDEX task_mailbox_task ON task_mailbox(project_id, task_id, created_at);

CREATE TABLE task_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_id TEXT,
  event_type TEXT NOT NULL,
  entity_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX task_events_task ON task_events(project_id, task_id, sequence);

CREATE TABLE authority_profile_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  profile_id TEXT NOT NULL,
  run_group_id TEXT,
  event_type TEXT NOT NULL,
  entity_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX authority_profile_events_profile ON authority_profile_events(profile_id, sequence);

CREATE TABLE authority_state (
  profile_id TEXT PRIMARY KEY,
  phase TEXT NOT NULL,
  entity_version INTEGER NOT NULL,
  maintenance_owner TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE migration_sources (
  id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  project_id TEXT,
  source_kind TEXT NOT NULL,
  canonical_source_path TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  normalized_json TEXT NOT NULL,
  phase TEXT NOT NULL,
  supersedes_source_id TEXT,
  retired_path TEXT,
  fence_receipt_json TEXT,
  imported_at TEXT NOT NULL,
  UNIQUE(scope_kind, scope_id, source_kind, canonical_source_path, source_sha256)
);

CREATE TABLE migration_entity_mappings (
  source_id TEXT NOT NULL REFERENCES migration_sources(id),
  entity_kind TEXT NOT NULL,
  source_entity_key TEXT NOT NULL,
  authority_entity_id TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','superseded','retired')),
  PRIMARY KEY(source_id, entity_kind, source_entity_key)
);

CREATE TABLE projection_checkpoints (
  name TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
`
