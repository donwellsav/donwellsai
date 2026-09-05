import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { SecretStore } from '../src/main/secret-store'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => 'basic_text'),
    encryptString: vi.fn((value: string) => Buffer.from(`sealed:${value}`)),
    decryptString: vi.fn((value: Buffer) => value.toString().slice(7))
  }
}))

let directory: string
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'donwells-secrets-'))
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
  vi.mocked(safeStorage.getSelectedStorageBackend).mockReturnValue('basic_text')
})

afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor)
  rmSync(directory, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('protected secret storage', () => {
  it('keeps secrets in memory when Linux only offers basic_text', () => {
    const secrets = new SecretStore(directory)
    secrets.set('provider', 'fixture-secret')
    expect(secrets.available).toBe(false)
    expect(secrets.get('provider')).toBe('fixture-secret')
    expect(existsSync(join(directory, 'secrets.enc.json'))).toBe(false)
    expect(new SecretStore(directory).get('provider')).toBeNull()
  })

  it('replaces a memory-only value after a protected keyring becomes available', () => {
    const secrets = new SecretStore(directory)
    secrets.set('provider', 'old-fixture')
    vi.mocked(safeStorage.getSelectedStorageBackend).mockReturnValue('gnome_libsecret')
    secrets.set('provider', 'new-fixture')
    expect(secrets.available).toBe(true)
    expect(secrets.get('provider')).toBe('new-fixture')
    expect(new SecretStore(directory).get('provider')).toBe('new-fixture')
    expect(readFileSync(join(directory, 'secrets.enc.json'), 'utf8')).not.toContain('new-fixture')
  })
})
