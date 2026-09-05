import { createHash, randomBytes } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, opendir, readdir, realpath, rename, rmdir, stat, unlink } from 'node:fs/promises'
import { dirname, extname, isAbsolute, posix, relative, resolve, sep } from 'node:path'
import { MAX_DIRECTORY_ENTRIES, MAX_FILE_SEARCH_CANDIDATES, type WorkspaceCreateRequest, type WorkspaceDeleteRequest, type WorkspaceDirectoryRequest, type WorkspaceDirectoryResult, type WorkspaceDuplicateRequest, type WorkspaceFileSearchRequest, type WorkspaceFileSearchResult, type WorkspaceMoveRequest, type WorkspaceMutationResult } from '@shared/file-workspace'
import { rankWorkspaceFiles } from '@shared/file-search'
import type { FileContent, FileEntry } from '@shared/types'

export const PREVIEW_BYTE_LIMIT = 512 * 1024
export const WRITE_BYTE_LIMIT = 2 * 1024 * 1024
const IMAGE_BYTE_LIMIT = 8 * 1024 * 1024
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0
const REVISION_PATTERN = /^sha256:[a-f0-9]{64}$/

const BINARY_SCAN_CHUNK_BYTES = 64 * 1024

type Utf8ValidationState = {
  remaining: number
  nextMin: number
  nextMax: number
  pendingBytes: number
}

/** Validate UTF-8 without decoding or copying; NUL marks content as unsupported text. */
function consumeSupportedTextBytes(bytes: Uint8Array, state: Utf8ValidationState): boolean {
  for (const byte of bytes) {
    if (state.remaining > 0) {
      if (byte < state.nextMin || byte > state.nextMax) return false
      state.remaining -= 1
      state.pendingBytes += 1
      state.nextMin = 0x80
      state.nextMax = 0xbf
      if (state.remaining === 0) state.pendingBytes = 0
      continue
    }
    if (byte === 0) return false
    if (byte <= 0x7f) continue
    state.pendingBytes = 1
    if (byte >= 0xc2 && byte <= 0xdf) {
      state.remaining = 1
      state.nextMin = 0x80
      state.nextMax = 0xbf
    } else if (byte === 0xe0) {
      state.remaining = 2
      state.nextMin = 0xa0
      state.nextMax = 0xbf
    } else if ((byte >= 0xe1 && byte <= 0xec) || (byte >= 0xee && byte <= 0xef)) {
      state.remaining = 2
      state.nextMin = 0x80
      state.nextMax = 0xbf
    } else if (byte === 0xed) {
      state.remaining = 2
      state.nextMin = 0x80
      state.nextMax = 0x9f
    } else if (byte === 0xf0) {
      state.remaining = 3
      state.nextMin = 0x90
      state.nextMax = 0xbf
    } else if (byte >= 0xf1 && byte <= 0xf3) {
      state.remaining = 3
      state.nextMin = 0x80
      state.nextMax = 0xbf
    } else if (byte === 0xf4) {
      state.remaining = 3
      state.nextMin = 0x80
      state.nextMax = 0x8f
    } else {
      return false
    }
  }
  return true
}

export class WorktreeFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorktreeFileError'
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Validate a portable worktree-relative path before it reaches either git or the filesystem. */
export function validateRelativePath(relPath: string, allowEmpty = false): string {
  if (typeof relPath !== 'string' || /[\u0000-\u001f\u007f]/.test(relPath)) throw new WorktreeFileError(`Invalid path: ${String(relPath)}`)
  if (!allowEmpty && relPath.length === 0) throw new WorktreeFileError('Invalid empty path')
  if (
    relPath.startsWith('/') ||
    relPath.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(relPath) ||
    relPath.includes('\\') ||
    relPath.split('/').some((part) => part === '..' || part === '.' || (part === '' && relPath !== ''))
  ) {
    throw new WorktreeFileError(`Path escapes worktree: ${relPath}`)
  }
  if (relPath.endsWith('/')) throw new WorktreeFileError(`Invalid path: ${relPath}`)
  return relPath
}

