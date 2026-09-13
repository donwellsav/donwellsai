// @vitest-environment node
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { forceTerminateProcessTree } from '@shared/child-process/process-tree-termination'
import { runtimeIdentityAuthority } from './runtime-identity'

type NativeAddon = {
  platform: string
  identityContractVersion: number
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
})
