import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import type { ProcessIdentity } from '../shared/child-process/process-spec'
import {
  privateRuntimeFileReader,
  readPrivateRuntimeFile,
  type RuntimeFileIdentity,
  type RuntimeFileReader
} from '../shared/runtime-file-security'

const MAX_RUNTIME_BYTES = 64 * 1024
const MAX_FIELD_LENGTH = 16 * 1024
const MAX_SOCKET_LENGTH = 4096
const MIN_TOKEN_LENGTH = 16

export type LocalRuntimeRecord = {
  version: 2
  ownerId: string
  ownerGeneration: number
  socketPath: string
  authToken: string
  processIdentity: ProcessIdentity
}

export type LegacyRuntimeRecord = {
  socketPath: string
  authToken: string
  pid?: number
}

export type RuntimeRecordRead =
  | { status: 'missing' }
  | { status: 'current'; record: LocalRuntimeRecord; sha256: string; fileIdentity: RuntimeFileIdentity }
  | { status: 'legacy'; record: LegacyRuntimeRecord; sha256: string; fileIdentity: RuntimeFileIdentity }
  | { status: 'invalid'; reason: string }

type ParsedRuntimeRecord =
  | { status: 'current'; record: LocalRuntimeRecord }
  | { status: 'legacy'; record: LegacyRuntimeRecord }
  | { status: 'invalid'; reason: string }


export type LocalRuntimePaths = {
  runtimeDir: string
  runtimeFile: string
  socketDir: string
  socketPath: string
  ownershipDatabasePath: string
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('runtime record must be an object')
  return value as Record<string, unknown>
}

function stringField(value: unknown, field: string, maximum = MAX_FIELD_LENGTH): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
    throw new Error(field + ' must be a bounded non-empty string')
  }
  return value
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(field + ' must be a positive safe integer')
  return value as number
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error('runtime record fields were not exact')
}

function processIdentity(value: unknown): ProcessIdentity {
  const identity = objectRecord(value)
  exactKeys(identity, ['pid', 'bootId', 'startedAt', 'executablePath', 'family', 'capturedAt', 'generation'])
  const family = identity['family']
  if (family !== 'donwells-app' && family !== 'terminal-daemon') throw new Error('runtime process identity family was invalid')
  return {
    pid: positiveInteger(identity['pid'], 'processIdentity.pid'),
    bootId: stringField(identity['bootId'], 'processIdentity.bootId'),
    startedAt: stringField(identity['startedAt'], 'processIdentity.startedAt'),
    executablePath: stringField(identity['executablePath'], 'processIdentity.executablePath'),
    family,
    capturedAt: stringField(identity['capturedAt'], 'processIdentity.capturedAt'),
    generation: stringField(identity['generation'], 'processIdentity.generation')
  }
}

function validateEndpoint(value: unknown): string {
  const endpoint = stringField(value, 'socketPath', MAX_SOCKET_LENGTH)
  const unix = endpoint.startsWith('/')
  const pipe = /^\\\\\.\\pipe\\[^\\/\0]+$/i.test(endpoint)
  if (!unix && !pipe) throw new Error('socketPath must be an absolute Unix socket or Windows named pipe')
  return endpoint
}

function assertCurrentRecordRelationships(record: LocalRuntimeRecord): void {
  const otherKind = record.processIdentity.family === 'donwells-app' ? 'terminal' : 'app'
  if (record.socketPath.includes('donwells-' + otherKind + '-')) {
    throw new Error('socketPath contradicted the process identity family')
  }
  if (record.processIdentity.generation !== record.ownerId + ':' + record.ownerGeneration) {
    throw new Error('processIdentity.generation did not match runtime ownership')
  }
}

function rejectDuplicateKeys(text: string): void {
  const stack: Array<{ kind: 'object'; keys: Set<string> } | { kind: 'array' }> = []
  for (let index = 0; index < text.length;) {
    const char = text[index]!
    if (char === '"') {
      const start = index++
      while (index < text.length) {
        if (text[index] === '\\') { index += 2; continue }
        if (text[index++] === '"') break
      }
      let next = index
      while (/\s/.test(text[next] ?? '')) next++
      const frame = stack.at(-1)
      if (text[next] === ':' && frame?.kind === 'object') {
        const key = JSON.parse(text.slice(start, index)) as string
        if (frame.keys.has(key)) throw new Error('runtime record contains duplicate fields')
        frame.keys.add(key)
      }
      continue
    }
    if (char === '{') stack.push({ kind: 'object', keys: new Set() })
    else if (char === '[') stack.push({ kind: 'array' })
    else if (char === '}' || char === ']') stack.pop()
    index++
  }
}

