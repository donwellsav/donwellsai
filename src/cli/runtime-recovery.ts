import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { localRuntimePaths, parseRuntimeRecordBytes } from '../main/local-runtime.js'
import { readPrivateRuntimeFile, type RuntimeFileReader } from '../shared/runtime-file-security.js'
import {
  type LegacyRecoveryRecord,
  type RuntimeOwnerKind,
  type RuntimeOwnershipStore
} from '../shared/runtime-ownership.js'

export type RuntimeRecoveryOptions = {
  userDataDir: string
  kind: RuntimeOwnerKind
  reader?: RuntimeFileReader
}

export type RuntimeRecoveryInspection = {
  canonicalProfile: string
  runtimeKind: RuntimeOwnerKind
  runtimeFile: string
  endpoint: string | null
  pid: number | null
  verdict: 'missing' | 'legacy-record' | 'current-owner' | 'invalid'
  fileIdentity: Record<string, string> | null
  sha256: string | null
  reason?: string
}

export type LegacyReachabilityProbe = (socketPath: string, authToken: string) => boolean

export type QuarantineOptions = RuntimeRecoveryOptions & {
  store: RuntimeOwnershipStore
  confirm: string
  afterEvidenceWrite?: () => void
  afterRecoveryCommit?: () => void
  canContactLegacy?: LegacyReachabilityProbe
}

export type QuarantineResult = LegacyRecoveryRecord & { evidencePath: string }

export class RuntimeRecoveryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RuntimeRecoveryError'
  }
}

function runtimeFileFor(options: RuntimeRecoveryOptions): string {
  return localRuntimePaths(options.userDataDir, options.kind === 'donwells-app' ? 'app' : 'terminal').runtimeFile
}

function inspectWithBytes(options: RuntimeRecoveryOptions): { inspection: RuntimeRecoveryInspection; bytes: Buffer | null } {
  const canonicalProfile = resolve(options.userDataDir)
  const runtimeFile = runtimeFileFor(options)
  let source
  try {
    source = readPrivateRuntimeFile(runtimeFile, 64 * 1024, options.reader)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error['code'] === 'not-found') {
      return { bytes: null, inspection: { canonicalProfile, runtimeKind: options.kind, runtimeFile, endpoint: null, pid: null, verdict: 'missing', fileIdentity: null, sha256: null } }
    }
    const reason = error instanceof Error ? error.message : String(error)
    return { bytes: null, inspection: { canonicalProfile, runtimeKind: options.kind, runtimeFile, endpoint: null, pid: null, verdict: 'invalid', fileIdentity: null, sha256: null, reason } }
  }
  const parsed = parseRuntimeRecordBytes(source.bytes)
  if (parsed.status === 'invalid') {
    return { bytes: source.bytes, inspection: { canonicalProfile, runtimeKind: options.kind, runtimeFile, endpoint: null, pid: null, verdict: 'invalid', fileIdentity: source.fileIdentity, sha256: source.sha256, reason: parsed.reason } }
  }
  if (parsed.status === 'legacy') {
    return { bytes: source.bytes, inspection: { canonicalProfile, runtimeKind: options.kind, runtimeFile, endpoint: parsed.record.socketPath, pid: parsed.record.pid ?? null, verdict: 'legacy-record', fileIdentity: source.fileIdentity, sha256: source.sha256 } }
  }
  return { bytes: source.bytes, inspection: { canonicalProfile, runtimeKind: options.kind, runtimeFile, endpoint: parsed.record.socketPath, pid: parsed.record.processIdentity.pid, verdict: 'current-owner', fileIdentity: source.fileIdentity, sha256: source.sha256 } }
}

export function inspectRuntimeRecovery(options: RuntimeRecoveryOptions): RuntimeRecoveryInspection {
  return inspectWithBytes(options).inspection
}