async function realDirectory(path: string, root: string, label: string): Promise<string> {
  let real: string
  try {
    real = await realpath(path)
  } catch {
    throw new WorktreeFileError(`No such directory for: ${label}`)
  }
  if (!isInside(root, real)) throw new WorktreeFileError(`Path escapes worktree: ${label}`)
  const info = await stat(real)
  if (!info.isDirectory()) throw new WorktreeFileError(`${label || '.'} is not a directory`)
  return real
}

export async function resolveExistingFile(root: string, relPath: string): Promise<string> {
  validateRelativePath(relPath)
  const abs = resolve(root, relPath)
  if (!isInside(root, abs)) throw new WorktreeFileError(`Path escapes worktree: ${relPath}`)

  let resolved: string
  try {
    const direct = await lstat(abs)
    if (direct.isSymbolicLink()) throw new WorktreeFileError(`Path escapes worktree: ${relPath}`)
    if (!direct.isFile()) throw new WorktreeFileError(`${relPath} is not a regular file`)
    resolved = await realpath(abs)
  } catch (error) {
    if (error instanceof WorktreeFileError) throw error
    throw new WorktreeFileError(`No such file: ${relPath}`)
  }
  if (!isInside(root, resolved)) throw new WorktreeFileError(`Path escapes worktree: ${relPath}`)
  return abs
}

async function resolveWriteTarget(root: string, relPath: string): Promise<{ abs: string; parent: string }> {
  validateRelativePath(relPath)
  const abs = resolve(root, relPath)
  if (!isInside(root, abs)) throw new WorktreeFileError(`Path escapes worktree: ${relPath}`)
  const parent = await realDirectory(dirname(abs), root, relPath)
  if (parent !== dirname(abs)) throw new WorktreeFileError(`Path escapes worktree: ${relPath}`)
  return { abs, parent }
}

export async function assertPathMatchesDescriptor(abs: string, root: string, descriptorStat: Stats, relPath: string): Promise<void> {
  const resolved = await realpath(abs)
  if (!isInside(root, resolved)) throw new WorktreeFileError(`Path escapes worktree: ${relPath}`)
  const pathStat = await stat(resolved)
  if (pathStat.dev !== descriptorStat.dev || pathStat.ino !== descriptorStat.ino) {
    throw new WorktreeFileError(`File changed while opening: ${relPath}`)
  }
}

async function readBoundedDescriptor(
  abs: string,
  root: string,
  relPath: string,
  limit: number
): Promise<{ bytes: Buffer; size: number; stable: boolean }> {
  const handle = await open(abs, constants.O_RDONLY | NO_FOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new WorktreeFileError(`${relPath} is not a regular file`)
    await assertPathMatchesDescriptor(abs, root, before, relPath)

    const output = Buffer.allocUnsafe(limit + 1)
    let used = 0
    while (used < output.length) {
      const { bytesRead } = await handle.read(output, used, output.length - used, used)
      if (bytesRead === 0) break
      used += bytesRead
    }
    const after = await handle.stat()
    const stable =
      before.dev === after.dev &&
      before.ino === after.ino &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      before.ctimeMs === after.ctimeMs &&
      used === Math.min(after.size, limit + 1)
    return { bytes: output.subarray(0, used), size: after.size, stable }
  } finally {
    await handle.close()
  }
}

