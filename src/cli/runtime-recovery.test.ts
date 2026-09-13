// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPrivateRuntimeFileReader, type NativeRuntimeFileAddon } from '@shared/runtime-file-security'
import { RuntimeOwnershipStore } from '@shared/runtime-ownership'
import { inspectRuntimeRecovery, quarantineLegacyRuntime } from './runtime-recovery'

function addon(bytes: Buffer, identity: Record<string, string> = { platform: 'posix', device: '1', inode: '2' }): NativeRuntimeFileAddon {
  return { platform: process.platform, runtimeFileSecurityContractVersion: 1, readPrivateRuntimeFile: () => ({ ok: true, bytes, fileIdentity: identity }) }
}

async function startLegacyServer(endpoint: string, token: string): Promise<ChildProcess> {
  const source = [
    "const net = require('node:net')",
    "const endpoint = process.argv[1]",
    "const token = process.argv[2]",
    "const server = net.createServer(socket => {",
    "  let input = ''",
    "  socket.setEncoding('utf8')",
    "  socket.on('data', chunk => {",
    "    input += chunk",
    "    const newline = input.indexOf(String.fromCharCode(10))",
    "    if (newline < 0) return",
    "    const message = JSON.parse(input.slice(0, newline))",
    "    socket.end(JSON.stringify({ id: message.id, ok: message.authToken === token }) + String.fromCharCode(10))",
    "  })",
    "})",
    "server.listen(endpoint, () => process.stdout.write('ready' + String.fromCharCode(10)))"
  ].join(String.fromCharCode(10))
  const child = spawn(process.execPath, ['-e', source, endpoint, token], { stdio: ['ignore', 'pipe', 'pipe'] })
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
  it('inspects without mutation and requires the exact fingerprint confirmation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'runtime-recovery-'))
    const runtimeFile = join(directory, 'donwells-runtime.json')
    const bytes = Buffer.from(JSON.stringify({ socketPath: join(directory, 'old.sock'), authToken: 'legacy-token-123456', pid: 123 }))
    writeFileSync(runtimeFile, bytes, { mode: 0o600 })
    const reader = createPrivateRuntimeFileReader(addon(bytes), process.platform)
    try {
      const inspected = inspectRuntimeRecovery({ userDataDir: directory, kind: 'donwells-app', reader })
      expect(inspected).toMatchObject({ runtimeKind: 'donwells-app', pid: 123, verdict: 'legacy-record', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
      expect(readFileSync(runtimeFile)).toEqual(bytes)
      const store = new RuntimeOwnershipStore(join(directory, 'runtime-owners.sqlite'))
      expect(() => quarantineLegacyRuntime({ userDataDir: directory, kind: 'donwells-app', reader, store, confirm: 'wrong' })).toThrowError(expect.objectContaining({ code: 'RECOVERY_CONFIRMATION' }))
      store.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('writes exclusive evidence first, resumes after interruption, and records an audited recovery', () => {
    const directory = mkdtempSync(join(tmpdir(), 'runtime-recovery-resume-'))
    const runtimeFile = join(directory, 'donwells-runtime.json')
    const bytes = Buffer.from(JSON.stringify({ socketPath: join(directory, 'old.sock'), authToken: 'legacy-token-123456', pid: 321 }))
    writeFileSync(runtimeFile, bytes, { mode: 0o600 })
    const reader = createPrivateRuntimeFileReader(addon(bytes), process.platform)
    const store = new RuntimeOwnershipStore(join(directory, 'runtime-owners.sqlite'))
    const noLegacyContact = (): boolean => false
    let interrupted = false
    try {
      const inspected = inspectRuntimeRecovery({ userDataDir: directory, kind: 'donwells-app', reader })
      expect(() => quarantineLegacyRuntime({
        userDataDir: directory,
        kind: 'donwells-app',
        reader,
        store,
        confirm: inspected.sha256!,
        canContactLegacy: noLegacyContact,
        afterEvidenceWrite: () => { interrupted = true; throw new Error('injected interruption') }
      })).toThrow(/injected interruption/)
      expect(interrupted).toBe(true)
      const resumed = quarantineLegacyRuntime({ userDataDir: directory, kind: 'donwells-app', reader, store, confirm: inspected.sha256!, canContactLegacy: noLegacyContact })
      expect(resumed.state).toBe('committed')
      expect(readFileSync(runtimeFile)).toEqual(bytes)
      expect(readFileSync(resumed.evidencePath)).toEqual(bytes)
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('refuses a changed same-handle fingerprint and never mutates a Windows named-pipe endpoint', () => {
    const directory = mkdtempSync(join(tmpdir(), 'runtime-recovery-windows-'))
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
      expect(() => quarantineLegacyRuntime({ userDataDir: directory, kind: 'donwells-app', reader, store, confirm: first.sha256! })).toThrowError(expect.objectContaining({ code: 'RECOVERY_CHANGED' }))
      expect(readFileSync(runtimeFile)).toEqual(bytesA)
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('refuses an authenticated reachable legacy endpoint before evidence write', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'runtime-recovery-live-'))
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
      expect(() => quarantineLegacyRuntime({ userDataDir: directory, kind: 'donwells-app', reader, store, confirm: inspected.sha256! })).toThrowError(expect.objectContaining({ code: 'RECOVERY_LIVE' }))
      expect(readFileSync(runtimeFile)).toEqual(bytes)
    } finally {
      store.close()
      await stopLegacyServer(server)
      rmSync(directory, { recursive: true, force: true })
    }
  })

})
