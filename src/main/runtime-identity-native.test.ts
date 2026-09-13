// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { forceTerminateProcessTree } from '@shared/child-process/process-tree-termination'
import { runtimeIdentityAuthority } from './runtime-identity'

type NativePrivateFileResult =
  | { ok: true; bytes: Buffer; fileIdentity: Record<string, string> }
  | { ok: false; code: 'not-found' | 'access-denied' | 'native-error'; message: string }

type NativeProcessResult =
  | { ok: true; pid: number; bootId: string; startedAt: string; executablePath: string }
  | { ok: false; code: 'not-found' | 'access-denied' | 'native-error'; message: string }

type NativeAddon = {
  platform: string
  identityContractVersion: number
  runtimeFileSecurityContractVersion: number
  readPrivateRuntimeFile(path: string, maxBytes: number): NativePrivateFileResult
  readProcessIdentity(pid: number): NativeProcessResult
  withRuntimeAuthority(
    path: string,
    readOnly: boolean,
    maxBytes: number,
    callback: (observation: { bytes: Buffer; fileIdentity: Record<string, string> }) => { result: unknown; append?: Buffer }
  ): unknown
}
type SpawnResult = { child: ReturnType<typeof spawn> }

async function waitForSpawn(child: ReturnType<typeof spawn>): Promise<SpawnResult> {
  const spawned = Promise.withResolvers<SpawnResult>()
  child.once('spawn', () => spawned.resolve({ child }))
  child.once('error', error => spawned.reject(error))
  return spawned.promise
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = Promise.withResolvers<void>()
  child.once('close', () => exited.resolve())
  await exited.promise
}

