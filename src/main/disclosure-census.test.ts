// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { assertNoDisclosure } from './test-utils/disclosure-census'

it('fails the census when a disposable profile contains a plaintext credential', () => {
  const directory = mkdtempSync(join(tmpdir(), 'disclosure-control-'))
  const marker = 'disposable-credential-positive-control'
  try {
    writeFileSync(join(directory, 'seeded-auth.json'), marker)
    assertNoDisclosure(directory, [marker], ['seeded-auth.json'])
    writeFileSync(join(directory, 'credential.txt'), marker)
    expect(() => assertNoDisclosure(directory, [marker], ['seeded-auth.json'])).toThrow('Credential disclosure in credential.txt')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