export function parseRuntimeRecordBytes(bytes: Buffer): ParsedRuntimeRecord {
  if (bytes.length > MAX_RUNTIME_BYTES) return { status: 'invalid', reason: 'runtime record exceeds size limit' }
  let parsed: unknown
  try {
    const text = bytes.toString('utf8')
    rejectDuplicateKeys(text)
    parsed = JSON.parse(text)
  } catch (error) {
    return { status: 'invalid', reason: error instanceof Error ? error.message : 'runtime record JSON was malformed' }
  }
  try {
    const value = objectRecord(parsed)
    if (value['version'] === 2) {
      exactKeys(value, ['version', 'ownerId', 'ownerGeneration', 'socketPath', 'authToken', 'processIdentity'])
      const ownerId = stringField(value['ownerId'], 'ownerId', 128)
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ownerId)) throw new Error('ownerId must be a UUID')
      const record: LocalRuntimeRecord = {
        version: 2,
        ownerId,
        ownerGeneration: positiveInteger(value['ownerGeneration'], 'ownerGeneration'),
        socketPath: validateEndpoint(value['socketPath']),
        authToken: stringField(value['authToken'], 'authToken', MAX_FIELD_LENGTH),
        processIdentity: processIdentity(value['processIdentity'])
      }
      if (record.authToken.length < MIN_TOKEN_LENGTH) throw new Error('authToken is too short')
      assertCurrentRecordRelationships(record)
      return { status: 'current', record }
    }
    if ('version' in value) throw new Error('runtime record version was unsupported')
    exactKeys(value, ['socketPath', 'authToken', ...(value['pid'] === undefined ? [] : ['pid'])])
    const record: LegacyRuntimeRecord = {
      socketPath: validateEndpoint(value['socketPath']),
      authToken: stringField(value['authToken'], 'authToken', MAX_FIELD_LENGTH)
    }
    if (record.authToken.length < MIN_TOKEN_LENGTH) throw new Error('authToken is too short')
    if (value['pid'] !== undefined) record.pid = positiveInteger(value['pid'], 'pid')
    return { status: 'legacy', record }
  } catch (error) {
    return { status: 'invalid', reason: error instanceof Error ? error.message : 'runtime record was malformed' }
  }
}

export function readRuntimeRecord(path: string, reader: RuntimeFileReader = privateRuntimeFileReader()): RuntimeRecordRead {
  let source
  try {
    source = readPrivateRuntimeFile(path, MAX_RUNTIME_BYTES, reader)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error['code'] === 'not-found') return { status: 'missing' }
    const reason = error instanceof Error ? error.message : String(error)
    return { status: 'invalid', reason }
  }
  const parsed = parseRuntimeRecordBytes(source.bytes)
  if (parsed.status === 'invalid') return parsed
  return { ...parsed, sha256: source.sha256, fileIdentity: source.fileIdentity }
}

export function writeRuntimeRecord(path: string, record: LocalRuntimeRecord): void {
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const parent = lastSlash >= 0 ? path.slice(0, lastSlash) : ''
  if (parent) mkdirSync(parent, { recursive: true, mode: 0o700 })
  const temporary = path + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(temporary, Buffer.from(JSON.stringify(record)), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function localRuntimePaths(userDataDir: string, kind: 'app' | 'terminal', platform: NodeJS.Platform = process.platform): LocalRuntimePaths {
  const path = platform === 'win32' ? win32 : posix
  const profile = path.resolve(userDataDir)
  const runtimeDir = kind === 'terminal' ? path.join(profile, 'terminal-daemon') : profile
  const runtimeFile = path.join(runtimeDir, kind === 'terminal' ? 'runtime.json' : 'donwells-runtime.json')
  const profileKey = createHash('sha256').update(platform === 'win32' ? profile.toLowerCase() : profile).digest('hex').slice(0, 24)
  if (platform === 'win32') {
    return {
      runtimeDir,
      runtimeFile,
      socketDir: runtimeDir,
      socketPath: String.raw`\\.\pipe\donwells-${kind}-` + profileKey,
      ownershipDatabasePath: path.join(profile, 'runtime-owners.sqlite')
    }
  }
  const directoryName = 'donwells-' + kind + '-' + (process.getuid?.() ?? 'user')
  let socketDir = join(tmpdir(), directoryName)
  const fileName = profileKey + '.sock'
  if (Buffer.byteLength(path.join(socketDir, fileName)) + 37 > 103) socketDir = path.join('/tmp', directoryName)
  return {
    runtimeDir,
    runtimeFile,
    socketDir,
    socketPath: path.join(socketDir, fileName),
    ownershipDatabasePath: path.join(profile, 'runtime-owners.sqlite')
  }
}
