import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'

/**
 * Owner-only mode for durable documents. The temporary file is created with
 * `openSync(..., 'wx', PRIVATE_FILE_MODE)`, which the umask may narrow; the
 * published file keeps the temporary file's mode unless a caller asks for the
 * exact mode back via {@link AtomicWriteOptions.enforceModeAfterPublish}.
 */
const PRIVATE_FILE_MODE = 0o600

export type AtomicWriteOptions = {
  /**
   * Create the destination directory recursively with this mode before writing.
   * Omitted when the caller has already created and validated the directory.
   */
  createDirectoryMode?: number
  /**
   * Runs once the destination directory is known to exist and before the
   * temporary file is created, for pre-publication work such as validating the
   * directory or preserving the document being replaced.
   */
  beforeWrite?: () => void
  /**
   * Re-apply {@link PRIVATE_FILE_MODE} to the published file after the rename on
   * POSIX, where the open mode alone cannot guarantee the exact permissions.
   */
  enforceModeAfterPublish?: boolean
}

/**
 * Durable private publication: flush the complete next revision to a temporary
 * file in the destination directory, fsync it, then publish it with one atomic
 * rename before fsyncing the directory.
 *
 * A failed write never leaves a partial destination file and never leaves the
 * temporary file behind. The bytes are flushed to the descriptor before the
 * rename, so a crash after publication cannot expose a truncated document.
 */
export function atomicWriteFileSync(
  path: string,
  bytes: string | Uint8Array,
  options: AtomicWriteOptions = {}
): void {
  const directory = dirname(path)
  if (options.createDirectoryMode !== undefined) {
    mkdirSync(directory, { recursive: true, mode: options.createDirectoryMode })
  }
  options.beforeWrite?.()

  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', PRIVATE_FILE_MODE)
    writeFileSync(descriptor, bytes, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, path)
    if (options.enforceModeAfterPublish === true && process.platform !== 'win32') {
      chmodSync(path, PRIVATE_FILE_MODE)
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    rmSync(temporary, { force: true })
    throw error
  }

  fsyncDirectory(directory)
}

/**
 * Fsync a directory where the platform supports it. The file itself is already
 * flushed and atomically renamed, so an unsupported directory fsync is not a
 * failed durability claim.
 */
function fsyncDirectory(directory: string): void {
  if (process.platform === 'win32') return
  let descriptor: number | undefined
  try {
    descriptor = openSync(directory, 'r')
    fsyncSync(descriptor)
  } catch {
    // Not every Unix filesystem supports directory fsync.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}
