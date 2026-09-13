import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { resolveNativeRuntimeAddonPath } from './native-addon-path'

export type RuntimeFileIdentity =
  | { platform: 'posix'; device: string; inode: string }
  | { platform: 'win32'; volumeSerial: string; fileId: string }

export type NativeRuntimeFileObservation =
  | { ok: true; bytes: Buffer; fileIdentity: Record<string, string> }
  | { ok: false; code: 'not-found' | 'access-denied' | 'native-error'; message: string }
export type NativeRuntimeFileIdentityObservation =
  | { ok: true; fileIdentity: Record<string, string> }
  | { ok: false; code: 'not-found' | 'access-denied' | 'native-error'; message: string }
export type NativeRuntimeDirectoryObservation = NativeRuntimeFileIdentityObservation

export type NativeRuntimeFileAddon = {
  platform: unknown
  runtimeFileSecurityContractVersion: unknown
  readPrivateRuntimeFile: unknown
  readPrivateRuntimeFileIdentity?: unknown
  validatePrivateRuntimeDirectory?: unknown
  withRuntimeAuthorityLock?: unknown
}

export type RuntimeFileRead = {
  bytes: Buffer
  sha256: string
  fileIdentity: RuntimeFileIdentity
}

export type RuntimeFileReader = (path: string, maxBytes: number) => RuntimeFileRead
export type RuntimeAuthorityLock = <T>(path: string, callback: (stablePath: string) => T, options?: { readOnly?: boolean }) => T
export type RuntimeDirectoryValidator = (path: string) => void
export type RuntimeFileIdentityReader = (path: string) => RuntimeFileIdentity

export class RuntimeFileSecurityError extends Error {
  readonly code: 'not-found' | 'access-denied' | 'native-error'

  constructor(code: 'not-found' | 'access-denied' | 'native-error', message: string) {
    super(message)
    this.name = 'RuntimeFileSecurityError'
    this.code = code
  }
}

function boundedString(value: unknown, field: string, maximum = 16 * 1024): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
    throw new Error(field + ' must be a bounded non-empty string')
  }
  return value
}

function normalizeIdentity(value: unknown, platform: NodeJS.Platform): RuntimeFileIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('runtime file identity was malformed')
  const identity = value as Record<string, unknown>
  if (platform === 'win32') {
    if (identity['platform'] !== 'win32') throw new Error('runtime file identity platform was malformed')
    return {
      platform: 'win32',
      volumeSerial: boundedString(identity['volumeSerial'], 'volumeSerial', 256),
      fileId: boundedString(identity['fileId'], 'fileId', 256)
    }
  }
  if (identity['platform'] !== 'posix') throw new Error('runtime file identity platform was malformed')
  return {
    platform: 'posix',
    device: boundedString(identity['device'], 'device', 256),
    inode: boundedString(identity['inode'], 'inode', 256)
  }
}

function observationError(value: unknown): RuntimeFileSecurityError | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('native runtime file observation was malformed')
  const observation = value as Record<string, unknown>
  if (observation['ok'] === true) return null
  if (observation['ok'] !== false) throw new Error('native runtime file observation was malformed')
  const code = observation['code']
  if (code !== 'not-found' && code !== 'access-denied' && code !== 'native-error') {
    throw new Error('native runtime file observation had an unknown error code')
  }
  const message = typeof observation['message'] === 'string' && observation['message'].length > 0
    ? observation['message'].slice(0, 4096)
    : 'native runtime file observation failed'
  return new RuntimeFileSecurityError(code, message)
}

