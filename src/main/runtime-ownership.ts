import { createHash, randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import type { ProcessIdentity, ProcessIdentityVerdict, RuntimeIdentityAuthority } from '@shared/child-process/process-spec'
import {
  RuntimeOwnershipError,
  RuntimeOwnershipStore,
  type RuntimeOwner,
  type RuntimeOwnerKind,
  type RuntimeOwnerObservation
} from '@shared/runtime-ownership'
import { localRuntimePaths, readRuntimeRecord, writeRuntimeRecord, type LegacyRuntimeRecord, type LocalRuntimeRecord, type LocalRuntimePaths, type RuntimeRecordRead } from './local-runtime'

export type RuntimePublication = {
  store: RuntimeOwnershipStore
  paths: LocalRuntimePaths
  owner: RuntimeOwner
  locator: LocalRuntimeRecord
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
  contact?: (record: LocalRuntimeRecord | LegacyRuntimeRecord, kind: RuntimeOwnerKind) => Promise<RuntimeContactResult>
}

export type RuntimeReconcileResult =
  | { action: 'claim' }
  | { action: 'finish-preparing'; owner: RuntimeOwner; locator: LocalRuntimeRecord }
  | { action: 'republish-active'; owner: RuntimeOwner; locator: LocalRuntimeRecord }

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

function exactLocator(read: RuntimeRecordRead, owner: RuntimeOwner): boolean {
  return read.status === 'current' && locatorMatchesOwner(read.record, owner)
}

/**
 * Reconcile the SQLite authority and non-authoritative locator before claiming.
 * Safe stale states return the claim action; exact authenticated crash states
 * are repaired idempotently and returned as the corresponding action.
 */
export async function reconcileRuntimeOwner(options: RuntimeReconcileOptions): Promise<RuntimeReconcileResult> {
  const paths = localRuntimePaths(options.userDataDir, options.kind === 'donwells-app' ? 'app' : 'terminal')
  const ownsStore = options.store === undefined
  const store = options.store ?? new RuntimeOwnershipStore(paths.ownershipDatabasePath)
  const contact = options.contact ?? contactRuntimeOwner
  try {
    const observed = store.observe(options.kind)
    const locator = readRuntimeRecord(paths.runtimeFile)

    if (observed.status === 'vacant') {
      if (locator.status === 'missing') return { action: 'claim' }
      if (locator.status === 'invalid') fail('RUNTIME_LOCATOR_INVALID', locator.reason)
      if (locator.status === 'legacy') {
        const recovery = store.findLegacyRecovery({
          kind: options.kind,
          expectedFingerprint: locator.sha256,
          fileIdentity: locator.fileIdentity,
          endpoint: locator.record.socketPath
        })
        if (recovery) return { action: 'claim' }
        const result = await contact(locator.record, options.kind)
        if (result.status === 'legacy' || result.status === 'exact') fail('OWNER_LIVE', 'legacy runtime locator is still reachable')
        fail('RECOVERY_REQUIRED', 'legacy runtime locator requires exact committed recovery')
      }
      if (!locatorMatchesKind(locator.record, options.kind)) fail('RUNTIME_LOCATOR_INVALID', 'runtime locator process identity family did not match its owner kind')
      const verdict = options.authority.verify(locator.record.processIdentity)
      const result = await contact(locator.record, options.kind)
      if (result.status === 'exact') fail('OWNER_LIVE', 'ownerless runtime locator is still reachable')
      if (result.status === 'legacy') fail('RECOVERY_REQUIRED', 'version-2 runtime locator contacted a legacy endpoint')
      if (verdict.status === 'valid') fail('OWNER_LIVE', 'ownerless runtime locator still identifies a live process')
      if (verdict.status === 'indeterminate') fail('OWNER_INDETERMINATE', verdict.reason + ': ' + verdict.detail)
      return { action: 'claim' }
    }

    const owner = observed.owner
    const verdict = options.authority.verify(owner.identity)
    if (locator.status === 'invalid') {
      if (verdict.status === 'valid' || verdict.status === 'indeterminate') {
        fail(verdict.status === 'valid' ? 'OWNER_LIVE' : 'OWNER_INDETERMINATE', verdict.status === 'valid' ? 'runtime owner has an invalid locator' : verdict.reason + ': ' + verdict.detail)
      }
      return { action: 'claim' }
    }

    const rowLocator = ownerLocator(owner)
    const exact = locator.status === 'current' && exactLocator(locator, owner) && locator.sha256 === owner.locatorSha256
    const contactTarget = locator.status === 'current' && exactLocator(locator, owner) ? locator.record : rowLocator
    const result = await contact(contactTarget, options.kind)
    if (result.status === 'legacy') fail('RECOVERY_REQUIRED', 'runtime owner endpoint is legacy and lacks exact identity')
    if (result.status === 'exact') {
      if (owner.state === 'preparing') {
        let publishedRecord = rowLocator
        let publishedHash = locatorHash(rowLocator)
        if (locator.status === 'current' && exactLocator(locator, owner)) {
          publishedRecord = locator.record
          publishedHash = locator.sha256
        } else {
          writeRuntimeRecord(paths.runtimeFile, publishedRecord)
        }
        const active = store.activate(owner, publishedHash)
        return { action: 'finish-preparing', owner: active, locator: publishedRecord }
      }
      if (owner.locatorSha256 === null) fail('OWNER_STATE', 'active owner locator hash was missing')
      if (exact) fail('OWNER_LIVE', 'runtime owner is already active')
      writeRuntimeRecord(paths.runtimeFile, rowLocator)
      const active = store.republishActive(owner, owner.locatorSha256, locatorHash(rowLocator))
      return { action: 'republish-active', owner: active, locator: rowLocator }
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
    const recovery = store.findLegacyRecovery({ kind, expectedFingerprint: locator.sha256, fileIdentity: locator.fileIdentity, endpoint: locator.record.socketPath })
    if (!recovery) fail('RECOVERY_REQUIRED', 'legacy runtime locator requires exact committed recovery')
    return
  }
  if (!locatorMatchesKind(locator.record, kind)) fail('RUNTIME_LOCATOR_INVALID', 'runtime locator process identity family did not match its owner kind')
  const verdict = authority.verify(locator.record.processIdentity)
  if (verdict.status === 'valid') fail('OWNER_LIVE', 'ownerless runtime locator still identifies a live process')
  if (verdict.status === 'indeterminate') fail('OWNER_INDETERMINATE', verdict.reason + ': ' + verdict.detail)
}

export function freshRuntimeEndpoint(baseEndpoint: string, ownerId = randomUUID()): string {
  const suffix = '.' + ownerId
  const candidate = baseEndpoint + suffix
  if (process.platform !== 'darwin' || Buffer.byteLength(candidate) <= 103) return candidate
  return baseEndpoint.slice(0, Math.max(1, 102 - Buffer.byteLength(suffix))) + suffix
}
export function claimRuntimeOwner(options: RuntimeClaimOptions): RuntimePublication {
  const paths = localRuntimePaths(options.userDataDir, options.kind === 'donwells-app' ? 'app' : 'terminal')
  const ownsStore = options.store === undefined
  const store = options.store ?? new RuntimeOwnershipStore(paths.ownershipDatabasePath)
  try {
    const observed = store.observe(options.kind)
    requireSafeClaimLocator(store, paths, options.kind, observed, options.authority)
    const verdict = priorVerdict(observed, options.authority)
    const ownerId = randomUUID()
    const expectedGeneration = observed.status === 'present' ? observed.owner.generation + 1 : 1
    const identity = options.captureIdentity(ownerId + ':' + expectedGeneration)
    const owner = store.prepareClaim({
      kind: options.kind,
      ownerId,
      identity,
      endpoint: options.endpoint,
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
    return { store, paths, owner, locator }
  } catch (error) {
    if (ownsStore) store.close()
    throw error
  }
}

export async function publishRuntimeOwner(publication: RuntimePublication, bind: () => void | Promise<void>): Promise<RuntimeOwner> {
  try {
    await bind()
    writeRuntimeRecord(publication.paths.runtimeFile, publication.locator)
    const locatorBytes = Buffer.from(JSON.stringify(publication.locator))
    const locatorSha256 = createHash('sha256').update(locatorBytes).digest('hex')
    publication.owner = publication.store.activate(publication.owner, locatorSha256)
    return publication.owner
  } catch (error) {
    throw error
  }
}

export function republishRuntimeOwner(publication: RuntimePublication, expectedLocatorSha256: string | null): RuntimeOwner {
  const locatorBytes = Buffer.from(JSON.stringify(publication.locator))
  const nextLocatorSha256 = createHash('sha256').update(locatorBytes).digest('hex')
  writeRuntimeRecord(publication.paths.runtimeFile, publication.locator)
  publication.owner = publication.store.republishActive(publication.owner, expectedLocatorSha256, nextLocatorSha256)
  return publication.owner
}

export function releaseRuntimeOwner(publication: RuntimePublication): boolean {
  return publication.store.release(publication.owner)
}
