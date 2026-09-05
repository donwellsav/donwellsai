import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  ATTENTION_INBOX_SCHEMA_VERSION,
  parseAttentionInboxDocument,
  type AttentionInboxDocument
} from '@shared/attention-inbox'

const FILE_NAME = 'attention-inbox.json'

export type AttentionInboxLoadErrorKind = 'corrupt' | 'unsupported-schema' | 'read'

export class AttentionInboxLoadError extends Error {
  constructor(
    readonly kind: AttentionInboxLoadErrorKind,
    readonly path: string,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AttentionInboxLoadError'
  }
}

function emptyDocument(): AttentionInboxDocument {
  return {
    schemaVersion: ATTENTION_INBOX_SCHEMA_VERSION,
    revision: 0,
    events: [],
    observations: [],
    discardedAcknowledged: 0
  }
}

function readDocument(path: string): AttentionInboxDocument {
  if (!existsSync(path)) return emptyDocument()
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new AttentionInboxLoadError('corrupt', path, 'Attention inbox contains invalid JSON; the file was left untouched', error)
    }
    throw new AttentionInboxLoadError('read', path, 'Attention inbox could not be read; the file was left untouched', error)
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)
    && 'schemaVersion' in value && value.schemaVersion !== ATTENTION_INBOX_SCHEMA_VERSION) {
    throw new AttentionInboxLoadError(
      'unsupported-schema',
      path,
      `Unsupported attention inbox schema version: ${String(value.schemaVersion)}; the file was left untouched`
    )
  }
  try {
    return parseAttentionInboxDocument(value)
  } catch (error) {
    throw new AttentionInboxLoadError('corrupt', path, 'Attention inbox failed validation; the file was left untouched', error)
  }
}

/** Flush the complete next document before publishing it with one atomic rename. */
function writeDocument(path: string, document: AttentionInboxDocument): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, path)
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    rmSync(temporary, { force: true })
    throw error
  }

  if (process.platform === 'win32') return
  let directoryDescriptor: number | undefined
  try {
    directoryDescriptor = openSync(directory, 'r')
    fsyncSync(directoryDescriptor)
  } catch {
    // The file itself is durable; not every Unix filesystem supports directory fsync.
  } finally {
    if (directoryDescriptor !== undefined) closeSync(directoryDescriptor)
  }
}

/** Single daemon-owned persistence authority. Invalid stores are never replaced implicitly. */
export class AttentionInboxStore {
  readonly path: string
  private document: AttentionInboxDocument

  constructor(userDataDir: string) {
    this.path = join(userDataDir, FILE_NAME)
    this.document = readDocument(this.path)
  }

  snapshot(): AttentionInboxDocument {
    return structuredClone(this.document)
  }

  commit(value: AttentionInboxDocument): AttentionInboxDocument {
    const document = parseAttentionInboxDocument(value)
    writeDocument(this.path, document)
    this.document = document
    return structuredClone(document)
  }
}