export function createPrivateRuntimeFileReader(addon: NativeRuntimeFileAddon, expectedPlatform: NodeJS.Platform = process.platform): RuntimeFileReader {
  if (addon.platform !== expectedPlatform) throw new Error('runtime file security addon platform mismatch')
  if (addon.runtimeFileSecurityContractVersion !== 1) throw new Error('runtime file security addon contract mismatch')
  if (typeof addon.readPrivateRuntimeFile !== 'function') throw new Error('runtime file security addon is missing readPrivateRuntimeFile')
  const read = addon.readPrivateRuntimeFile as (path: string, maxBytes: number) => NativeRuntimeFileObservation

  return (path, maxBytes) => {
    if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) throw new RuntimeFileSecurityError('native-error', 'runtime file path was malformed')
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 8 * 1024 * 1024) throw new RuntimeFileSecurityError('native-error', 'runtime file size limit was malformed')
    let observation: NativeRuntimeFileObservation
    try {
      observation = read(path, maxBytes)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new RuntimeFileSecurityError('native-error', message.slice(0, 4096))
    }
    const failure = observationError(observation)
    if (failure) throw failure
    const success = observation as Extract<NativeRuntimeFileObservation, { ok: true }>
    if (!Buffer.isBuffer(success.bytes)) throw new Error('native runtime file success was malformed')
    if (success.bytes.length > maxBytes) throw new Error('native runtime file exceeded requested limit')
    const fileIdentity = normalizeIdentity(success.fileIdentity, expectedPlatform)
    const bytes = Buffer.from(success.bytes)
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), fileIdentity }
  }
}
export function createPrivateRuntimeFileIdentityReader(addon: NativeRuntimeFileAddon, expectedPlatform: NodeJS.Platform = process.platform): RuntimeFileIdentityReader {
  if (addon.platform !== expectedPlatform) throw new Error('runtime file security addon platform mismatch')
  if (addon.runtimeFileSecurityContractVersion !== 1) throw new Error('runtime file security addon contract mismatch')
  if (typeof addon.readPrivateRuntimeFileIdentity !== 'function') throw new Error('runtime file security addon is missing readPrivateRuntimeFileIdentity')
  const readIdentity = addon.readPrivateRuntimeFileIdentity as (path: string) => NativeRuntimeFileIdentityObservation
  return path => {
    if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) throw new RuntimeFileSecurityError('native-error', 'runtime file path was malformed')
    let observation: NativeRuntimeFileIdentityObservation
    try { observation = readIdentity(path) } catch (error) {
      throw new RuntimeFileSecurityError('native-error', (error instanceof Error ? error.message : String(error)).slice(0, 4096))
    }
    const failure = observationError(observation)
    if (failure) throw failure
    return normalizeIdentity((observation as Extract<NativeRuntimeFileIdentityObservation, { ok: true }>).fileIdentity, expectedPlatform)
  }
}
export function createPrivateRuntimeDirectoryValidator(addon: NativeRuntimeFileAddon, expectedPlatform: NodeJS.Platform = process.platform): RuntimeDirectoryValidator {
  if (addon.platform !== expectedPlatform) throw new Error('runtime directory security addon platform mismatch')
  if (addon.runtimeFileSecurityContractVersion !== 1) throw new Error('runtime directory security addon contract mismatch')
  if (typeof addon.validatePrivateRuntimeDirectory !== 'function') throw new Error('runtime directory security addon is missing validatePrivateRuntimeDirectory')
  const validateDirectory = addon.validatePrivateRuntimeDirectory as (path: string) => NativeRuntimeDirectoryObservation
  return path => {
    if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) throw new RuntimeFileSecurityError('native-error', 'runtime directory path was malformed')
    let observation: NativeRuntimeDirectoryObservation
    try { observation = validateDirectory(path) } catch (error) {
      throw new RuntimeFileSecurityError('native-error', (error instanceof Error ? error.message : String(error)).slice(0, 4096))
    }
    const failure = observationError(observation)
    if (failure) throw failure
    normalizeIdentity((observation as Extract<NativeRuntimeDirectoryObservation, { ok: true }>).fileIdentity, expectedPlatform)
  }
}
export function createRuntimeAuthorityLock(addon: NativeRuntimeFileAddon, expectedPlatform: NodeJS.Platform = process.platform): RuntimeAuthorityLock {
  if (addon.platform !== expectedPlatform) throw new Error('runtime authority addon platform mismatch')
  if (addon.runtimeFileSecurityContractVersion !== 1) throw new Error('runtime authority addon contract mismatch')
  if (typeof addon.withRuntimeAuthorityLock !== 'function') throw new Error('runtime authority addon is missing withRuntimeAuthorityLock')
  const lock = addon.withRuntimeAuthorityLock as (path: string, callback: (stablePath: string) => unknown, readOnly?: boolean) => unknown
  return <T>(path: string, callback: (stablePath: string) => T, options: { readOnly?: boolean } = {}): T => {
    if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) throw new RuntimeFileSecurityError('native-error', 'runtime authority path was malformed')
    let callbackFailed = false
    let callbackError: unknown
    const guardedCallback = (stablePath: string): T => {
      try {
        return callback(stablePath)
      } catch (error) {
        callbackFailed = true
        callbackError = error
        throw error
      }
    }
    try {
      return lock(path, guardedCallback, options.readOnly === true) as T
    } catch (error) {
      if (callbackFailed) throw callbackError
      throw new RuntimeFileSecurityError('native-error', (error instanceof Error ? error.message : String(error)).slice(0, 4096))
    }
  }
}

