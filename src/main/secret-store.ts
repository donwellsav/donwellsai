import { safeStorage } from 'electron'
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
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

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'secrets.enc.json')
  }

  private readAll(): Record<string, string> {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
    const all: unknown = JSON.parse(text)
    if (!all || typeof all !== 'object' || Array.isArray(all)) throw new Error('Invalid credential store; original file preserved')
    for (const [key, value] of Object.entries(all)) {
      this.validateKey(key)
      if (typeof value !== 'string' || !value || Buffer.from(value, 'base64').toString('base64') !== value) throw new Error('Invalid encrypted credential; original file preserved')
    }
    return all as Record<string, string>
  }

  private validateKey(key: string): void {
    if (typeof key !== 'string' || !key || key.includes('\0') || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid credential key')
  }

  private writeAll(all: Record<string, string>): void {
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`
    let descriptor: number | undefined
    try {
      descriptor = openSync(temporary, 'wx', 0o600)
      writeFileSync(descriptor, JSON.stringify(all, null, 2), 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      renameSync(temporary, this.file)
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
      rmSync(temporary, { force: true })
    }
  }

  set(key: string, value: string): void {
    this.validateKey(key)
    if (typeof value !== 'string') throw new Error('Invalid credential value')
    if (!this.available) {
      this.memory.set(key, value)
      return
    }
    const sealed = safeStorage.encryptString(value).toString('base64')
    this.writeAll({ ...this.readAll(), [key]: sealed })
    this.memory.delete(key)
  }

  get(key: string): string | null {
    this.validateKey(key)
    if (this.memory.has(key)) return this.memory.get(key)!
    if (!this.available) return null
    const sealed = this.readAll()[key]
    if (!sealed) return null
    try {
      return safeStorage.decryptString(Buffer.from(sealed, 'base64'))
    } catch {
      throw new Error('Unable to decrypt credential; original file preserved')
    }
  }

  delete(key: string): void {
    this.validateKey(key)
    const all = this.readAll()
    if (key in all) {
      delete all[key]
      this.writeAll(all)
    }
    this.memory.delete(key)
  }

  /** Whether values are actually encrypted at rest (false = memory only). */
  get available(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false
    if (process.platform !== 'linux') return true
    const backend = safeStorage.getSelectedStorageBackend()
    return backend !== 'basic_text' && backend !== 'unknown'
  }
}
