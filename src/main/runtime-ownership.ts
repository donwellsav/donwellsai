import { createHash, randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { lstatSync, rmSync, type Stats } from 'node:fs'
import type { ProcessIdentity, ProcessIdentityVerdict, RuntimeIdentityAuthority } from '@shared/child-process/process-spec'
import {
  readVerifiedRecoveryEvidence,
  RuntimeOwnershipError,
  RuntimeOwnershipStore,
  type RuntimeEndpointCleanup,
  type RuntimeOwner,
  type RuntimeOwnerKind,
  type RuntimeOwnerObservation
} from '@shared/runtime-ownership'
import { canonicalPrivateDirectory, runtimePathNoReplaceRename, type RuntimeFileIdentity, type RuntimePathNoReplaceRename } from '@shared/runtime-file-security'
import { logger } from '@shared/logger'
import { localRuntimePaths, parseRuntimeRecordBytes, readRuntimeRecord, writeRuntimeRecord, type LegacyRuntimeRecord, type LocalRuntimeRecord, type LocalRuntimePaths, type RuntimeRecordRead } from './local-runtime'
export type RuntimePublication = {
  store: RuntimeOwnershipStore
  paths: LocalRuntimePaths
  owner: RuntimeOwner
  locator: LocalRuntimeRecord
  locatorFileIdentity: Record<string, string> | null
  /** Endpoint from the displaced owner; removed only after successor activation. */
  predecessor?: { ownerId: string; generation: number; endpoint: string; endpointFileIdentity: RuntimeFileIdentity | null }
}

export type RuntimeClaimOptions = {
  userDataDir: string
  kind: RuntimeOwnerKind
  endpoint: string
  authToken: string
  captureIdentity: (generation: string) => ProcessIdentity
  authority: RuntimeIdentityAuthority
  store?: RuntimeOwnershipStore
}

export type RuntimeContactResult =
  | { status: 'exact'; ownerId: string; generation: number; processIdentity: ProcessIdentity }
  | { status: 'legacy' }
  | { status: 'unreachable'; detail: string }
  | { status: 'mismatch'; detail: string }

export type RuntimeReconcileOptions = {
  userDataDir: string
  kind: RuntimeOwnerKind
  authority: RuntimeIdentityAuthority
  store?: RuntimeOwnershipStore
  candidate?: RuntimePublication
  contact?: (record: LocalRuntimeRecord | LegacyRuntimeRecord, kind: RuntimeOwnerKind) => Promise<RuntimeContactResult>
}

export type RuntimeReconcileResult =
  | { action: 'claim' }
  | { action: 'reconnect-legacy'; record: LegacyRuntimeRecord }
  | { action: 'finish-preparing'; publication: RuntimePublication }
  | { action: 'republish-active'; publication: RuntimePublication }

function priorVerdict(observed: RuntimeOwnerObservation, authority: RuntimeIdentityAuthority): ProcessIdentityVerdict | null {
  if (observed.status === 'vacant') return null
  return authority.verify(observed.owner.identity)
}

function ownerLocator(owner: RuntimeOwner): LocalRuntimeRecord {
  return {
    version: 2,
    ownerId: owner.ownerId,
    ownerGeneration: owner.generation,
    socketPath: owner.endpoint,
    authToken: owner.authToken,
    processIdentity: owner.identity
  }
}

function locatorMatchesOwner(record: LocalRuntimeRecord, owner: RuntimeOwner): boolean {
  return record.ownerId === owner.ownerId
    && record.ownerGeneration === owner.generation
    && record.socketPath === owner.endpoint
    && record.authToken === owner.authToken
    && sameIdentity(record.processIdentity, owner.identity)
}

function locatorHash(record: LocalRuntimeRecord): string {
  return createHash('sha256').update(Buffer.from(JSON.stringify(record))).digest('hex')
}

function fail(code: string, message: string): never {
  throw new RuntimeOwnershipError(code, message)
}

function responseObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function sameIdentity(value: unknown, expected: ProcessIdentity): boolean {
  const actual = responseObject(value)
  return actual !== null
    && actual['pid'] === expected.pid
    && actual['bootId'] === expected.bootId
    && actual['startedAt'] === expected.startedAt
    && actual['executablePath'] === expected.executablePath
    && actual['family'] === expected.family
    && actual['capturedAt'] === expected.capturedAt
    && actual['generation'] === expected.generation
}

function ownerKindFamily(kind: RuntimeOwnerKind): ProcessIdentity['family'] {
  return kind === 'donwells-app' ? 'donwells-app' : 'terminal-daemon'
}

function locatorMatchesKind(record: LocalRuntimeRecord, kind: RuntimeOwnerKind): boolean {
  return record.processIdentity.family === ownerKindFamily(kind)
}

/** Contact an advertised endpoint and require its current exact runtime identity. */
export function contactRuntimeOwner(record: LocalRuntimeRecord | LegacyRuntimeRecord, kind: RuntimeOwnerKind, timeoutMs = 500): Promise<RuntimeContactResult> {
  return new Promise(resolve => {
    const socket = createConnection(record.socketPath)
    let buffer = ''
    let settled = false
    const id = randomUUID()
    const finish = (result: RuntimeContactResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }
    const timer = setTimeout(() => finish({ status: 'unreachable', detail: 'runtime endpoint contact timed out' }), timeoutMs)
    timer.unref()
    socket.setEncoding('utf8')
    socket.once('connect', () => {
      const hello = kind === 'donwells-app'
        ? { method: 'auth.hello', id, authToken: record.authToken }
        : { op: 'hello', id, authToken: record.authToken }
      socket.write(JSON.stringify(hello) + '\n')
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > 64 * 1024) {
        finish({ status: 'mismatch', detail: 'runtime hello response exceeded the size limit' })
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      let response: Record<string, unknown> | null
      try { response = responseObject(JSON.parse(buffer.slice(0, newline))) } catch { response = null }
      if (!response || response['id'] !== id || response['ok'] !== true) {
        finish({ status: 'unreachable', detail: 'runtime endpoint rejected authenticated contact' })
        return
      }
      const hasIdentity = response['runtimeIdentityContractVersion'] === 1
        && typeof response['ownerId'] === 'string'
        && Number.isSafeInteger(response['generation'])
        && response['processIdentity'] !== undefined
      if (!hasIdentity) {
        finish({ status: 'legacy' })
        return
      }
      const protocolOk = kind === 'donwells-app'
        ? response['version'] === 'rpc-v1'
        : response['protocolVersion'] === 3
          && Array.isArray(response['capabilities'])
          && response['capabilities'].includes('runtime-identity-v1')
      if (!protocolOk || !('version' in record) || response['ownerId'] !== record.ownerId || response['generation'] !== record.ownerGeneration
        || !sameIdentity(response['processIdentity'], record.processIdentity)) {
        finish({ status: 'mismatch', detail: 'runtime hello identity did not match the locator' })
        return
      }
      finish({ status: 'exact', ownerId: record.ownerId, generation: record.ownerGeneration, processIdentity: record.processIdentity })
    })
    socket.once('error', error => finish({ status: 'unreachable', detail: error.message }))
    socket.once('close', () => finish({ status: 'unreachable', detail: 'runtime endpoint closed before authenticated contact' }))
  })
}

function requireCommittedRecovery(store: RuntimeOwnershipStore, locator: Exclude<RuntimeRecordRead, { status: 'missing' | 'invalid' }>, kind: RuntimeOwnerKind, recordType: 'legacy' | 'orphan-v2'): void {
  const recovery = store.findLegacyRecovery({
    kind,
    expectedFingerprint: locator.sha256,
    fileIdentity: locator.fileIdentity,
    endpoint: locator.record.socketPath,
    recordType
  })
  if (!recovery) fail('RECOVERY_REQUIRED', recordType === 'legacy'
    ? 'legacy runtime locator requires exact committed recovery'
    : 'orphaned version-2 runtime locator requires exact committed recovery')
  const bytes = readVerifiedRecoveryEvidence(recovery)
  const verified = parseRuntimeRecordBytes(bytes)
  if (verified.status === 'invalid' || verified.record.socketPath !== locator.record.socketPath
    || (recordType === 'legacy') !== (verified.status === 'legacy')) {
    fail('RECOVERY_EVIDENCE_INVALID', 'committed recovery evidence did not match the runtime locator metadata')
  }
}
async function requireSafeForeignLocator(
  store: RuntimeOwnershipStore,
  locator: RuntimeRecordRead,
  kind: RuntimeOwnerKind,
  authority: RuntimeIdentityAuthority,
  contact: (record: LocalRuntimeRecord | LegacyRuntimeRecord, kind: RuntimeOwnerKind) => Promise<RuntimeContactResult>
): Promise<LegacyRuntimeRecord | undefined> {
  if (locator.status === 'missing') return undefined
  if (locator.status === 'invalid') fail('RUNTIME_LOCATOR_INVALID', locator.reason)
  if (locator.status === 'legacy') {
    let contacted: RuntimeContactResult
    try {
      contacted = await contact(locator.record, kind)
    } catch (error) {
      contacted = { status: 'unreachable', detail: error instanceof Error ? error.message : String(error) }
    }
    if (contacted.status === 'legacy') return locator.record
    requireCommittedRecovery(store, locator, kind, 'legacy')
    return undefined
  }
  if (!locatorMatchesKind(locator.record, kind)) fail('RUNTIME_LOCATOR_INVALID', 'runtime locator process identity family did not match its owner kind')
  const contacted = await contact(locator.record, kind)
  if (contacted.status === 'exact') fail('OWNER_LIVE', 'mismatched runtime locator is still reachable')
  if (contacted.status === 'legacy') fail('RECOVERY_REQUIRED', 'version-2 runtime locator contacted a legacy endpoint')
  const verdict = authority.verify(locator.record.processIdentity)
  if (verdict.status === 'valid') fail('OWNER_LIVE', 'mismatched runtime locator identifies a live process')
  if (verdict.status === 'indeterminate') fail('OWNER_INDETERMINATE', verdict.reason + ': ' + verdict.detail)
  requireCommittedRecovery(store, locator, kind, 'orphan-v2')
  return undefined
}

/**
 * Reconcile the SQLite authority and non-authoritative locator before claiming.
 * Safe stale states return the claim action; exact authenticated crash states
 * are repaired idempotently and returned as the corresponding action.
 */
export async function reconcileRuntimeOwner(options: RuntimeReconcileOptions): Promise<RuntimeReconcileResult> {
  const canonicalUserDataDir = canonicalPrivateDirectory(options.userDataDir, { create: true, requireCanonical: true })
  const paths = localRuntimePaths(canonicalUserDataDir, options.kind === 'donwells-app' ? 'app' : 'terminal')
  const ownsStore = options.store === undefined
  const store = options.store ?? new RuntimeOwnershipStore(paths.ownershipDatabasePath)
  const contact = options.contact ?? contactRuntimeOwner
  try {
    recoverRuntimeEndpointCleanups(store, options.kind)
    const observed = store.observe(options.kind)
    const locator = readRuntimeRecord(paths.runtimeFile)
    if (observed.status === 'vacant') {
      if (locator.status === 'legacy') {
        const legacy = await requireSafeForeignLocator(store, locator, options.kind, options.authority, contact)
        if (legacy !== undefined) return { action: 'reconnect-legacy', record: legacy }
      } else {
        await requireSafeForeignLocator(store, locator, options.kind, options.authority, contact)
      }
      return { action: 'claim' }
    }

    const owner = observed.owner
    const verdict = options.authority.verify(owner.identity)
    const locatorBelongsToOwner = locator.status === 'current' && locatorMatchesOwner(locator.record, owner)
    const exact = locatorBelongsToOwner && locator.sha256 === owner.locatorSha256
    const candidate = options.candidate
    const candidateOwnsRow = candidate !== undefined
      && candidate.paths.runtimeFile === paths.runtimeFile
      && candidate.paths.ownershipDatabasePath === paths.ownershipDatabasePath
      && candidate.owner.kind === owner.kind
      && candidate.owner.ownerId === owner.ownerId
      && candidate.owner.generation === owner.generation
      && candidate.owner.state === owner.state
      && candidate.owner.endpoint === owner.endpoint
      && candidate.owner.authToken === owner.authToken
      && sameIdentity(candidate.owner.identity, owner.identity)
      && locatorMatchesOwner(candidate.locator, owner)

    if (candidateOwnsRow) {
      if (verdict.status !== 'valid' || !sameIdentity(verdict.current, owner.identity)) {
        fail(verdict.status === 'indeterminate' ? 'OWNER_INDETERMINATE' : 'OWNER_CHANGED', verdict.status === 'indeterminate' ? verdict.reason + ': ' + verdict.detail : 'in-memory runtime candidate identity is no longer current')
      }
      if (owner.state === 'preparing') return { action: 'finish-preparing', publication: candidate }
      if (exact) fail('OWNER_LIVE', 'runtime owner is already active')
      return { action: 'republish-active', publication: candidate }
    }

    if (locator.status !== 'missing' && !locatorBelongsToOwner) {
      await requireSafeForeignLocator(store, locator, options.kind, options.authority, contact)
    }

    if (locatorBelongsToOwner || locator.status === 'missing' || (locator.status === 'current' && !locatorBelongsToOwner)) {
      const contacted = await contact(locatorBelongsToOwner ? locator.record : ownerLocator(owner), options.kind)
      if (contacted.status === 'exact') fail('OWNER_LIVE', 'runtime owner is still reachable')
      if (contacted.status === 'legacy') fail('RECOVERY_REQUIRED', 'runtime owner endpoint is legacy and lacks exact identity')
    }
    if (verdict.status === 'valid') fail('OWNER_LIVE', 'runtime owner is still live')
    if (verdict.status === 'indeterminate') fail('OWNER_INDETERMINATE', verdict.reason + ': ' + verdict.detail)
    return { action: 'claim' }
  } finally {
    if (ownsStore) store.close()
  }
}

function requireSafeClaimLocator(store: RuntimeOwnershipStore, paths: LocalRuntimePaths, kind: RuntimeOwnerKind, observed: RuntimeOwnerObservation, authority: RuntimeIdentityAuthority): void {
  if (observed.status !== 'vacant') return
  const locator = readRuntimeRecord(paths.runtimeFile)
  if (locator.status === 'missing') return
  if (locator.status === 'invalid') fail('RUNTIME_LOCATOR_INVALID', locator.reason)
  if (locator.status === 'legacy') {
    requireCommittedRecovery(store, locator, kind, 'legacy')
    return
  }
  if (!locatorMatchesKind(locator.record, kind)) fail('RUNTIME_LOCATOR_INVALID', 'runtime locator process identity family did not match its owner kind')
  const verdict = authority.verify(locator.record.processIdentity)
  if (verdict.status === 'valid') fail('OWNER_LIVE', 'ownerless runtime locator still identifies a live process')
  if (verdict.status === 'indeterminate') fail('OWNER_INDETERMINATE', verdict.reason + ': ' + verdict.detail)
  requireCommittedRecovery(store, locator, kind, 'orphan-v2')
}

export function freshRuntimeEndpoint(baseEndpoint: string, ownerId: string = randomUUID()): string {
  const suffix = '.' + createHash('sha256').update(ownerId).digest('hex').slice(0, 16)
  const candidate = baseEndpoint + suffix
  if (process.platform !== 'darwin' || Buffer.byteLength(candidate) <= 103) return candidate
  const separator = Math.max(baseEndpoint.lastIndexOf('/'), baseEndpoint.lastIndexOf('\\')) + 1
  const parent = baseEndpoint.slice(0, separator)
  const basename = baseEndpoint.slice(separator)
  const available = 102 - Buffer.byteLength(parent) - Buffer.byteLength(suffix)
  if (available < 1) throw new Error('runtime endpoint parent path is too long')
  return parent + basename.slice(0, available) + suffix
}
export function claimRuntimeOwner(options: RuntimeClaimOptions): RuntimePublication {
  const canonicalUserDataDir = canonicalPrivateDirectory(options.userDataDir, { create: true, requireCanonical: true })
  const paths = localRuntimePaths(canonicalUserDataDir, options.kind === 'donwells-app' ? 'app' : 'terminal')
  const ownsStore = options.store === undefined
  const store = options.store ?? new RuntimeOwnershipStore(paths.ownershipDatabasePath)
  let completed = false
  try {
    const observed = store.observe(options.kind)
    requireSafeClaimLocator(store, paths, options.kind, observed, options.authority)
    const verdict = priorVerdict(observed, options.authority)
    const ownerId = randomUUID()
    const expectedGeneration = observed.status === 'present' ? observed.owner.generation + 1 : observed.lastGeneration + 1
    const identity = options.captureIdentity(ownerId + ':' + expectedGeneration)
    const owner = store.prepareClaim({
      kind: options.kind,
      ownerId,
      identity,
      endpoint: freshRuntimeEndpoint(options.endpoint, ownerId + ':' + expectedGeneration),
      authToken: options.authToken
    }, observed, verdict)
    const locator: LocalRuntimeRecord = {
      version: 2,
      ownerId: owner.ownerId,
      ownerGeneration: owner.generation,
      socketPath: owner.endpoint,
      authToken: owner.authToken,
      processIdentity: owner.identity
    }
    completed = true
    const predecessor = observed.status === 'present'
      ? {
        ownerId: observed.owner.ownerId,
        generation: observed.owner.generation,
        endpoint: observed.owner.endpoint,
        endpointFileIdentity: observed.owner.endpointFileIdentity
      }
      : undefined
    return { store, paths, owner, locator, locatorFileIdentity: null, ...(predecessor === undefined ? {} : { predecessor }) }
  } finally {
    if (!completed && ownsStore) store.close()
  }
}

export type RuntimeEndpointCleanupOperations = {
  renameNoReplace: RuntimePathNoReplaceRename
  stat: (path: string) => Stats
  remove: (path: string) => void
}

const DEFAULT_ENDPOINT_CLEANUP_OPERATIONS: RuntimeEndpointCleanupOperations = {
  renameNoReplace: (sourcePath, destinationPath) => runtimePathNoReplaceRename()(sourcePath, destinationPath),
  stat: lstatSync,
  remove: path => rmSync(path)
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

function endpointStat(path: string, operations: RuntimeEndpointCleanupOperations): Stats | null {
  try { return operations.stat(path) } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'not-found') return null
    throw error
  }
}