function revisionOf(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

async function readCurrentRevision(root: string, abs: string, relPath: string): Promise<string> {
  await resolveExistingFile(root, relPath)
  const snapshot = await readBoundedDescriptor(abs, root, relPath, PREVIEW_BYTE_LIMIT)
  if (snapshot.size > PREVIEW_BYTE_LIMIT || snapshot.bytes.length > PREVIEW_BYTE_LIMIT) {
    throw new WorktreeFileError(`Write conflict: ${relPath} was read as a partial or truncated file`)
  }
  if (!snapshot.stable || snapshot.bytes.length !== snapshot.size) {
    throw new WorktreeFileError(`Write conflict: ${relPath} changed while it was being read`)
  }
  const validation: Utf8ValidationState = { remaining: 0, nextMin: 0x80, nextMax: 0xbf, pendingBytes: 0 }
  if (!consumeSupportedTextBytes(snapshot.bytes, validation) || validation.remaining !== 0) {
    throw new WorktreeFileError(`Refusing to overwrite binary or unsupported text file: ${relPath}`)
  }
  return revisionOf(snapshot.bytes)
}

async function assertExistingTextFile(root: string, abs: string, relPath: string): Promise<void> {
  const handle = await open(abs, constants.O_RDONLY | NO_FOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new WorktreeFileError(`${relPath} is not a regular file`)
    await assertPathMatchesDescriptor(abs, root, before, relPath)
    const validation: Utf8ValidationState = { remaining: 0, nextMin: 0x80, nextMax: 0xbf, pendingBytes: 0 }
    const buffer = Buffer.allocUnsafe(BINARY_SCAN_CHUNK_BYTES)
    let position = 0
    while (position < before.size) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      if (!consumeSupportedTextBytes(buffer.subarray(0, bytesRead), validation)) {
        throw new WorktreeFileError(`Refusing to overwrite binary or unsupported text file: ${relPath}`)
      }
      position += bytesRead
    }
    const after = await handle.stat()
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || position !== after.size
    ) {
      throw new WorktreeFileError(`Write conflict: ${relPath} changed while it was being checked`)
    }
    if (validation.remaining !== 0) {
      throw new WorktreeFileError(`Refusing to overwrite binary or unsupported text file: ${relPath}`)
    }
  } finally {
    await handle.close()
  }
}

function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp' && ['avif', 'avis'].includes(bytes.subarray(8, 12).toString('ascii'))) return 'image/avif'
  if (bytes.length >= 2 && bytes.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp'
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return 'image/x-icon'
  if (!bytes.includes(0)) {
    const head = bytes.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '')
    if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[^]*?-->\s*)*(?:<!doctype\s+svg[^>]*>\s*)?<svg\b/i.test(head)) return 'image/svg+xml'
  }
  return null
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
}

type ResolvedEntry = {
  abs: string
  relPath: string
  kind: 'file' | 'dir'
  identity: Stats
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function resolveExistingEntry(root: string, relPath: string): Promise<ResolvedEntry> {
  const normalized = validateRelativePath(relPath)
  const abs = resolve(root, normalized)
  if (!isInside(root, abs)) throw new WorktreeFileError('Path escapes worktree: ' + relPath)
  try {
    const direct = await lstat(abs)
    if (direct.isSymbolicLink()) throw new WorktreeFileError('Refusing symbolic link: ' + relPath)
    if (!direct.isFile() && !direct.isDirectory()) throw new WorktreeFileError('Unsupported workspace entry: ' + relPath)
    const resolved = await realpath(abs)
    if (!isInside(root, resolved)) throw new WorktreeFileError('Path escapes worktree: ' + relPath)
    const resolvedStat = await stat(resolved)
    if (!sameIdentity(direct, resolvedStat)) throw new WorktreeFileError('Entry changed while opening: ' + relPath)
    return { abs, relPath: normalized, kind: direct.isDirectory() ? 'dir' : 'file', identity: direct }
  } catch (error) {
    if (error instanceof WorktreeFileError) throw error
    throw new WorktreeFileError('No such workspace entry: ' + relPath)
  }
}

async function assertEntryIdentity(root: string, entry: ResolvedEntry): Promise<void> {
  const current = await lstat(entry.abs).catch(() => null)
  if (!current || current.isSymbolicLink() || !sameIdentity(current, entry.identity)) {
    throw new WorktreeFileError('Workspace entry changed during operation: ' + entry.relPath)
  }
  const resolved = await realpath(entry.abs)
  if (!isInside(root, resolved)) throw new WorktreeFileError('Path escapes worktree: ' + entry.relPath)
}

async function assertDestinationAvailable(root: string, relPath: string): Promise<{ abs: string; parent: string }> {
  const target = await resolveWriteTarget(root, relPath)
  const existing = await lstat(target.abs).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing) throw new WorktreeFileError('Destination already exists: ' + relPath)
  return target
}

