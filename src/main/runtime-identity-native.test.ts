// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { forceTerminateProcessTree } from '@shared/child-process/process-tree-termination'
import { RuntimeOwnershipError } from '@shared/runtime-ownership'
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
  readPrivateRuntimeFileIdentity(path: string): NativePrivateFileResult
  validatePrivateRuntimeDirectory(path: string): NativePrivateFileResult
  readProcessIdentity(pid: number): NativeProcessResult
  withRuntimeAuthorityLock(path: string, callback: (stablePath: string) => unknown, readOnly?: boolean): unknown
  renameRuntimePathNoReplace(sourcePath: string, destinationPath: string): { ok: true } | { ok: false; code: 'destination-exists' | 'not-found' | 'access-denied' | 'native-error'; message: string }
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
  it('does not signal an unrelated live PID when identity fields do not match', async () => {
    const authority = runtimeIdentityAuthority()
    const first = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'], detached: process.platform !== 'win32' })
    const second = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'], detached: process.platform !== 'win32' })
    try {
      await Promise.all([waitForSpawn(first), waitForSpawn(second)])
      if (first.pid === undefined || second.pid === undefined) throw new Error('live PID fixture did not expose PIDs')
      const recorded = authority.capture(first.pid, { family: 'acp-agent', executablePath: process.execPath, generation: 'unrelated' })
      const mismatched = { ...recorded, pid: second.pid }
      expect(authority.verify(mismatched)).toMatchObject({ status: 'stale' })
      expect(second.exitCode).toBeNull()
    } finally {
      if (first.exitCode === null && first.signalCode === null) await forceTerminateProcessTree(first)
      if (second.exitCode === null && second.signalCode === null) await forceTerminateProcessTree(second)
      await Promise.all([waitForExit(first), waitForExit(second)])
    }
  })

  it('loads the current platform and identity contract version from the production addon', () => {
    const addon = createRequire(import.meta.url)(resolve(import.meta.dirname, '../../resources/native/runtime-identity.node')) as NativeAddon

    expect(addon.platform).toBe(process.platform)
    expect(addon.identityContractVersion).toBe(1)
    expect(addon.runtimeFileSecurityContractVersion).toBe(1)
    expect(typeof addon.validatePrivateRuntimeDirectory).toBe('function')
  })
  it('atomically refuses to overwrite an occupied rename destination', () => {
    const addon = createRequire(import.meta.url)(resolve(import.meta.dirname, '../../resources/native/runtime-identity.node')) as NativeAddon
    const directory = mkdtempSync(join(tmpdir(), 'runtime-no-replace-'))
    const sourcePath = join(directory, 'source')
    const destinationPath = join(directory, 'destination')
    try {
      writeFileSync(sourcePath, 'source')
      writeFileSync(destinationPath, 'destination')
      expect(addon.renameRuntimePathNoReplace(sourcePath, destinationPath)).toMatchObject({ ok: false, code: 'destination-exists' })
      expect(readFileSync(sourcePath, 'utf8')).toBe('source')
      expect(readFileSync(destinationPath, 'utf8')).toBe('destination')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it.runIf(process.platform !== 'win32')('moves the exact symlink object without dereferencing it', () => {
    const addon = createRequire(import.meta.url)(resolve(import.meta.dirname, '../../resources/native/runtime-identity.node')) as NativeAddon
    const directory = mkdtempSync(join(tmpdir(), 'runtime-no-replace-link-'))
    const sourcePath = join(directory, 'source')
    const destinationPath = join(directory, 'destination')
    try {
      symlinkSync('untrusted-target', sourcePath)
      expect(addon.renameRuntimePathNoReplace(sourcePath, destinationPath)).toEqual({ ok: true })
      expect(() => lstatSync(sourcePath)).toThrow()
      expect(lstatSync(destinationPath).isSymbolicLink()).toBe(true)
      expect(readlinkSync(destinationPath)).toBe('untrusted-target')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it.runIf(process.platform === 'linux')('links against no glibc ABI newer than Ubuntu 22.04', () => {
    const addonPath = resolve(import.meta.dirname, '../../resources/native/runtime-identity.node')
    const versions = execFileSync('readelf', ['--version-info', addonPath], { encoding: 'utf8' })
    const symbols = execFileSync('readelf', ['--dyn-syms', '--wide', addonPath], { encoding: 'utf8' })
    const required = [...versions.matchAll(/GLIBC_(\d+)\.(\d+)/g)].map((match): readonly [number, number] => [Number(match[1]), Number(match[2])])
    expect(required.some(([major, minor]) => major > 2 || (major === 2 && minor > 35))).toBe(false)
    expect(symbols).not.toContain('arc4random')
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
  it('validates a private canonical runtime directory through one native handle', () => {
    const addon = createRequire(import.meta.url)(resolve(import.meta.dirname, '../../resources/native/runtime-identity.node')) as NativeAddon
    const directory = mkdtempSync(join(tmpdir(), 'runtime-directory-native-'))
    try {
      const observation = addon.validatePrivateRuntimeDirectory(directory)
      expect(observation).toMatchObject({ ok: true, fileIdentity: { platform: process.platform === 'win32' ? 'win32' : 'posix' } })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it.runIf(process.platform !== 'win32')('rejects non-private or symlink runtime directories', () => {
    const addon = createRequire(import.meta.url)(resolve(import.meta.dirname, '../../resources/native/runtime-identity.node')) as NativeAddon
    const directory = mkdtempSync(join(tmpdir(), 'runtime-directory-native-policy-'))
    const link = directory + '-link'
    try {
      chmodSync(directory, 0o755)
      expect(addon.validatePrivateRuntimeDirectory(directory)).toMatchObject({ ok: false, code: 'native-error' })
      chmodSync(directory, 0o700)
      symlinkSync(directory, link)
      expect(addon.validatePrivateRuntimeDirectory(link)).toMatchObject({ ok: false })
    } finally {
      rmSync(link, { force: true })
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('reads authority identity without imposing the bounded locator byte limit', () => {
    const addon = createRequire(import.meta.url)(resolve(import.meta.dirname, '../../resources/native/runtime-identity.node')) as NativeAddon
    const directory = mkdtempSync(join(tmpdir(), 'runtime-identity-metadata-only-'))
    const file = join(directory, 'runtime-owners.sqlite')
    try {
      writeFileSync(file, Buffer.alloc(0), { mode: 0o600 })
      truncateSync(file, 9 * 1024 * 1024)
      expect(addon.readPrivateRuntimeFile(file, 1024)).toMatchObject({ ok: false })
      expect(addon.readPrivateRuntimeFileIdentity(file)).toMatchObject({ ok: true })
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
  it.runIf(process.platform !== 'win32')('rejects an independent canonical swap before reporting success', () => {
    const addon = createRequire(import.meta.url)(resolve(import.meta.dirname, '../../resources/native/runtime-identity.node')) as NativeAddon
    const directory = mkdtempSync(join(tmpdir(), 'runtime-authority-open-handle-'))
    const authorityPath = join(directory, 'runtime-owners.sqlite')
    const displacedPath = join(directory, 'validated.sqlite')
    writeFileSync(authorityPath, Buffer.alloc(0), { mode: 0o600 })
    try {
      expect(() => addon.withRuntimeAuthorityLock(authorityPath, () => {
        renameSync(authorityPath, displacedPath)
        writeFileSync(authorityPath, Buffer.alloc(0), { mode: 0o600 })
      })).toThrow('canonical identity changed')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('does not create authority files while taking a missing read-only lock', () => {
    const addon = createRequire(import.meta.url)(resolve(import.meta.dirname, '../../resources/native/runtime-identity.node')) as NativeAddon
    const directory = mkdtempSync(join(tmpdir(), 'runtime-authority-read-only-missing-'))
    const authorityPath = join(directory, 'runtime-owners.sqlite')
    try {
      expect(() => addon.withRuntimeAuthorityLock(authorityPath, () => undefined, true)).toThrow()
      expect(existsSync(authorityPath)).toBe(false)
      expect(readdirSync(directory)).toEqual([])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('leaves no read-only authority artifacts when a callback throws', () => {
    const addonPath = resolve(import.meta.dirname, '../../resources/native/runtime-identity.node')
    const addon = createRequire(import.meta.url)(addonPath) as NativeAddon
    const directory = mkdtempSync(join(tmpdir(), 'runtime-authority-read-only-throw-'))
    const authorityPath = join(directory, 'runtime-owners.sqlite')
    const snapshot = (): Array<[string, Buffer]> => readdirSync(directory).sort().map(name => [name, readFileSync(join(directory, name))])
    try {
      writeFileSync(authorityPath, Buffer.from('authority bytes'), { mode: 0o600 })
      addon.withRuntimeAuthorityLock(authorityPath, () => undefined)
      const before = snapshot()
      const callbackError = new Error('read-only callback failed')
      expect(() => addon.withRuntimeAuthorityLock(authorityPath, () => { throw callbackError }, true)).toThrow(callbackError)
      expect(snapshot()).toEqual(before)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('leaves no read-only authority artifacts when a lock holder is killed', async () => {
    const addonPath = resolve(import.meta.dirname, '../../resources/native/runtime-identity.node')
    const addon = createRequire(import.meta.url)(addonPath) as NativeAddon
    const directory = mkdtempSync(join(tmpdir(), 'runtime-authority-read-only-kill-'))
    const authorityPath = join(directory, 'runtime-owners.sqlite')
    const snapshot = (): Array<[string, Buffer]> => readdirSync(directory).sort().map(name => [name, readFileSync(join(directory, name))])
    let child: ReturnType<typeof spawn> | undefined
    try {
      writeFileSync(authorityPath, Buffer.from('authority bytes'), { mode: 0o600 })
      addon.withRuntimeAuthorityLock(authorityPath, () => undefined)
      const before = snapshot()
      const childScript = [
        "const addon=require(process.argv[1])",
        "const fs=require('node:fs')",
        "addon.withRuntimeAuthorityLock(process.argv[2],()=>{fs.writeSync(1,'ready\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)},true)"
      ].join(';')
      child = spawn(process.execPath, ['-e', childScript, addonPath, authorityPath], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
      child.stderr?.resume()
      const ready = Promise.withResolvers<void>()
      let announced = false
      child.stdout?.once('data', () => { announced = true; ready.resolve() })
      child.once('error', error => ready.reject(error))
      child.once('exit', code => { if (!announced) ready.reject(new Error('read-only lock child exited before callback: ' + code)) })
      await ready.promise
      expect(snapshot()).toEqual(before)
      child.kill('SIGKILL')
      await waitForExit(child)
      expect(snapshot()).toEqual(before)
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      if (child) await waitForExit(child)
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it.runIf(process.platform === 'win32')('holds the canonical read-only handle without delete sharing', () => {
    const addon = createRequire(import.meta.url)(resolve(import.meta.dirname, '../../resources/native/runtime-identity.node')) as NativeAddon
    const directory = mkdtempSync(join(tmpdir(), 'runtime-authority-read-only-windows-'))
    const authorityPath = join(directory, 'runtime-owners.sqlite')
    const displacedPath = join(directory, 'displaced.sqlite')
    try {
      writeFileSync(authorityPath, Buffer.from('authority bytes'), { mode: 0o600 })
      addon.withRuntimeAuthorityLock(authorityPath, () => undefined)
      const result = addon.withRuntimeAuthorityLock(authorityPath, () => {
        expect(() => renameSync(authorityPath, displacedPath)).toThrow()
        return addon.readPrivateRuntimeFileIdentity(authorityPath)
      }, true)
      expect(result).toMatchObject({ ok: true })
      expect(readdirSync(directory).some(name => name.includes('.donwells-alias-'))).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('serializes authority callbacks through a private canonical lock on every platform', () => {
    const addon = createRequire(import.meta.url)(resolve(import.meta.dirname, '../../resources/native/runtime-identity.node')) as NativeAddon
    const directory = mkdtempSync(join(tmpdir(), 'runtime-authority-lock-'))
    const authorityPath = join(directory, 'runtime-owners.sqlite')
    const bytes = Buffer.from('committed bytes')
    try {
      const result = addon.withRuntimeAuthorityLock(authorityPath, () => {
        writeFileSync(authorityPath, bytes, { mode: 0o600 })
        return addon.readPrivateRuntimeFileIdentity(authorityPath)
      }) as NativePrivateFileResult
      expect(result).toMatchObject({ ok: true, fileIdentity: { platform: process.platform === 'win32' ? 'win32' : 'posix' } })
      expect(readFileSync(authorityPath)).toEqual(bytes)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it.runIf(process.platform !== 'win32')('passes a native-created same-inode alias to the callback and removes it after success', () => {
    const addon = createRequire(import.meta.url)(resolve(import.meta.dirname, '../../resources/native/runtime-identity.node')) as NativeAddon
    const directory = mkdtempSync(join(tmpdir(), 'runtime-authority-alias-'))
    const authorityPath = join(directory, 'runtime-owners.sqlite')
    writeFileSync(authorityPath, Buffer.from('authority bytes'), { mode: 0o600 })
    let aliasPath = ''
    try {
      addon.withRuntimeAuthorityLock(authorityPath, (stablePath: string) => {
        aliasPath = stablePath
        expect(stablePath).not.toBe(authorityPath)
        const canonical = addon.readPrivateRuntimeFileIdentity(authorityPath)
        const alias = addon.readPrivateRuntimeFileIdentity(stablePath)
        expect(canonical).toMatchObject({ ok: true })
        expect(alias).toEqual(canonical)
        return 'alias-ok'
      })
      expect(aliasPath.length).toBeGreaterThan(0)
      expect(() => readFileSync(aliasPath)).toThrow()
      expect(() => readFileSync(aliasPath + '-wal')).toThrow()
      expect(() => readFileSync(aliasPath + '-shm')).toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it.runIf(process.platform !== 'win32')('removes the stable alias when the callback throws', () => {
    const addon = createRequire(import.meta.url)(resolve(import.meta.dirname, '../../resources/native/runtime-identity.node')) as NativeAddon
    const directory = mkdtempSync(join(tmpdir(), 'runtime-authority-alias-error-'))
    const authorityPath = join(directory, 'runtime-owners.sqlite')
    writeFileSync(authorityPath, Buffer.from('authority bytes'), { mode: 0o600 })
    try {
      const callbackError = new RuntimeOwnershipError('CALLBACK_FAILURE', 'callback failed')
      let thrown: unknown
      try {
        addon.withRuntimeAuthorityLock(authorityPath, () => { throw callbackError })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBe(callbackError)
      expect(readdirSync(directory).filter(entry => entry.includes('.donwells-alias-'))).toEqual([])
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
  it.runIf(process.platform === 'win32')('rejects generic rights and writable Users directories', () => {
    const addon = createRequire(import.meta.url)(resolve(import.meta.dirname, '../../resources/native/runtime-identity.node')) as NativeAddon
    const fixture = resolve(import.meta.dirname, '../../native/runtime-identity/build/Release/windows-private-dacl-fixture.exe')
    const directory = mkdtempSync(join(tmpdir(), 'runtime-directory-native-win-'))
    try {
      expect(execFileSync(fixture, { encoding: 'utf8' }).trim()).toBe('windows private DACL fixture passed')
      execFileSync('icacls.exe', [directory, '/grant', '*S-1-32-545:(OI)(CI)(M)'], { stdio: 'ignore' })
      expect(addon.validatePrivateRuntimeDirectory(directory)).toMatchObject({ ok: false, code: 'native-error' })
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
