import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

export type RuntimeFileIdentity =
  | { platform: 'posix'; device: string; inode: string }
  | { platform: 'win32'; volumeSerial: string; fileId: string }

export type NativeRuntimeFileObservation =
  | { ok: true; bytes: Buffer; fileIdentity: Record<string, string> }
  | { ok: false; code: 'not-found' | 'access-denied' | 'native-error'; message: string }

export type NativeRuntimeFileAddon = {
  platform: unknown
  runtimeFileSecurityContractVersion: unknown
  readPrivateRuntimeFile: unknown
}

export type RuntimeFileRead = {
  bytes: Buffer
  sha256: string
  fileIdentity: RuntimeFileIdentity
}

export type RuntimeFileReader = (path: string, maxBytes: number) => RuntimeFileRead

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

function loadNativeAddon(): NativeRuntimeFileAddon {
  const electronProcess = process as NodeJS.Process & { resourcesPath?: string; defaultApp?: boolean }
  const packaged = typeof electronProcess.resourcesPath === 'string' && electronProcess.defaultApp !== true
  const root = packaged ? electronProcess.resourcesPath! : resolve(__dirname, '../..')
  const addonPath = packaged ? join('native', 'runtime-identity.node') : join('resources', 'native', 'runtime-identity.node')
  return createRequire(__filename)(join(root, addonPath)) as NativeRuntimeFileAddon
}

let defaultReader: RuntimeFileReader | undefined

export function privateRuntimeFileReader(): RuntimeFileReader {
  if (!defaultReader) defaultReader = createPrivateRuntimeFileReader(loadNativeAddon())
  return defaultReader
}

export function readPrivateRuntimeFile(path: string, maxBytes: number, reader: RuntimeFileReader = privateRuntimeFileReader()): RuntimeFileRead {
  return reader(path, maxBytes)
}