function evidenceFor(options: QuarantineOptions, fingerprint: string): string {
  const directory = join(resolve(options.userDataDir), 'runtime-recovery')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return join(directory, options.kind + '-' + fingerprint + '.json')
}

function writeEvidence(path: string, bytes: Buffer): void {
  if (existsSync(path)) {
    if (!readFileSync(path).equals(bytes)) throw new RuntimeRecoveryError('RECOVERY_CHANGED', 'existing recovery evidence differs from the confirmed bytes')
    return
  }
  try {
    writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (!readFileSync(path).equals(bytes)) throw new RuntimeRecoveryError('RECOVERY_CHANGED', 'recovery evidence changed during quarantine')
  }
}

function contactLegacyEndpoint(socketPath: string, authToken: string): boolean {
  const probe = [
    "const net = require('node:net')",
    "const socketPath = process.argv[1]",
    "const authToken = process.argv[2]",
    "const socket = net.createConnection(socketPath)",
    "let buffer = ''",
    "const fail = () => { socket.destroy(); process.exit(1) }",
    "const timer = setTimeout(fail, 750)",
    "socket.once('error', fail)",
    "socket.on('data', chunk => {",
    "  buffer += chunk.toString('utf8')",
    "  const newline = buffer.indexOf(String.fromCharCode(10))",
    "  if (newline < 0) return",
    "  try {",
    "    const response = JSON.parse(buffer.slice(0, newline))",
    "    if (response.id !== 'runtime-recovery' || response.ok !== true) return fail()",
    "    clearTimeout(timer)",
    "    socket.destroy()",
    "    process.exit(0)",
    "  } catch { fail() }",
    "})",
    "socket.once('connect', () => socket.write(JSON.stringify({ id: 'runtime-recovery', op: 'hello', authToken }) + String.fromCharCode(10)))"
  ].join(String.fromCharCode(10))
  try {
    execFileSync(process.execPath, ['-e', probe, socketPath, authToken], { stdio: 'ignore', timeout: 1_500, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    return true
  } catch {
    return false
  }
}


export function quarantineLegacyRuntime(options: QuarantineOptions): QuarantineResult {
  const { inspection, bytes } = inspectWithBytes(options)
  if (inspection.verdict === 'current-owner') throw new RuntimeRecoveryError('RECOVERY_ACTIVE', 'a version-2 runtime owner is present')
  if (inspection.verdict !== 'legacy-record' || bytes === null || inspection.sha256 === null || inspection.endpoint === null || inspection.fileIdentity === null) {
    throw new RuntimeRecoveryError('RECOVERY_UNAVAILABLE', 'only a legacy runtime locator can be quarantined')
  }
  if (options.confirm !== inspection.sha256) {
    if (/^[a-f0-9]{64}$/.test(options.confirm)) throw new RuntimeRecoveryError('RECOVERY_CHANGED', 'runtime locator bytes changed since confirmation')
    throw new RuntimeRecoveryError('RECOVERY_CONFIRMATION', 'confirmation fingerprint did not match the locator bytes')
  }
  const legacy = JSON.parse(bytes.toString('utf8')) as { authToken: string }
  const contact = options.canContactLegacy ?? contactLegacyEndpoint
  if (contact(inspection.endpoint, legacy.authToken)) {
    throw new RuntimeRecoveryError('RECOVERY_LIVE', 'the legacy runtime endpoint is reachable; it was not quarantined')
  }

  const evidencePath = evidenceFor(options, inspection.sha256)
  writeEvidence(evidencePath, bytes)
  options.afterEvidenceWrite?.()
  const recovery = options.store.recordLegacyRecovery({
    id: options.kind + '-' + inspection.sha256,
    kind: options.kind,
    expectedFingerprint: inspection.sha256,
    fileIdentity: inspection.fileIdentity,
    evidencePath,
    endpoint: inspection.endpoint
  })
  options.afterRecoveryCommit?.()
  return { ...recovery, evidencePath }
}
