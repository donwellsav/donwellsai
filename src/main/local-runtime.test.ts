// @vitest-environment node
import { chmodSync, mkdtempSync, openSync, closeSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProcessIdentity } from '@shared/child-process/process-spec'
import {
  createPrivateRuntimeFileReader,
  type NativeRuntimeFileAddon
} from '@shared/runtime-file-security'
import {
  parseRuntimeRecordBytes,
  readRuntimeRecord,
  writeRuntimeRecord,
  type LocalRuntimeRecord
} from './local-runtime'

const identity: ProcessIdentity = {
  pid: 42,
  bootId: 'boot-1',
  startedAt: 'birth-1',
  executablePath: '/opt/donwells',
  family: 'donwells-app',
  capturedAt: '2026-09-13T00:00:00.000Z',
  generation: '7a43bc17-d6b2-4cd7-8f57-d381ba0e81ee:7'
}

const current: LocalRuntimeRecord = {
  version: 2,
  ownerId: '7a43bc17-d6b2-4cd7-8f57-d381ba0e81ee',
  ownerGeneration: 7,
  socketPath: '/tmp/donwells-app-owner-1-7.sock',
  authToken: 'a'.repeat(64),
  processIdentity: identity
}

function successfulAddon(
  platform: NodeJS.Platform,
  bytes: Buffer,
  fileIdentity: Record<string, string>
): NativeRuntimeFileAddon {
  return {
    platform,
    runtimeFileSecurityContractVersion: 1,
    readPrivateRuntimeFile: () => ({ ok: true, bytes, fileIdentity })
  }
}

