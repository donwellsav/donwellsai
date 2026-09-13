// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPrivateRuntimeFileReader, type NativeRuntimeFileAddon } from '@shared/runtime-file-security'
import { RuntimeOwnershipStore } from '@shared/runtime-ownership'
import { inspectRuntimeRecovery, quarantineRuntime } from './runtime-recovery'

function addon(bytes: Buffer, identity: Record<string, string> = { platform: 'posix', device: '1', inode: '2' }): NativeRuntimeFileAddon {
  return { platform: process.platform, runtimeFileSecurityContractVersion: 1, readPrivateRuntimeFile: () => ({ ok: true, bytes, fileIdentity: identity }) }
}

async function startLegacyServer(endpoint: string, token: string, kind: 'donwells-app' | 'terminal-daemon' = 'donwells-app'): Promise<ChildProcess> {
  const source = [
    "const net = require('node:net')",
    "const endpoint = process.argv[1]",
    "const token = process.argv[2]",
    "const kind = process.argv[3]",
    "const server = net.createServer(socket => {",
    "  let input = ''",
    "  socket.setEncoding('utf8')",
    "  socket.on('data', chunk => {",
    "    input += chunk",
    "    const newline = input.indexOf(String.fromCharCode(10))",
    "    if (newline < 0) return",
    "    const message = JSON.parse(input.slice(0, newline))",
    "    const validShape = kind === 'donwells-app' ? message.method === 'auth.hello' && message.op === undefined : message.op === 'hello' && message.method === undefined",
    "    socket.end(JSON.stringify({ id: message.id, ok: validShape && message.authToken === token }) + String.fromCharCode(10))",
    "  })",
    "})",
    "server.listen(endpoint, () => process.stdout.write('ready' + String.fromCharCode(10)))"
  ].join(String.fromCharCode(10))
  const child = spawn(process.execPath, ['-e', source, endpoint, token, kind], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout?.setEncoding('utf8')
  const ready = Promise.withResolvers<void>()
  const onData = (chunk: string | Buffer): void => {
    if (chunk.toString().includes('ready')) ready.resolve()
  }
  const onError = (error: Error): void => ready.reject(error)
  child.stdout?.on('data', onData)
  child.once('error', onError)
  child.once('exit', (code, signal) => {
    if (code !== null || signal !== null) ready.reject(new Error('legacy fixture exited before listening'))
  })
  await ready.promise
  child.stdout?.removeListener('data', onData)
  child.removeListener('error', onError)
  return child
}

async function stopLegacyServer(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill()
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
}

describe('legacy runtime recovery', () => {
  it.runIf(process.platform !== 'win32')('rejects a symlinked non-canonical user-data profile', () => {
    const parent = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-recovery-profile-')))
    const profile = join(parent, 'profile')
    const alias = join(parent, 'alias')
    mkdirSync(profile, { mode: 0o700 })
    symlinkSync(profile, alias)
    try {
      expect(() => inspectRuntimeRecovery({ userDataDir: alias, kind: 'donwells-app' })).toThrow(/canonical|link/)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
  it('inspects without mutation and requires the exact fingerprint confirmation', () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-recovery-')))
    const runtimeFile = join(directory, 'donwells-runtime.json')
    const bytes = Buffer.from(JSON.stringify({ socketPath: join(directory, 'old.sock'), authToken: 'legacy-token-123456', pid: 123 }))
    writeFileSync(runtimeFile, bytes, { mode: 0o600 })
    const reader = createPrivateRuntimeFileReader(addon(bytes), process.platform)
    try {
      const inspected = inspectRuntimeRecovery({ userDataDir: directory, kind: 'donwells-app', reader })
      expect(inspected).toMatchObject({ runtimeKind: 'donwells-app', pid: 123, verdict: 'legacy-record', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
      expect(readFileSync(runtimeFile)).toEqual(bytes)
      const store = new RuntimeOwnershipStore(join(directory, 'runtime-owners.sqlite'))
      expect(() => quarantineRuntime({ userDataDir: directory, kind: 'donwells-app', reader, store, confirm: 'wrong' })).toThrowError(expect.objectContaining({ code: 'RECOVERY_CONFIRMATION' }))
      store.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('writes exclusive evidence first, resumes after interruption, and records an audited recovery', () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-recovery-resume-')))
    const runtimeFile = join(directory, 'donwells-runtime.json')
    const bytes = Buffer.from(JSON.stringify({ socketPath: join(directory, 'old.sock'), authToken: 'legacy-token-123456', pid: 321 }))
    writeFileSync(runtimeFile, bytes, { mode: 0o600 })
    const reader = createPrivateRuntimeFileReader(addon(bytes), process.platform)
    const store = new RuntimeOwnershipStore(join(directory, 'runtime-owners.sqlite'))
    const noLegacyContact = (): boolean => false
    let interrupted = false
    try {
      const inspected = inspectRuntimeRecovery({ userDataDir: directory, kind: 'donwells-app', reader })
      expect(() => quarantineRuntime({
        userDataDir: directory,
        kind: 'donwells-app',
        reader,
        store,
        confirm: inspected.sha256!,
        canContactLegacy: noLegacyContact,
        afterEvidenceWrite: () => { interrupted = true; throw new Error('injected interruption') }
      })).toThrow(/injected interruption/)
      expect(interrupted).toBe(true)
      const resumed = quarantineRuntime({ userDataDir: directory, kind: 'donwells-app', reader, store, confirm: inspected.sha256!, canContactLegacy: noLegacyContact })
      expect(resumed.state).toBe('committed')
      expect(readFileSync(runtimeFile)).toEqual(bytes)
      expect(readFileSync(resumed.evidencePath)).toEqual(bytes)
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('resumes a recovery whose durable commit completed before interruption', () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-recovery-commit-')))
    const runtimeFile = join(directory, 'donwells-runtime.json')
    const bytes = Buffer.from(JSON.stringify({ socketPath: join(directory, 'missing.sock'), authToken: 'legacy-commit-token-123456', pid: 322 }))
    writeFileSync(runtimeFile, bytes, { mode: 0o600 })
    const reader = createPrivateRuntimeFileReader(addon(bytes), process.platform)
    const store = new RuntimeOwnershipStore(join(directory, 'runtime-owners.sqlite'))
    try {
      const inspected = inspectRuntimeRecovery({ userDataDir: directory, kind: 'donwells-app', reader })
      expect(() => quarantineRuntime({
        userDataDir: directory,
        kind: 'donwells-app',
        reader,
        store,
        confirm: inspected.sha256!,
        canContactLegacy: () => false,
        afterRecoveryCommit: () => { throw new Error('after durable commit') }
      })).toThrow(/after durable commit/)
      const resumed = quarantineRuntime({ userDataDir: directory, kind: 'donwells-app', reader, store, confirm: inspected.sha256!, canContactLegacy: () => false })
      expect(resumed.state).toBe('committed')
      expect(resumed.expectedFingerprint).toBe(inspected.sha256)
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('refuses a changed same-handle fingerprint and never mutates a Windows named-pipe endpoint', () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-recovery-windows-')))
    const runtimeFile = join(directory, 'runtime.json')
    const bytesA = Buffer.from(JSON.stringify({ socketPath: String.raw`\\.\pipe\donwells-app-old`, authToken: 'legacy-token-123456' }))
    const bytesB = Buffer.from(JSON.stringify({ socketPath: String.raw`\\.\pipe\donwells-app-other`, authToken: 'legacy-token-123456' }))
    writeFileSync(runtimeFile, bytesA, { mode: 0o600 })
    let swapped = false
    const reader = createPrivateRuntimeFileReader({
      platform: 'win32', runtimeFileSecurityContractVersion: 1,
      readPrivateRuntimeFile: () => {
        if (!swapped) { swapped = true; return { ok: true, bytes: bytesA, fileIdentity: { platform: 'win32', volumeSerial: '1', fileId: 'A' } } }
        return { ok: true, bytes: bytesB, fileIdentity: { platform: 'win32', volumeSerial: '1', fileId: 'B' } }
      }
    }, 'win32')
    const store = new RuntimeOwnershipStore(join(directory, 'runtime-owners.sqlite'))
    try {
      const first = inspectRuntimeRecovery({ userDataDir: directory, kind: 'donwells-app', reader })
      expect(() => quarantineRuntime({ userDataDir: directory, kind: 'donwells-app', reader, store, confirm: first.sha256! })).toThrowError(expect.objectContaining({ code: 'RECOVERY_CHANGED' }))
      expect(readFileSync(runtimeFile)).toEqual(bytesA)
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('refuses same bytes presented by a different file identity before committing recovery', () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-recovery-identity-')))
    const runtimeFile = join(directory, 'donwells-runtime.json')
    const bytes = Buffer.from(JSON.stringify({ socketPath: join(directory, 'missing.sock'), authToken: 'legacy-token-123456' }))
    writeFileSync(runtimeFile, bytes, { mode: 0o600 })
    let reads = 0
    const reader = createPrivateRuntimeFileReader({
      platform: 'win32', runtimeFileSecurityContractVersion: 1,
      readPrivateRuntimeFile: () => ({ ok: true, bytes, fileIdentity: { platform: 'win32', volumeSerial: '1', fileId: reads++ < 2 ? 'A' : 'B' } })
    }, 'win32')
    const store = new RuntimeOwnershipStore(join(directory, 'runtime-owners.sqlite'))
    try {
      const inspected = inspectRuntimeRecovery({ userDataDir: directory, kind: 'donwells-app', reader })
      expect(() => quarantineRuntime({ userDataDir: directory, kind: 'donwells-app', reader, store, confirm: inspected.sha256!, canContactLegacy: () => false })).toThrowError(expect.objectContaining({ code: 'RECOVERY_CHANGED' }))
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('refuses an authenticated reachable legacy endpoint before evidence write', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-recovery-live-')))
    const endpoint = join(directory, 'legacy.sock')
    const token = 'legacy-live-token-123456'
    const bytes = Buffer.from(JSON.stringify({ socketPath: endpoint, authToken: token, pid: 456 }))
    const runtimeFile = join(directory, 'donwells-runtime.json')
    writeFileSync(runtimeFile, bytes, { mode: 0o600 })
    const server = await startLegacyServer(endpoint, token)
    const reader = createPrivateRuntimeFileReader(addon(bytes), process.platform)
    const store = new RuntimeOwnershipStore(join(directory, 'runtime-owners.sqlite'))
    try {
      const inspected = inspectRuntimeRecovery({ userDataDir: directory, kind: 'donwells-app', reader })
      expect(() => quarantineRuntime({ userDataDir: directory, kind: 'donwells-app', reader, store, confirm: inspected.sha256! })).toThrowError(expect.objectContaining({ code: 'RECOVERY_LIVE' }))
      expect(readFileSync(runtimeFile)).toEqual(bytes)
    } finally {
      store.close()
      await stopLegacyServer(server)
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('uses the terminal hello wire protocol for live legacy daemon detection', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-recovery-terminal-live-')))
    const runtimeDirectory = join(directory, 'terminal-daemon')
    mkdirSync(runtimeDirectory, { mode: 0o700 })
    const endpoint = join('/tmp', 'dw-legacy-terminal-' + process.pid + '.sock')
    const token = 'legacy-terminal-token-123456'
    const bytes = Buffer.from(JSON.stringify({ socketPath: endpoint, authToken: token, pid: 457 }))
    writeFileSync(join(runtimeDirectory, 'runtime.json'), bytes, { mode: 0o600 })
    const server = await startLegacyServer(endpoint, token, 'terminal-daemon')
    const reader = createPrivateRuntimeFileReader(addon(bytes), process.platform)
    const store = new RuntimeOwnershipStore(join(directory, 'runtime-owners.sqlite'))
    try {
      const inspected = inspectRuntimeRecovery({ userDataDir: directory, kind: 'terminal-daemon', reader })
      expect(() => quarantineRuntime({ userDataDir: directory, kind: 'terminal-daemon', reader, store, confirm: inspected.sha256! })).toThrowError(expect.objectContaining({ code: 'RECOVERY_LIVE' }))
    } finally {
      store.close()
      await stopLegacyServer(server)
      rmSync(endpoint, { force: true })
      rmSync(directory, { recursive: true, force: true })
    }
  })

})
