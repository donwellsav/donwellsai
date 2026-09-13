import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { resolveNativeRuntimeAddonPath } from '../shared/native-addon-path'
import type {
  ProcessIdentity,
  ProcessIdentityVerdict,
  RuntimeExpectation,
  RuntimeFamily,
  RuntimeIdentityAuthority
} from '@shared/child-process/process-spec'

const MAX_IDENTITY_FIELD_LENGTH = 16 * 1024
const MAX_NATIVE_MESSAGE_LENGTH = 4 * 1024

export type NativeProcessObservation =
  | { ok: true; pid: number; bootId: string; startedAt: string; executablePath: string }
  | { ok: false; code: 'not-found' | 'access-denied' | 'native-error'; message: string }

type NativeProcessReader = (pid: number) => NativeProcessObservation
type RuntimeIdentityAuthorityOptions = {
  read: NativeProcessReader
  now: () => Date
  platform?: NodeJS.Platform
  realpath?: (path: string) => string
}

type RuntimeIdentityAddon = {
  platform: unknown
  identityContractVersion: unknown
  readProcessIdentity: unknown
}

const RUNTIME_FAMILIES: readonly RuntimeFamily[] = ['donwells-app', 'terminal-daemon', 'acp-agent']

function boundedString(value: unknown, field: string, maxLength = MAX_IDENTITY_FIELD_LENGTH): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(field + ' must be a bounded non-empty string')
  }
  return value
}

function boundedDetail(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return 'native observation failed'
  return value.length > MAX_NATIVE_MESSAGE_LENGTH ? value.slice(0, MAX_NATIVE_MESSAGE_LENGTH) : value
}

function validPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function validFamily(value: unknown): value is RuntimeFamily {
  return typeof value === 'string' && RUNTIME_FAMILIES.includes(value as RuntimeFamily)
}

function normalizeExecutablePath(
  value: unknown,
  platform: NodeJS.Platform,
  realpath: (path: string) => string
): string {
  const path = boundedString(value, 'executablePath')
  if (platform === 'win32') return path.replaceAll('\\', '/').toLowerCase()
  try {
    return boundedString(realpath(path), 'realpath(executablePath)')
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return path
    const detail = error instanceof Error ? error.message : error
    throw new Error('could not canonicalize executablePath: ' + boundedDetail(detail))
  }
}

function observationError(observation: unknown): string | null {
  if (typeof observation !== 'object' || observation === null || !('ok' in observation)) return 'native observation was malformed'
  if (observation.ok === true) return null
  if (observation.ok !== false || !('code' in observation) || !('message' in observation)) return 'native observation was malformed'
  if (observation.code !== 'not-found' && observation.code !== 'access-denied' && observation.code !== 'native-error') return 'native observation had an unknown error code'
  return boundedDetail(observation.message)
}
function isNativeFailure(observation: unknown): observation is Extract<NativeProcessObservation, { ok: false }> {
  if (typeof observation !== 'object' || observation === null || !('ok' in observation) || observation.ok !== false || !('code' in observation) || !('message' in observation)) return false
  return (observation.code === 'not-found' || observation.code === 'access-denied' || observation.code === 'native-error') &&
    typeof observation.message === 'string' && observation.message.length > 0 && observation.message.length <= MAX_NATIVE_MESSAGE_LENGTH
}

function validateSuccessObservation(observation: unknown): Extract<NativeProcessObservation, { ok: true }> {
  if (typeof observation !== 'object' || observation === null || !('ok' in observation) || observation.ok !== true) {
    throw new Error('native observation success was malformed')
  }
  const pid = 'pid' in observation ? observation.pid : undefined
  const bootId = 'bootId' in observation ? observation.bootId : undefined
  const startedAt = 'startedAt' in observation ? observation.startedAt : undefined
  const executablePath = 'executablePath' in observation ? observation.executablePath : undefined
  if (!validPid(pid)) throw new Error('native observation PID must be a positive safe integer')
  return {
    ok: true,
    pid,
    bootId: boundedString(bootId, 'bootId'),
    startedAt: boundedString(startedAt, 'startedAt'),
    executablePath: boundedString(executablePath, 'executablePath')
  }
}

function validateRecordedIdentity(identity: ProcessIdentity): void {
  if (!validPid(identity.pid)) throw new Error('recorded PID must be a positive safe integer')
  boundedString(identity.bootId, 'bootId')
  boundedString(identity.startedAt, 'startedAt')
  boundedString(identity.executablePath, 'executablePath')
  if (!validFamily(identity.family)) throw new Error('family must be a known runtime family')
  boundedString(identity.capturedAt, 'capturedAt')
  if (identity.generation !== undefined) boundedString(identity.generation, 'generation')
}

function nativeReaderFromAddon(addon: RuntimeIdentityAddon): NativeProcessReader {
  if (typeof addon.readProcessIdentity !== 'function') throw new Error('runtime identity addon is missing readProcessIdentity')
  return pid => (addon.readProcessIdentity as (pid: number) => NativeProcessObservation)(pid)
}