async function copyRegularFile(root: string, source: ResolvedEntry, destinationPath: string): Promise<ResolvedEntry> {
  const target = await assertDestinationAvailable(root, destinationPath)
  const sourceHandle = await open(source.abs, constants.O_RDONLY | NO_FOLLOW)
  let destinationHandle: Awaited<ReturnType<typeof open>> | null = null
  let destinationIdentity: Stats | null = null
  try {
    const before = await sourceHandle.stat()
    if (!before.isFile() || !sameIdentity(before, source.identity)) throw new WorktreeFileError('Source changed before copy: ' + source.relPath)
    await assertPathMatchesDescriptor(source.abs, root, before, source.relPath)
    destinationHandle = await open(target.abs, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, before.mode)
    destinationIdentity = await destinationHandle.stat()
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let position = 0
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      let written = 0
      while (written < bytesRead) {
        const result = await destinationHandle.write(buffer, written, bytesRead - written, position + written)
        written += result.bytesWritten
      }
      position += bytesRead
    }
    await destinationHandle.sync()
    await destinationHandle.chmod(before.mode)
    const after = await sourceHandle.stat()
    if (!sameIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new WorktreeFileError('Source changed during copy: ' + source.relPath)
    }
    await assertPathMatchesDescriptor(source.abs, root, after, source.relPath)
    const parent = await realpath(dirname(target.abs))
    if (parent !== target.parent || !isInside(root, parent)) throw new WorktreeFileError('Destination changed during copy: ' + destinationPath)
    return { abs: target.abs, relPath: destinationPath, kind: 'file', identity: destinationIdentity }
  } catch (error) {
    if (destinationHandle) await destinationHandle.close().catch(() => undefined)
    destinationHandle = null
    if (destinationIdentity) {
      const current = await lstat(target.abs).catch(() => null)
      const resolved = current ? await realpath(target.abs).catch(() => null) : null
      if (current && resolved && sameIdentity(current, destinationIdentity) && isInside(root, resolved)) {
        await unlink(target.abs).catch(() => undefined)
      }
    }
    throw error
  } finally {
    await sourceHandle.close()
    if (destinationHandle) await destinationHandle.close()
  }
}

async function removeEntryTree(root: string, entry: ResolvedEntry): Promise<void> {
  await assertEntryIdentity(root, entry)
  if (entry.kind === 'file') {
    await unlink(entry.abs)
    return
  }
  const children = await readdir(entry.abs, { withFileTypes: true })
  await assertEntryIdentity(root, entry)
  for (const child of children) {
    const childRelPath = posix.join(entry.relPath, child.name)
    const childPath = resolve(root, childRelPath)
    const childStat = await lstat(childPath)
    if (childStat.isSymbolicLink()) {
      await unlink(childPath)
      continue
    }
    if (!childStat.isFile() && !childStat.isDirectory()) throw new WorktreeFileError('Unsupported workspace entry: ' + childRelPath)
    await removeEntryTree(root, {
      abs: childPath,
      relPath: childRelPath,
      kind: childStat.isDirectory() ? 'dir' : 'file',
      identity: childStat
    })
  }
  await assertEntryIdentity(root, entry)
  await rmdir(entry.abs)
}