describe('strict local runtime records', () => {
  it('parses exact v2 and legacy schemas while rejecting ambiguous records', () => {
    expect(parseRuntimeRecordBytes(Buffer.from(JSON.stringify(current)))).toEqual({ status: 'current', record: current })
    expect(parseRuntimeRecordBytes(Buffer.from(JSON.stringify({ socketPath: '/tmp/legacy.sock', authToken: 'legacy-token-123456', pid: 21 })))).toEqual({
      status: 'legacy',
      record: { socketPath: '/tmp/legacy.sock', authToken: 'legacy-token-123456', pid: 21 }
    })

    const ambiguous = { ...current, pid: 42 }
    expect(parseRuntimeRecordBytes(Buffer.from(JSON.stringify(ambiguous)))).toMatchObject({ status: 'invalid' })
    expect(parseRuntimeRecordBytes(Buffer.from(JSON.stringify({ ...current, ownerGeneration: 0 })))).toMatchObject({ status: 'invalid' })
    expect(parseRuntimeRecordBytes(Buffer.from(JSON.stringify({ ...current, processIdentity: { ...identity, family: 'acp-agent' } })))).toMatchObject({ status: 'invalid' })
    expect(parseRuntimeRecordBytes(Buffer.from('{"version":2,"version":2}'))).toMatchObject({ status: 'invalid' })
    expect(parseRuntimeRecordBytes(Buffer.from(JSON.stringify({ ...current, processIdentity: null })))).toMatchObject({ status: 'invalid' })
    expect(parseRuntimeRecordBytes(Buffer.from(JSON.stringify({ ...current, processIdentity: { ...identity, generation: 'pending' } })))).toMatchObject({ status: 'invalid' })
    expect(parseRuntimeRecordBytes(Buffer.from(JSON.stringify({ ...current, socketPath: 'relative.sock' })))).toMatchObject({ status: 'invalid' })
    expect(parseRuntimeRecordBytes(Buffer.from(JSON.stringify({ ...current, socketPath: '/tmp/donwells-terminal-owner.sock' })))).toMatchObject({ status: 'invalid' })
    const duplicateNested = JSON.stringify(current).replace('"pid":42', '"pid":42,"\u0070id":42')
    expect(parseRuntimeRecordBytes(Buffer.from(duplicateNested))).toMatchObject({ status: 'invalid' })
    const siblingKeys = JSON.stringify({ ...current, processIdentity: { ...identity, ownerId: 'nested' } })
    expect(parseRuntimeRecordBytes(Buffer.from(siblingKeys))).toMatchObject({ status: 'invalid' })
  })

  it('reads and hashes exactly the bytes returned by the same-handle native observation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'runtime-record-swap-'))
    const path = join(directory, 'runtime.json')
    const replacement = join(directory, 'replacement.json')
    const originalBytes = Buffer.from(JSON.stringify(current))
    const replacementBytes = Buffer.from('{"attacker":true}')
    writeFileSync(path, originalBytes, { mode: 0o600 })
    writeFileSync(replacement, replacementBytes, { mode: 0o600 })
    try {
      const native = successfulAddon(process.platform, originalBytes, { platform: 'posix', device: '1', inode: '2' })
      native.readPrivateRuntimeFile = () => {
        renameSync(replacement, path)
        return { ok: true, bytes: originalBytes, fileIdentity: { platform: 'posix', device: '1', inode: '2' } }
      }
      const reader = createPrivateRuntimeFileReader(native, process.platform)
      const result = readRuntimeRecord(path, reader)
      expect(result).toMatchObject({ status: 'current', record: current, fileIdentity: { platform: 'posix', device: '1', inode: '2' } })
      expect(readFileSync(path)).toEqual(replacementBytes)
      if (result.status !== 'current') throw new Error('runtime record was not current')
      expect(result.sha256).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('accepts injected Windows identity and rejects malformed native security observations', () => {
    const bytes = Buffer.from(JSON.stringify(current))
    const windowsReader = createPrivateRuntimeFileReader(successfulAddon('win32', bytes, {
      platform: 'win32', volumeSerial: '00112233', fileId: 'AABBCCDD'
    }), 'win32')
    expect(readRuntimeRecord('ignored', windowsReader)).toMatchObject({
      status: 'current',
      fileIdentity: { platform: 'win32', volumeSerial: '00112233', fileId: 'AABBCCDD' }
    })

    const malformedReader = createPrivateRuntimeFileReader(successfulAddon('win32', bytes, {
      platform: 'win32', volumeSerial: '', fileId: 'AABBCCDD'
    }), 'win32')
    expect(readRuntimeRecord('ignored', malformedReader)).toMatchObject({ status: 'invalid' })

    expect(() => createPrivateRuntimeFileReader(successfulAddon('darwin', bytes, {
      platform: 'posix', device: '1', inode: '2'
    }), 'win32')).toThrow(/platform mismatch/)
  })

  it('preserves missing versus unsafe private-file results', () => {
    const missing = createPrivateRuntimeFileReader({
      platform: process.platform,
      runtimeFileSecurityContractVersion: 1,
      readPrivateRuntimeFile: () => ({ ok: false, code: 'not-found', message: 'absent' })
    }, process.platform)
    const denied = createPrivateRuntimeFileReader({
      platform: process.platform,
      runtimeFileSecurityContractVersion: 1,
      readPrivateRuntimeFile: () => ({ ok: false, code: 'access-denied', message: 'denied' })
    }, process.platform)
    expect(readRuntimeRecord('missing', missing)).toEqual({ status: 'missing' })
    expect(readRuntimeRecord('unsafe', denied)).toEqual({ status: 'invalid', reason: 'denied' })
  })

  it('publishes a private locator atomically and reads it through the production native addon', () => {
    const directory = mkdtempSync(join(tmpdir(), 'runtime-record-private-'))
    const path = join(directory, 'runtime.json')
    try {
      writeRuntimeRecord(path, current)
      if (process.platform !== 'win32') {
        const descriptor = openSync(path, 'r')
        try {
          expect(readFileSync(descriptor, 'utf8')).toBe(JSON.stringify(current))
        } finally {
          closeSync(descriptor)
        }
        chmodSync(path, 0o600)
      }
      expect(readRuntimeRecord(path)).toMatchObject({ status: 'current', record: current })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