function matchesEndpointIdentity(stat: Stats, expected: RuntimeFileIdentity): boolean {
  return expected.platform === 'posix' && stat.isSocket() && String(stat.dev) === expected.device && String(stat.ino) === expected.inode
}

function recoverEndpointCleanup(store: RuntimeOwnershipStore, cleanup: RuntimeEndpointCleanup, operations: RuntimeEndpointCleanupOperations): void {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const quarantined = endpointStat(cleanup.quarantinePath, operations)
    if (quarantined !== null) {
      if (matchesEndpointIdentity(quarantined, cleanup.expectedFileIdentity)) {
        try { operations.remove(cleanup.quarantinePath) } catch (error) {
          if (errorCode(error) === 'ENOENT' || errorCode(error) === 'not-found') continue
          throw error
        }
        store.completeEndpointCleanup(cleanup)
        return
      }
      const restored = operations.renameNoReplace(cleanup.quarantinePath, cleanup.endpoint)
      if (restored === 'destination-exists') return
      store.completeEndpointCleanup(cleanup)
      return
    }

    const endpoint = endpointStat(cleanup.endpoint, operations)
    if (endpoint === null || !matchesEndpointIdentity(endpoint, cleanup.expectedFileIdentity)) {
      store.completeEndpointCleanup(cleanup)
      return
    }
    if (operations.renameNoReplace(cleanup.endpoint, cleanup.quarantinePath) === 'destination-exists') continue
  }
  throw new RuntimeOwnershipError('CLEANUP_RACE', 'runtime endpoint cleanup did not reach a stable state')
}