async function copyEntryTree(root: string, source: ResolvedEntry, destinationPath: string): Promise<ResolvedEntry> {
  if (source.kind === 'file') return copyRegularFile(root, source, destinationPath)
  const target = await assertDestinationAvailable(root, destinationPath)
  await mkdir(target.abs, { mode: source.identity.mode })
  const destinationIdentity = await lstat(target.abs)
  const destination: ResolvedEntry = { abs: target.abs, relPath: destinationPath, kind: 'dir', identity: destinationIdentity }
  try {
    const children = await readdir(source.abs, { withFileTypes: true })
    await assertEntryIdentity(root, source)
    for (const child of children) {
      const childSourcePath = posix.join(source.relPath, child.name)
      const childStat = await lstat(resolve(root, childSourcePath))
      if (childStat.isSymbolicLink()) throw new WorktreeFileError('Refusing to duplicate a directory containing symbolic links: ' + childSourcePath)
      if (!childStat.isFile() && !childStat.isDirectory()) throw new WorktreeFileError('Unsupported workspace entry: ' + childSourcePath)
      const childSource: ResolvedEntry = {
        abs: resolve(root, childSourcePath),
        relPath: childSourcePath,
        kind: childStat.isDirectory() ? 'dir' : 'file',
        identity: childStat
      }
      await copyEntryTree(root, childSource, posix.join(destinationPath, child.name))
    }
    await assertEntryIdentity(root, source)
    await assertEntryIdentity(root, destination)
    return destination
  } catch (error) {
    await removeEntryTree(root, destination).catch(() => undefined)
    throw error
  }
}

export class WorktreeFiles {
  private readonly operations = new Map<string, Promise<unknown>>()

  private async runExclusive<T>(root: string, task: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(root) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(task)
    this.operations.set(root, operation)
    try {
      return await operation
    } finally {
      if (this.operations.get(root) === operation) this.operations.delete(root)
    }
  }

