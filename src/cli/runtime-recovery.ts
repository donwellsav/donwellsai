import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { localRuntimePaths, parseRuntimeRecordBytes } from '../main/local-runtime.js'
import { canonicalPrivateDirectory, readPrivateRuntimeFile, type RuntimeFileRead, type RuntimeFileReader } from '../shared/runtime-file-security.js'
import type { RuntimeIdentityAuthority } from '../shared/child-process/process-spec.js'
import {
  readVerifiedRecoveryEvidence,
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

export type LegacyReachabilityProbe = (kind: RuntimeOwnerKind, socketPath: string, authToken: string) => boolean

export type QuarantineOptions = RuntimeRecoveryOptions & {
  store: RuntimeOwnershipStore
  authority?: RuntimeIdentityAuthority
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
  const canonicalProfile = canonicalPrivateDirectory(options.userDataDir, { requireCanonical: true })
  const runtimeFile = localRuntimePaths(canonicalProfile, options.kind === 'donwells-app' ? 'app' : 'terminal').runtimeFile
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
  const directory = join(canonicalPrivateDirectory(options.userDataDir, { requireCanonical: true }), 'runtime-recovery')
  canonicalPrivateDirectory(directory, { create: true, requireCanonical: true })
  return join(directory, options.kind + '-' + fingerprint + '.json')
}

function writeEvidence(path: string, bytes: Buffer): RuntimeFileRead {
  if (!existsSync(path)) {
    try {
      writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  let evidence
  try {
    evidence = readPrivateRuntimeFile(path, 64 * 1024)
  } catch (error) {
    throw new RuntimeRecoveryError('RECOVERY_CHANGED', error instanceof Error ? error.message : String(error))
  }
  if (!evidence.bytes.equals(bytes)) throw new RuntimeRecoveryError('RECOVERY_CHANGED', 'recovery evidence differs from the confirmed bytes')
  return evidence
}

function contactLegacyEndpoint(kind: RuntimeOwnerKind, socketPath: string, authToken: string): boolean {
  const probe = [
    "const net = require('node:net')",
    "const kind = process.argv[1]",
    "const socketPath = process.argv[2]",
    "const authToken = process.argv[3]",
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
    "socket.once('connect', () => {",
    "  const hello = kind === 'donwells-app' ? { id: 'runtime-recovery', method: 'auth.hello', authToken } : { id: 'runtime-recovery', op: 'hello', authToken }",
    "  socket.write(JSON.stringify(hello) + String.fromCharCode(10))",
    "})"
  ].join(String.fromCharCode(10))
  try {
    execFileSync(process.execPath, ['-e', probe, kind, socketPath, authToken], { stdio: 'ignore', timeout: 1_500, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    return true
  } catch {
    return false
  }
}


export function quarantineRuntime(options: QuarantineOptions): QuarantineResult {
  const { inspection, bytes } = inspectWithBytes(options)
  if ((inspection.verdict !== 'legacy-record' && inspection.verdict !== 'current-owner')
    || bytes === null || inspection.sha256 === null || inspection.endpoint === null || inspection.fileIdentity === null) {
    throw new RuntimeRecoveryError('RECOVERY_UNAVAILABLE', 'only a recognized runtime locator can be quarantined')
  }
  if (options.confirm !== inspection.sha256) {
    if (/^[a-f0-9]{64}$/.test(options.confirm)) throw new RuntimeRecoveryError('RECOVERY_CHANGED', 'runtime locator bytes changed since confirmation')
    throw new RuntimeRecoveryError('RECOVERY_CONFIRMATION', 'confirmation fingerprint did not match the locator bytes')
  }
  const parsed = parseRuntimeRecordBytes(bytes)
  if (parsed.status === 'invalid') throw new RuntimeRecoveryError('RECOVERY_UNAVAILABLE', 'runtime locator was invalid')
  if (parsed.status === 'current') {
    const identity = options.authority?.verify(parsed.record.processIdentity)
    if (!identity) throw new RuntimeRecoveryError('RECOVERY_UNVERIFIABLE', 'version-2 quarantine requires native process identity verification')
    if (identity.status === 'valid') throw new RuntimeRecoveryError('RECOVERY_LIVE', 'the version-2 runtime process identity is still live')
    if (identity.status === 'indeterminate') throw new RuntimeRecoveryError('RECOVERY_UNVERIFIABLE', 'the version-2 runtime process identity could not be disproved')
  }
  const contact = options.canContactLegacy ?? contactLegacyEndpoint
  if (contact(options.kind, inspection.endpoint, parsed.record.authToken)) {
    throw new RuntimeRecoveryError('RECOVERY_LIVE', 'the runtime endpoint is reachable; it was not quarantined')
  }

  const evidencePath = evidenceFor(options, inspection.sha256)
  const evidence = writeEvidence(evidencePath, bytes)
  options.afterEvidenceWrite?.()
  const fresh = inspectWithBytes(options)
  if (fresh.inspection.sha256 !== inspection.sha256 || JSON.stringify(fresh.inspection.fileIdentity) !== JSON.stringify(inspection.fileIdentity)) {
    throw new RuntimeRecoveryError('RECOVERY_CHANGED', 'runtime locator identity changed after evidence was written')
  }
  const recordType = parsed.status === 'legacy' ? 'legacy' : 'orphan-v2'
  const recovery = options.store.recordLegacyRecovery({
    id: options.kind + '-' + inspection.sha256,
    kind: options.kind,
    expectedFingerprint: inspection.sha256,
    fileIdentity: inspection.fileIdentity,
    evidencePath,
    evidenceFileIdentity: evidence.fileIdentity,
    endpoint: inspection.endpoint,
    recordType
  })
  options.afterRecoveryCommit?.()
  const committed = inspectWithBytes(options).inspection
  if (committed.sha256 !== inspection.sha256 || JSON.stringify(committed.fileIdentity) !== JSON.stringify(inspection.fileIdentity)
    || committed.endpoint !== inspection.endpoint || committed.verdict !== inspection.verdict) {
    throw new RuntimeRecoveryError('RECOVERY_CHANGED', 'runtime locator identity changed after recovery was committed')
  }
  let verified: Buffer
  try { verified = readVerifiedRecoveryEvidence(recovery) } catch (error) {
    throw new RuntimeRecoveryError('RECOVERY_CHANGED', error instanceof Error ? error.message : String(error))
  }
  const verifiedRecord = parseRuntimeRecordBytes(verified)
  if (verifiedRecord.status === 'invalid' || verifiedRecord.record.socketPath !== recovery.endpoint
    || (recordType === 'legacy') !== (verifiedRecord.status === 'legacy')) {
    throw new RuntimeRecoveryError('RECOVERY_CHANGED', 'recovery evidence metadata did not match its committed row')
  }
  return { ...recovery, evidencePath }
}