export function recoverRuntimeEndpointCleanups(
  store: RuntimeOwnershipStore,
  kind: RuntimeOwnerKind,
  operations: RuntimeEndpointCleanupOperations = DEFAULT_ENDPOINT_CLEANUP_OPERATIONS
): void {
  for (const cleanup of store.listEndpointCleanups(kind)) {
    try { recoverEndpointCleanup(store, cleanup, operations) } catch (error) {
      logger.warn({ err: error, endpoint: cleanup.endpoint, quarantinePath: cleanup.quarantinePath, predecessorOwnerId: cleanup.predecessorOwnerId, predecessorGeneration: cleanup.predecessorGeneration }, 'runtime endpoint cleanup recovery remains pending')
    }
  }
}

function publishedEndpointIdentity(endpoint: string): RuntimeFileIdentity | null {
  if (process.platform === 'win32') return null
  try {
    const stat = lstatSync(endpoint)
    if (!stat.isSocket()) fail('RUNTIME_PUBLICATION_FAILED', 'bound runtime endpoint was not a socket')
    return { platform: 'posix', device: String(stat.dev), inode: String(stat.ino) }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

function removeDisplacedEndpoint(publication: RuntimePublication): void {
  const predecessor = publication.predecessor
  publication.predecessor = undefined
  if (predecessor === undefined || predecessor.endpoint === publication.owner.endpoint || predecessor.endpointFileIdentity === null) return
  try {
    const endpoint = endpointStat(predecessor.endpoint, DEFAULT_ENDPOINT_CLEANUP_OPERATIONS)
    if (endpoint === null || !matchesEndpointIdentity(endpoint, predecessor.endpointFileIdentity)) return
    publication.store.beginEndpointCleanup(publication.owner, {
      ownerId: predecessor.ownerId,
      generation: predecessor.generation,
      endpoint: predecessor.endpoint,
      endpointFileIdentity: predecessor.endpointFileIdentity
    })
    recoverRuntimeEndpointCleanups(publication.store, publication.owner.kind)
  } catch (error) {
    logger.warn({ err: error, endpoint: predecessor.endpoint, ownerId: predecessor.ownerId, generation: predecessor.generation }, 'runtime predecessor endpoint cleanup failed after successor activation')
  }
}

export async function publishRuntimeOwner(publication: RuntimePublication, bind: () => void | Promise<void>): Promise<RuntimeOwner> {
  await bind()
  const endpointFileIdentity = publishedEndpointIdentity(publication.owner.endpoint)
  if (endpointFileIdentity !== null) publication.owner = publication.store.recordBoundEndpoint(publication.owner, endpointFileIdentity)

  writeRuntimeRecord(publication.paths.runtimeFile, publication.locator)
  const locatorBytes = Buffer.from(JSON.stringify(publication.locator))
  const locatorSha256 = createHash('sha256').update(locatorBytes).digest('hex')
  const written = readRuntimeRecord(publication.paths.runtimeFile)
  if (written.status !== 'current' || written.sha256 !== locatorSha256 || !locatorMatchesOwner(written.record, publication.owner)) {
    fail('RUNTIME_PUBLICATION_FAILED', 'runtime locator could not be verified after publication')
  }
  publication.locatorFileIdentity = written.fileIdentity
  publication.owner = publication.store.activate(publication.owner, locatorSha256)
  removeDisplacedEndpoint(publication)
  return publication.owner
}

export function republishRuntimeOwner(publication: RuntimePublication, expectedLocatorSha256: string | null): RuntimeOwner {
  const locatorBytes = Buffer.from(JSON.stringify(publication.locator))
  const nextLocatorSha256 = createHash('sha256').update(locatorBytes).digest('hex')
  writeRuntimeRecord(publication.paths.runtimeFile, publication.locator)
  const written = readRuntimeRecord(publication.paths.runtimeFile)
  if (written.status !== 'current' || written.sha256 !== nextLocatorSha256 || !locatorMatchesOwner(written.record, publication.owner)) {
    fail('RUNTIME_PUBLICATION_FAILED', 'runtime locator could not be verified after republication')
  }
  publication.locatorFileIdentity = written.fileIdentity
  publication.owner = publication.store.republishActive(publication.owner, expectedLocatorSha256, nextLocatorSha256)
  return publication.owner
}

export type RuntimeReleaseResult = 'released' | 'not-owned' | 'cleanup-failed'

function preserveLocatorForRecovery(publication: RuntimePublication): 'preserved' | 'missing' | 'not-owned' | 'cleanup-failed' {
  const current = readRuntimeRecord(publication.paths.runtimeFile)
  if (current.status === 'missing') return 'missing'
  if (current.status === 'invalid') return 'cleanup-failed'
  if (current.status !== 'current') return 'not-owned'
  const expectedHash = publication.owner.locatorSha256 ?? locatorHash(publication.locator)
  if (current.sha256 !== expectedHash || !locatorMatchesOwner(current.record, publication.owner)
    || publication.locatorFileIdentity === null || JSON.stringify(current.fileIdentity) !== JSON.stringify(publication.locatorFileIdentity)) return 'not-owned'
  try {
    publication.store.recordLegacyRecovery({
      kind: publication.owner.kind,
      expectedFingerprint: current.sha256,
      fileIdentity: current.fileIdentity,
      evidencePath: publication.paths.runtimeFile,
      evidenceFileIdentity: current.fileIdentity,
      endpoint: current.record.socketPath,
      recordType: 'orphan-v2'
    })
  } catch (error) {
    if (error instanceof RuntimeOwnershipError) throw error
    return 'cleanup-failed'
  }
  return 'preserved'
}

export function abandonRuntimeOwner(publication: RuntimePublication): RuntimeReleaseResult {
  if (publication.owner.state !== 'preparing') return 'not-owned'
  const current = readRuntimeRecord(publication.paths.runtimeFile)
  const locatorBelongsToPublication = current.status === 'current'
    && publication.locatorFileIdentity !== null
    && JSON.stringify(current.fileIdentity) === JSON.stringify(publication.locatorFileIdentity)
    && locatorMatchesOwner(current.record, publication.owner)
  if (current.status === 'missing' || !locatorBelongsToPublication) {
    return publication.store.abandonPreparing(publication.owner) ? 'released' : 'not-owned'
  }
  const preserved = preserveLocatorForRecovery(publication)
  if (preserved === 'cleanup-failed' || preserved === 'not-owned') return preserved
  return publication.store.abandonPreparing(publication.owner) ? 'released' : 'not-owned'
}

export function releaseRuntimeOwner(publication: RuntimePublication): RuntimeReleaseResult {
  if (publication.owner.state !== 'active') return 'not-owned'
  const preserved = preserveLocatorForRecovery(publication)
  if (preserved === 'cleanup-failed' || preserved === 'not-owned') return preserved
  return publication.store.release(publication.owner) ? 'released' : 'not-owned'
}
