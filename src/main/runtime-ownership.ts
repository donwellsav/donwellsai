import { createHash, randomUUID } from 'node:crypto'
import type { ProcessIdentity, ProcessIdentityVerdict, RuntimeIdentityAuthority } from '@shared/child-process/process-spec'
import {
  RuntimeOwnershipStore,
  type RuntimeOwner,
  type RuntimeOwnerKind,
  type RuntimeOwnerObservation
} from '@shared/runtime-ownership'
import { localRuntimePaths, writeRuntimeRecord, type LocalRuntimeRecord, type LocalRuntimePaths } from './local-runtime'

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
  identity: ProcessIdentity
  authority: RuntimeIdentityAuthority
  store?: RuntimeOwnershipStore
}

function priorVerdict(observed: RuntimeOwnerObservation, authority: RuntimeIdentityAuthority): ProcessIdentityVerdict | null {
  if (observed.status === 'vacant') return null
  return authority.verify(observed.owner.identity)
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
    const verdict = priorVerdict(observed, options.authority)
    const ownerId = randomUUID()
    const owner = store.prepareClaim({
      kind: options.kind,
      ownerId,
      identity: options.identity,
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