function loadNativeAddon(): RuntimeIdentityAddon {
  const electronProcess = process as NodeJS.Process & { resourcesPath?: string; defaultApp?: boolean }
  const defaultApp = electronProcess.defaultApp ?? process.env['ELECTRON_RUN_AS_NODE'] === '1'
  const addon = createRequire(__filename)(resolveNativeRuntimeAddonPath(__dirname, { resourcesPath: electronProcess.resourcesPath, defaultApp })) as RuntimeIdentityAddon
  if (addon.platform !== process.platform) throw new Error('runtime identity addon platform mismatch: ' + String(addon.platform))
  if (addon.identityContractVersion !== 1) throw new Error('runtime identity addon contract mismatch')
  return addon
}

export function createRuntimeIdentityAuthority(options: RuntimeIdentityAuthorityOptions): RuntimeIdentityAuthority {
  const platform = options.platform ?? process.platform
  const realpath = options.realpath ?? realpathSync

  function capture(pid: number, expected: RuntimeExpectation): ProcessIdentity {
    if (!validPid(pid)) throw new Error('PID must be a positive safe integer')
    if (!validFamily(expected.family)) throw new Error('family must be a known runtime family')
    if (expected.executablePath !== undefined) boundedString(expected.executablePath, 'executablePath')
    if (expected.generation !== undefined) boundedString(expected.generation, 'generation')
    let observation: NativeProcessObservation
    try {
      observation = options.read(pid)
    } catch (error) {
      const detail = error instanceof Error ? error.message : error
      throw new Error('native observation failed: ' + boundedDetail(detail))
    }
    const failure = observationError(observation)
    if (failure !== null) throw new Error(failure)
    const current = validateSuccessObservation(observation)
    if (current.pid !== pid) throw new Error('native observation returned PID ' + current.pid + ' for requested PID ' + pid)
    if (expected.executablePath !== undefined) {
      const observedPath = normalizeExecutablePath(current.executablePath, platform, realpath)
      const expectedPath = normalizeExecutablePath(expected.executablePath, platform, realpath)
      if (observedPath !== expectedPath) throw new Error('native executable path does not match expected executable')
    }
    const identity: ProcessIdentity = {
      pid: current.pid,
      bootId: current.bootId,
      startedAt: current.startedAt,
      executablePath: current.executablePath,
      family: expected.family,
      capturedAt: options.now().toISOString()
    }
    if (expected.generation !== undefined) identity.generation = expected.generation
    return identity
  }

  function verify(identity: ProcessIdentity | null): ProcessIdentityVerdict {
    if (identity === null) return { status: 'indeterminate', reason: 'legacy-record', detail: 'process identity was not recorded' }
    try {
      validateRecordedIdentity(identity)
    } catch (error) {
      const detail = error instanceof Error ? error.message : error
      return { status: 'indeterminate', reason: 'native-error', detail: boundedDetail(detail) }
    }
    let observation: NativeProcessObservation
    try {
      observation = options.read(identity.pid)
    } catch (error) {
      const detail = error instanceof Error ? error.message : error
      return { status: 'indeterminate', reason: 'native-error', detail: boundedDetail(detail) }
    }
    if (observationError(observation) !== null) {
      if (isNativeFailure(observation) && observation.code === 'not-found') return { status: 'stale', reason: 'not-found' }
      if (isNativeFailure(observation) && observation.code === 'access-denied') return { status: 'indeterminate', reason: 'access-denied', detail: boundedDetail(observation.message) }
      const detail = isNativeFailure(observation) ? observation.message : undefined
      return { status: 'indeterminate', reason: 'native-error', detail: boundedDetail(detail) }
    }
    let current: Extract<NativeProcessObservation, { ok: true }>
    try {
      current = validateSuccessObservation(observation)
    } catch (error) {
      const detail = error instanceof Error ? error.message : error
      return { status: 'indeterminate', reason: 'native-error', detail: boundedDetail(detail) }
    }
    if (current.pid !== identity.pid) {
      return {
        status: 'indeterminate',
        reason: 'native-error',
        detail: 'native observation returned PID ' + current.pid + ' for requested PID ' + identity.pid
      }
    }
    if (current.bootId !== identity.bootId || current.startedAt !== identity.startedAt) return { status: 'stale', reason: 'pid-reused' }
    try {
      if (normalizeExecutablePath(current.executablePath, platform, realpath) !== normalizeExecutablePath(identity.executablePath, platform, realpath)) {
        return { status: 'stale', reason: 'executable-mismatch' }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : error
      return { status: 'indeterminate', reason: 'native-error', detail: boundedDetail(detail) }
    }
    return { status: 'valid', current: identity }
  }

  return { capture, verify }
}

let productionAuthority: RuntimeIdentityAuthority | undefined

export function runtimeIdentityAuthority(): RuntimeIdentityAuthority {
  if (productionAuthority === undefined) {
    productionAuthority = createRuntimeIdentityAuthority({
      read: nativeReaderFromAddon(loadNativeAddon()),
      now: () => new Date()
    })
  }
  return productionAuthority
}
