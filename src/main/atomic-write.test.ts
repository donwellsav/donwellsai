import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { atomicWriteFileSync } from './atomic-write'

// Injects a failure at the exact point where the temporary file exists, is open,
// and its bytes are being written. Everything else stays the real filesystem.
const injected = vi.hoisted(() => ({ failWrite: false }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync: (file: Parameters<typeof actual.writeFileSync>[0], data: Parameters<typeof actual.writeFileSync>[1], options?: Parameters<typeof actual.writeFileSync>[2]): void => {
      if (injected.failWrite) throw new Error('injected write failure')
      actual.writeFileSync(file, data, options)
    }
  }
})

const posix = process.platform !== 'win32'

function temporaryFiles(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.endsWith('.tmp'))
}

describe('atomicWriteFileSync', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'atomic-write-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('writes the exact bytes and creates the destination directory owner-only', () => {
    const target = join(root, 'nested', 'deeper', 'document.json')
    atomicWriteFileSync(target, '{"schemaVersion":1}\n', { createDirectoryMode: 0o700 })

    expect(readFileSync(target, 'utf8')).toBe('{"schemaVersion":1}\n')
    expect(temporaryFiles(join(root, 'nested', 'deeper'))).toEqual([])
    if (posix) {
      expect(statSync(target).mode & 0o777).toBe(0o600)
      expect(statSync(join(root, 'nested', 'deeper')).mode & 0o777).toBe(0o700)
    }
  })

  it('writes binary bytes without an encoding round trip', () => {
    const target = join(root, 'document.bin')
    const bytes = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x7b])
    atomicWriteFileSync(target, bytes)

    expect(Array.from(readFileSync(target))).toEqual(Array.from(bytes))
    expect(temporaryFiles(root)).toEqual([])
  })

  it('replaces an existing file atomically and leaves no temporary file behind', () => {
    const target = join(root, 'document.json')
    atomicWriteFileSync(target, '{"revision":1}\n')
    expect(readFileSync(target, 'utf8')).toBe('{"revision":1}\n')

    const reader = posix ? openSync(target, 'r') : undefined
    try {
      atomicWriteFileSync(target, '{"revision":2}\n')
      expect(readFileSync(target, 'utf8')).toBe('{"revision":2}\n')
      if (reader !== undefined) {
        // The superseded revision keeps its own bytes: the new revision was
        // published by rename, never by truncating the file in place.
        expect(readFileSync(reader, 'utf8')).toBe('{"revision":1}\n')
      }
    } finally {
      if (reader !== undefined) closeSync(reader)
    }

    expect(readdirSync(root)).toEqual(['document.json'])
  })

  it('leaves no partial destination and no temporary file when publication fails', () => {
    const target = join(root, 'occupied.json')
    mkdirSync(target)

    expect(() => atomicWriteFileSync(target, 'payload')).toThrow()

    expect(statSync(target).isDirectory()).toBe(true)
    expect(readdirSync(root)).toEqual(['occupied.json'])
  })

  it('leaves no partial destination when the write itself fails mid-sequence', () => {
    const target = join(root, 'document.json')
    injected.failWrite = true
    try {
      expect(() => atomicWriteFileSync(target, 'partial')).toThrow('injected write failure')
    } finally {
      injected.failWrite = false
    }

    expect(existsSync(target)).toBe(false)
    expect(readdirSync(root)).toEqual([])
  })

  it('does not create the destination directory unless asked', () => {
    const target = join(root, 'missing', 'document.json')

    expect(() => atomicWriteFileSync(target, 'payload')).toThrow()

    expect(existsSync(join(root, 'missing'))).toBe(false)
    expect(readdirSync(root)).toEqual([])
  })

  it('propagates a failing before-write hook without touching the destination', () => {
    const target = join(root, 'document.json')
    writeFileSync(target, 'previous')

    expect(() => atomicWriteFileSync(target, 'next', {
      beforeWrite: () => {
        throw new Error('directory validation failed')
      }
    })).toThrow('directory validation failed')

    expect(readFileSync(target, 'utf8')).toBe('previous')
    expect(readdirSync(root)).toEqual(['document.json'])
  })

  it('runs the before-write hook once, before the temporary file exists', () => {
    const target = join(root, 'document.json')
    const observed: string[][] = []

    atomicWriteFileSync(target, 'body', {
      beforeWrite: () => {
        observed.push(readdirSync(root))
      }
    })

    expect(observed).toHaveLength(1)
    expect(observed[0]).toEqual([])
    expect(readFileSync(target, 'utf8')).toBe('body')
  })

  it.runIf(posix)('enforces the exact owner-only mode after publication when asked', () => {
    const previousUmask = process.umask(0o277)
    try {
      const narrowed = join(root, 'narrowed.json')
      atomicWriteFileSync(narrowed, 'body')
      expect(statSync(narrowed).mode & 0o777).toBe(0o400)

      const enforced = join(root, 'enforced.json')
      atomicWriteFileSync(enforced, 'body', { enforceModeAfterPublish: true })
      expect(statSync(enforced).mode & 0o777).toBe(0o600)
    } finally {
      process.umask(previousUmask)
    }
  })
})