describe('native runtime identity adapter', () => {
  it('captures this process and a child, then proves the child is stale after termination', async () => {
    const authority = runtimeIdentityAuthority()
    const self = authority.capture(process.pid, { family: 'donwells-app', executablePath: process.execPath, generation: 'self' })
    expect(self.pid).toBe(process.pid)
    expect(authority.verify(self)).toEqual({ status: 'valid', current: self })

    const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: process.platform !== 'win32'
    })
    let childIdentity: ReturnType<typeof authority.capture> | undefined
    try {
      await waitForSpawn(child)
      if (child.pid === undefined) throw new Error('spawned child did not expose a pid')
      childIdentity = authority.capture(child.pid, { family: 'acp-agent', executablePath: process.execPath, generation: 'child' })
      expect(authority.verify(childIdentity)).toEqual({ status: 'valid', current: childIdentity })
      expect(authority.verify({ ...childIdentity, startedAt: 'altered' })).toMatchObject({ status: 'stale', reason: 'pid-reused' })
      expect(authority.verify({ ...childIdentity, executablePath: '/different/agent' })).toMatchObject({ status: 'stale', reason: 'executable-mismatch' })
      expect(await forceTerminateProcessTree(child)).toBe(true)
      await waitForExit(child)
      expect(authority.verify(childIdentity)).toEqual({ status: 'stale', reason: 'not-found' })
    } finally {
      if (child.exitCode === null && child.signalCode === null) await forceTerminateProcessTree(child)
      await waitForExit(child)
    }
  })

  it('loads the current platform and identity contract version from the production addon', () => {
    const addon = createRequire(import.meta.url)(resolve(import.meta.dirname, '../../resources/native/runtime-identity.node')) as NativeAddon

    expect(addon.platform).toBe(process.platform)
    expect(addon.identityContractVersion).toBe(1)
  })
  it('reserves not-found for a valid absent target lookup', () => {
    const addon = createRequire(import.meta.url)(resolve(import.meta.dirname, '../../resources/native/runtime-identity.node')) as NativeAddon
    expect(addon.readProcessIdentity(2_147_483_647)).toMatchObject({ ok: false, code: 'not-found' })
    expect(addon.readProcessIdentity(Number.MAX_SAFE_INTEGER)).toMatchObject({ ok: false, code: 'native-error' })
  })

  it('reads only bounded private regular files and returns stable file identity', () => {
    const addon = createRequire(import.meta.url)(resolve(import.meta.dirname, '../../resources/native/runtime-identity.node')) as NativeAddon
    const directory = mkdtempSync(join(tmpdir(), 'runtime-identity-native-'))
    const file = join(directory, 'runtime.json')
    try {
      writeFileSync(file, '{"pid":42}\n', { mode: 0o600 })
      if (process.platform !== 'win32') chmodSync(file, 0o600)
      const first = addon.readPrivateRuntimeFile(file, 1024)
      const second = addon.readPrivateRuntimeFile(file, 1024)
      expect(addon.runtimeFileSecurityContractVersion).toBe(1)
      expect(first).toMatchObject({ ok: true })
      expect(second).toMatchObject({ ok: true })
      if (!first.ok || !second.ok) throw new Error('private runtime file was unexpectedly rejected')
      expect(first.bytes.toString('utf8')).toBe('{"pid":42}\n')
      expect(first.fileIdentity).toEqual(second.fileIdentity)
      expect(Object.values(first.fileIdentity).every(value => typeof value === 'string' && value.length > 0)).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it.runIf(process.platform !== 'win32')('distinguishes same bytes at different pathname identities', () => {
    const addon = createRequire(import.meta.url)(resolve(import.meta.dirname, '../../resources/native/runtime-identity.node')) as NativeAddon
    const directory = mkdtempSync(join(tmpdir(), 'runtime-identity-same-bytes-'))
    const firstPath = join(directory, 'runtime.json')
    const secondPath = join(directory, 'replacement.json')
    const bytes = Buffer.from('same bytes\n')
    try {
      writeFileSync(firstPath, bytes, { mode: 0o600 })
      writeFileSync(secondPath, bytes, { mode: 0o600 })
      const first = addon.readPrivateRuntimeFile(firstPath, 1024)
      const second = addon.readPrivateRuntimeFile(secondPath, 1024)
      expect(first).toMatchObject({ ok: true, bytes })
      expect(second).toMatchObject({ ok: true, bytes })
      if (!first.ok || !second.ok) throw new Error('same-byte runtime files were unexpectedly rejected')
      expect(first.fileIdentity).not.toEqual(second.fileIdentity)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it.runIf(process.platform !== 'win32')('keeps authority writes on the validated open handle across pathname replacement', () => {
    const addon = createRequire(import.meta.url)(resolve(import.meta.dirname, '../../resources/native/runtime-identity.node')) as NativeAddon
    const directory = mkdtempSync(join(tmpdir(), 'runtime-authority-open-handle-'))
    const authorityPath = join(directory, 'runtime-owners.sqlite')
    const displacedPath = join(directory, 'validated.sqlite')
    const attackerBytes = Buffer.from('attacker authority')
    const trustedBytes = Buffer.from('trusted authority')
    writeFileSync(authorityPath, Buffer.alloc(0), { mode: 0o600 })
    try {
      const result = addon.withRuntimeAuthority(authorityPath, false, 1024, observation => {
        renameSync(authorityPath, displacedPath)
        writeFileSync(authorityPath, attackerBytes, { mode: 0o600 })
        return { result: observation.fileIdentity, append: trustedBytes }
      })
      expect(result).toMatchObject({ platform: 'posix' })
      expect(readFileSync(displacedPath)).toEqual(trustedBytes)
      expect(readFileSync(authorityPath)).toEqual(attackerBytes)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform !== 'win32')('rejects group/world-readable and symlink runtime files', () => {
    const addon = createRequire(import.meta.url)(resolve(import.meta.dirname, '../../resources/native/runtime-identity.node')) as NativeAddon
    const directory = mkdtempSync(join(tmpdir(), 'runtime-identity-native-'))
    const file = join(directory, 'runtime.json')
    const link = join(directory, 'runtime-link.json')
    try {
      writeFileSync(file, 'secret', { mode: 0o600 })
      chmodSync(file, 0o644)
      expect(addon.readPrivateRuntimeFile(file, 1024)).toMatchObject({ ok: false, code: 'native-error' })
      chmodSync(file, 0o600)
      symlinkSync(file, link)
      expect(addon.readPrivateRuntimeFile(link, 1024)).toMatchObject({ ok: false, code: 'native-error' })
      expect(addon.readPrivateRuntimeFile(directory, 1024)).toMatchObject({ ok: false, code: 'native-error' })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'win32')('rejects a directory and a file readable by Everyone', () => {
    const addon = createRequire(import.meta.url)(resolve(import.meta.dirname, '../../resources/native/runtime-identity.node')) as NativeAddon
    const directory = mkdtempSync(join(tmpdir(), 'runtime-identity-native-win-'))
    const file = join(directory, 'runtime.json')
    try {
      writeFileSync(file, 'secret', { mode: 0o600 })
      expect(addon.readPrivateRuntimeFile(directory, 1024)).toMatchObject({ ok: false, code: 'native-error' })
      execFileSync('icacls.exe', [file, '/grant', '*S-1-1-0:(R)'], { stdio: 'ignore' })
      expect(addon.readPrivateRuntimeFile(file, 1024)).toMatchObject({ ok: false, code: 'native-error' })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('rejects runtime files exceeding the caller limit', () => {
    const addon = createRequire(import.meta.url)(resolve(import.meta.dirname, '../../resources/native/runtime-identity.node')) as NativeAddon
    const directory = mkdtempSync(join(tmpdir(), 'runtime-identity-native-'))
    const file = join(directory, 'runtime.json')
    try {
      writeFileSync(file, 'too-large', { mode: 0o600 })
      if (process.platform !== 'win32') chmodSync(file, 0o600)
      expect(addon.readPrivateRuntimeFile(file, 4)).toMatchObject({ ok: false, code: 'native-error' })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