function loadNativeAddon(): NativeRuntimeFileAddon {
  const electronProcess = process as NodeJS.Process & { resourcesPath?: string; defaultApp?: boolean }
  const defaultApp = electronProcess.defaultApp ?? process.env['ELECTRON_RUN_AS_NODE'] === '1'
  return createRequire(__filename)(resolveNativeRuntimeAddonPath(__dirname, { resourcesPath: electronProcess.resourcesPath, defaultApp })) as NativeRuntimeFileAddon
}

let defaultReader: RuntimeFileReader | undefined

export function privateRuntimeFileReader(): RuntimeFileReader {
  if (!defaultReader) defaultReader = createPrivateRuntimeFileReader(loadNativeAddon())
  return defaultReader
}
let defaultIdentityReader: RuntimeFileIdentityReader | undefined

export function privateRuntimeFileIdentityReader(): RuntimeFileIdentityReader {
  if (!defaultIdentityReader) defaultIdentityReader = createPrivateRuntimeFileIdentityReader(loadNativeAddon())
  return defaultIdentityReader
}
let defaultAuthorityLock: RuntimeAuthorityLock | undefined

export function runtimeAuthorityLock(): RuntimeAuthorityLock {
  if (!defaultAuthorityLock) defaultAuthorityLock = createRuntimeAuthorityLock(loadNativeAddon())
  return defaultAuthorityLock
}
let defaultDirectoryValidator: RuntimeDirectoryValidator | undefined

export function privateRuntimeDirectoryValidator(): RuntimeDirectoryValidator {
  if (!defaultDirectoryValidator) defaultDirectoryValidator = createPrivateRuntimeDirectoryValidator(loadNativeAddon())
  return defaultDirectoryValidator
}

export function canonicalPrivateDirectory(path: string, options: { create?: boolean; requireCanonical?: boolean; directoryValidator?: RuntimeDirectoryValidator } = {}): string {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || !isAbsolute(path)) {
    throw new RuntimeFileSecurityError('access-denied', 'runtime directory must be absolute')
  }
  const resolved = resolve(path)
  if (options.create) mkdirSync(resolved, { recursive: true, mode: 0o700 })
  const link = lstatSync(resolved)
  if (link.isSymbolicLink() || !link.isDirectory()) throw new RuntimeFileSecurityError('access-denied', 'runtime directory must not be a link')
  const canonical = realpathSync.native(resolved)
  const samePath = process.platform === 'win32' ? canonical.toLowerCase() === resolved.toLowerCase() : canonical === resolved
  if (options.requireCanonical && !samePath) throw new RuntimeFileSecurityError('access-denied', 'runtime directory path was not canonical')
  if (process.platform !== 'win32') {
    if (options.create) chmodSync(canonical, 0o700)
    const stat = statSync(canonical)
    if ((process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) {
      throw new RuntimeFileSecurityError('access-denied', 'runtime directory must be owned by the current user and private')
    }
  }
  if (process.platform === 'win32') (options.directoryValidator ?? privateRuntimeDirectoryValidator())(canonical)
  return canonical
}
export function readPrivateRuntimeFile(path: string, maxBytes: number, reader: RuntimeFileReader = privateRuntimeFileReader()): RuntimeFileRead {
  return reader(path, maxBytes)
}