  async resolveDirectory(root: string, prefix: string): Promise<string> {
    validateRelativePath(prefix, true)
    if (prefix.startsWith(':')) throw new WorktreeFileError(`Invalid path prefix: ${prefix}`)
    return realDirectory(resolve(root, prefix || '.'), root, prefix)
  }
  async listDirectory(root: string, prefix: string): Promise<{ name: string; type: 'dir' | 'file' }[]> {
    const directory = await this.resolveDirectory(root, prefix)
    const entries: { name: string; type: 'dir' | 'file' }[] = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue
      entries.push({ name: entry.name, type: entry.isDirectory() ? 'dir' : 'file' })
    }
    return entries
  }

  async listWorkspaceDirectory(root: string, request: WorkspaceDirectoryRequest): Promise<WorkspaceDirectoryResult> {
    if (!request || typeof request.directory !== 'string' || typeof request.showHidden !== 'boolean' || typeof request.includeIgnored !== 'boolean') {
      throw new WorktreeFileError('Invalid workspace directory request')
    }
    const directoryPath = validateRelativePath(request.directory, true)
    const directory = await this.resolveDirectory(root, directoryPath)
    const entries: FileEntry[] = []
    let truncated = false
    const handle = await opendir(directory)
    try {
      for await (const entry of handle) {
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue
        if (!request.showHidden && entry.name.startsWith('.')) continue
        if (!request.includeIgnored && (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.DS_Store')) continue
        if (entries.length >= MAX_DIRECTORY_ENTRIES) {
          truncated = true
          break
        }
        const path = directoryPath ? posix.join(directoryPath, entry.name) : entry.name
        entries.push({ path, name: entry.name, type: entry.isDirectory() ? 'dir' : 'file' })
      }
    } finally {
      await handle.close().catch(() => undefined)
    }
    entries.sort((left, right) => left.type === right.type ? left.name.localeCompare(right.name) : left.type === 'dir' ? -1 : 1)
    return { directory: directoryPath, entries, truncated }
  }

  async searchWorkspaceFiles(root: string, request: WorkspaceFileSearchRequest): Promise<WorkspaceFileSearchResult> {
    if (!request || typeof request.query !== 'string' || typeof request.showHidden !== 'boolean' || typeof request.includeIgnored !== 'boolean') {
      throw new WorktreeFileError('Invalid workspace file search request')
    }
    const rootDirectory = await this.resolveDirectory(root, '')
    const directories = ['']
    const candidates: FileEntry[] = []
    let traversalTruncated = false
    for (let index = 0; index < directories.length; index += 1) {
      if (candidates.length >= MAX_FILE_SEARCH_CANDIDATES || directories.length >= MAX_FILE_SEARCH_CANDIDATES) {
        traversalTruncated = true
        break
      }
      const directoryPath = directories[index]!
      const absoluteDirectory = directoryPath ? resolve(rootDirectory, directoryPath) : rootDirectory
      const real = await realDirectory(absoluteDirectory, rootDirectory, directoryPath)
      const handle = await opendir(real)
      try {
        for await (const entry of handle) {
          if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue
          if (!request.showHidden && entry.name.startsWith('.')) continue
          if (!request.includeIgnored && (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.DS_Store')) continue
          const relPath = directoryPath ? posix.join(directoryPath, entry.name) : entry.name
          if (entry.isDirectory()) directories.push(relPath)
          else candidates.push({ path: relPath, name: entry.name, type: 'file' })
          if (candidates.length >= MAX_FILE_SEARCH_CANDIDATES || directories.length >= MAX_FILE_SEARCH_CANDIDATES) {
            traversalTruncated = true
            break
          }
        }
      } finally {
        await handle.close().catch(() => undefined)
      }
    }
    const result = rankWorkspaceFiles(candidates, request)
    return traversalTruncated ? { ...result, truncated: true } : result
  }

  async isSafeListedPath(root: string, relPath: string): Promise<boolean> {
    try {
      validateRelativePath(relPath)
      const abs = resolve(root, relPath)
      if (!isInside(root, abs)) return false
      try {
        const info = await lstat(abs)
        if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) return false
        const resolved = await realpath(abs)
        return isInside(root, resolved)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
        await realDirectory(dirname(abs), root, relPath)
        return true
      }
    } catch {
      return false
    }
  }

  async readFile(root: string, relPath: string): Promise<FileContent> {
    const abs = await resolveExistingFile(root, relPath)
    const snapshot = await readBoundedDescriptor(abs, root, relPath, PREVIEW_BYTE_LIMIT)
    const truncated = snapshot.size > PREVIEW_BYTE_LIMIT || snapshot.bytes.length > PREVIEW_BYTE_LIMIT
    const visible = snapshot.bytes.subarray(0, PREVIEW_BYTE_LIMIT)
    const validation: Utf8ValidationState = { remaining: 0, nextMin: 0x80, nextMax: 0xbf, pendingBytes: 0 }
    let supported = consumeSupportedTextBytes(visible, validation)
    const visibleTextBytes = visible.length - validation.pendingBytes
    if (supported && snapshot.bytes.length > visible.length) {
      supported = consumeSupportedTextBytes(snapshot.bytes.subarray(visible.length), validation)
    }
    const binary = !supported || (!truncated && validation.remaining !== 0)
    if (binary) {
      return { path: relPath, content: '', truncated, bytes: snapshot.size, binary: true }
    }
    const complete = !truncated && snapshot.stable && visible.length === snapshot.size
    return {
      path: relPath,
      content: visible.subarray(0, visibleTextBytes).toString('utf8'),
      truncated,
      bytes: snapshot.size,
      ...(complete ? { revision: revisionOf(visible) } : {})
    }
  }

  async writeFile(root: string, relPath: string, content: string, expectedRevision?: string): Promise<FileContent> {
    const normalized = validateRelativePath(relPath)
    return this.runExclusive(root, () => this.writeFileNow(root, normalized, content, expectedRevision))
  }

  private async writeFileNow(root: string, relPath: string, content: string, expectedRevision?: string): Promise<FileContent> {
    const bytes = Buffer.from(content, 'utf8')
    if (bytes.length > WRITE_BYTE_LIMIT) throw new WorktreeFileError('File content exceeds 2 MiB write cap')
    if (expectedRevision !== undefined && !REVISION_PATTERN.test(expectedRevision)) {
      throw new WorktreeFileError(`Write conflict: ${relPath} has no valid full-file revision`)
    }

    const { abs, parent } = await resolveWriteTarget(root, relPath)
    let existingMode: number | undefined
    try {
      const info = await lstat(abs)
      if (info.isSymbolicLink()) throw new WorktreeFileError(`Path escapes worktree: ${relPath}`)
      if (!info.isFile()) throw new WorktreeFileError(`${relPath} is not a regular file`)
      existingMode = info.mode
    } catch (error) {
      if (error instanceof WorktreeFileError) throw error
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw error
      if (expectedRevision !== undefined) throw new WorktreeFileError(`Write conflict: ${relPath} no longer exists`)
    }

    if (existingMode !== undefined && expectedRevision === undefined) {
      await assertExistingTextFile(root, abs, relPath)
    }

    if (expectedRevision !== undefined) {
      const actual = await readCurrentRevision(root, abs, relPath)
      if (actual !== expectedRevision) throw new WorktreeFileError(`Write conflict: ${relPath} changed on disk; reload before saving`)
    }

    const temp = resolve(parent, `.${relPath.split('/').pop()}.donwells-${process.pid}-${randomBytes(8).toString('hex')}.tmp`)
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, existingMode ?? 0o666)
    let renamed = false
    try {
      const descriptorStat = await handle.stat()
      if (!descriptorStat.isFile()) throw new WorktreeFileError(`Cannot create regular file for: ${relPath}`)
      await handle.writeFile(bytes)
      await handle.sync()
      if (existingMode !== undefined) await handle.chmod(existingMode)

      if (expectedRevision !== undefined) {
        const actual = await readCurrentRevision(root, abs, relPath)
        if (actual !== expectedRevision) throw new WorktreeFileError(`Write conflict: ${relPath} changed on disk while saving; reload before saving`)
      }
      const currentParent = await realpath(dirname(abs))
      if (currentParent !== parent || !isInside(root, currentParent)) throw new WorktreeFileError(`Path escapes worktree: ${relPath}`)
      await rename(temp, abs)
      renamed = true
    } finally {
      await handle.close()
      if (!renamed) await unlink(temp).catch(() => undefined)
    }

    return { path: relPath, content, truncated: false, bytes: bytes.length, revision: revisionOf(bytes) }
  }

  async createWorkspaceEntry(root: string, request: WorkspaceCreateRequest): Promise<WorkspaceMutationResult> {
    if (!request || (request.kind !== 'file' && request.kind !== 'dir')) throw new WorktreeFileError('Invalid workspace entry kind')
    const relPath = validateRelativePath(request.path)
    if (request.kind === 'dir' && request.content !== undefined) throw new WorktreeFileError('Directories cannot have file content')
    if (request.kind === 'file' && request.content !== undefined && typeof request.content !== 'string') throw new WorktreeFileError('Invalid file content')
    return this.runExclusive(root, async () => {
      const target = await assertDestinationAvailable(root, relPath)
      if (request.kind === 'dir') {
        await mkdir(target.abs)
        const created = await resolveExistingEntry(root, relPath)
        if (created.kind !== 'dir') throw new WorktreeFileError('Created entry is not a directory: ' + relPath)
        return { path: relPath, kind: 'dir' }
      }

      const bytes = Buffer.from(request.content ?? '', 'utf8')
      if (bytes.length > WRITE_BYTE_LIMIT) throw new WorktreeFileError('File content exceeds 2 MiB write cap')
      const handle = await open(target.abs, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o666)
      const identity = await handle.stat()
      let complete = false
      try {
        await handle.writeFile(bytes)
        await handle.sync()
        const currentParent = await realpath(dirname(target.abs))
        if (currentParent !== target.parent || !isInside(root, currentParent)) throw new WorktreeFileError('Path escapes worktree: ' + relPath)
        await assertPathMatchesDescriptor(target.abs, root, identity, relPath)
        complete = true
      } finally {
        await handle.close()
        if (!complete) {
          const current = await lstat(target.abs).catch(() => null)
          const resolved = current ? await realpath(target.abs).catch(() => null) : null
          if (current && resolved && sameIdentity(current, identity) && isInside(root, resolved)) await unlink(target.abs).catch(() => undefined)
        }
      }
      return { path: relPath, kind: 'file' }
    })
  }

  async duplicateWorkspaceEntry(root: string, request: WorkspaceDuplicateRequest): Promise<WorkspaceMutationResult> {
    if (!request) throw new WorktreeFileError('Invalid duplicate request')
    const sourcePath = validateRelativePath(request.sourcePath)
    const destinationPath = validateRelativePath(request.destinationPath)
    if (sourcePath === destinationPath || destinationPath.startsWith(sourcePath + '/')) {
      throw new WorktreeFileError('Destination must be outside the source entry')
    }
    return this.runExclusive(root, async () => {
      const source = await resolveExistingEntry(root, sourcePath)
      const copied = await copyEntryTree(root, source, destinationPath)
      return { path: copied.relPath, kind: copied.kind, previousPath: sourcePath }
    })
  }

  async moveWorkspaceEntry(root: string, request: WorkspaceMoveRequest): Promise<WorkspaceMutationResult> {
    if (!request) throw new WorktreeFileError('Invalid move request')
    const sourcePath = validateRelativePath(request.sourcePath)
    const destinationPath = validateRelativePath(request.destinationPath)
    if (sourcePath === destinationPath || destinationPath.startsWith(sourcePath + '/')) {
      throw new WorktreeFileError('Destination must be outside the source entry')
    }
    return this.runExclusive(root, async () => {
      const source = await resolveExistingEntry(root, sourcePath)
      const copied = await copyEntryTree(root, source, destinationPath)
      await removeEntryTree(root, source)
      return { path: copied.relPath, kind: copied.kind, previousPath: sourcePath }
    })
  }

  async deleteWorkspaceEntry(root: string, request: WorkspaceDeleteRequest): Promise<WorkspaceMutationResult> {
    if (!request) throw new WorktreeFileError('Invalid delete request')
    const relPath = validateRelativePath(request.path)
    return this.runExclusive(root, async () => {
      const entry = await resolveExistingEntry(root, relPath)
      await removeEntryTree(root, entry)
      return { path: relPath, kind: entry.kind }
    })
  }

  async readPreviewImage(root: string, documentPath: string, source: string): Promise<string> {
    validateRelativePath(documentPath)
    if (typeof source !== 'string' || source.length === 0 || source.trim() !== source) throw new WorktreeFileError('Invalid image source')
    let decoded: string
    try {
      decoded = decodeURIComponent(source.split(/[?#]/, 1)[0])
    } catch {
      throw new WorktreeFileError(`Invalid image source: ${source}`)
    }
    if (
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded) ||
      decoded.startsWith('/') ||
      decoded.startsWith('\\') ||
      decoded.split('/').some((segment) => segment === '..')
    ) {
      throw new WorktreeFileError(`External image source is not allowed: ${source}`)
    }
    const localSource = decoded.replace(/^(?:\.\/)+/, '')
    const relPath = validateRelativePath(posix.join(posix.dirname(documentPath), localSource))
    const abs = await resolveExistingFile(root, relPath)
    const snapshot = await readBoundedDescriptor(abs, root, relPath, IMAGE_BYTE_LIMIT)
    if (snapshot.size > IMAGE_BYTE_LIMIT || snapshot.bytes.length > IMAGE_BYTE_LIMIT) {
      throw new WorktreeFileError(`Image exceeds ${IMAGE_BYTE_LIMIT / (1024 * 1024)} MiB preview cap`)
    }
    if (!snapshot.stable || snapshot.bytes.length !== snapshot.size) throw new WorktreeFileError(`Image changed while reading: ${relPath}`)

    const extensionMime = IMAGE_EXTENSIONS[extname(relPath).toLowerCase()]
    const detectedMime = sniffImageMime(snapshot.bytes)
    if (!extensionMime || !detectedMime || extensionMime !== detectedMime) {
      throw new WorktreeFileError(`Unsupported or mismatched image type: ${relPath}`)
    }
    return `data:${detectedMime};base64,${snapshot.bytes.toString('base64')}`
  }
}
