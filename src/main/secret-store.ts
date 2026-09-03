import { safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Sentinel-secret credential store (upstream §10 sentinel-secrets, lite):
 * values encrypted at rest with the OS keychain via Electron safeStorage.
 * File: <userData>/secrets.enc.json = { [key]: base64(ciphertext) }.
 * Unavailable safeStorage (pre-key decryption, early Linux) degrades to
 * in-memory only — never plaintext on disk.
 */
export class SecretStore {
  private file: string
  private memory = new Map<string, string>()
  private encrypted: boolean

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'secrets.enc.json')
    this.encrypted = safeStorage.isEncryptionAvailable()
  }

  private readAll(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return {}
    }
  }

  private writeAll(all: Record<string, string>): void {
    if (Object.keys(all).length === 0) {
      if (existsSync(this.file)) rmSync(this.file)
      return
    }
    writeFileSync(this.file, JSON.stringify(all, null, 2), 'utf8')
  }

  set(key: string, value: string): void {
    if (!this.encrypted || !safeStorage.isEncryptionAvailable()) {
      this.memory.set(key, value)
      return
    }
    const sealed = safeStorage.encryptString(value).toString('base64')
    this.writeAll({ ...this.readAll(), [key]: sealed })
  }

  get(key: string): string | null {
    if (this.memory.has(key)) return this.memory.get(key)!
    const sealed = this.readAll()[key]
    if (!sealed) return null
    try {
      return safeStorage.decryptString(Buffer.from(sealed, 'base64'))
    } catch {
      return null
    }
  }

  delete(key: string): void {
    this.memory.delete(key)
    const all = this.readAll()
    if (key in all) {
      delete all[key]
      this.writeAll(all)
    }
  }

  /** Whether values are actually encrypted at rest (false = memory only). */
  get available(): boolean {
    return this.encrypted
  }
}
