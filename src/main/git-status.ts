import type { GitStatusCode, GitStatusEntry, RepoKind, WorktreeStatus } from '@shared/types'

const HEADER_PREFIX = '# '
const INITIAL_OID = '(initial)'
const DETACHED_HEAD = '(detached)'

function splitPrefix(record: string, fieldCount: number): { fields: string[]; remainder: string } {
  const fields: string[] = []
  let start = 0
  for (let index = 0; index < fieldCount; index++) {
    const separator = record.indexOf(' ', start)
    if (separator === -1) throw new Error(`Malformed git status record: ${record.slice(0, 24)}`)
    fields.push(record.slice(start, separator))
    start = separator + 1
  }
  return { fields, remainder: record.slice(start) }
}

function statusCode(value: string): GitStatusCode {
  if (value === '.' || value === 'M' || value === 'T' || value === 'A' || value === 'D'
    || value === 'R' || value === 'C' || value === 'U' || value === '?') return value
  throw new Error(`Unsupported git status code: ${value}`)
}

function trackedEntry(
  recordType: '1' | '2' | 'u',
  xy: string,
  path: string,
  originalPath?: string
): GitStatusEntry {
  if (xy.length !== 2) throw new Error(`Malformed git status XY field: ${xy}`)
  const index = statusCode(xy[0] ?? '')
  const workingTree = statusCode(xy[1] ?? '')
  const conflict = recordType === 'u' || index === 'U' || workingTree === 'U'
  return {
    path,
    originalPath,
    kind: conflict ? 'conflict' : recordType === '2' ? 'renamed' : 'ordinary',
    index,
    workingTree,
    staged: !conflict && index !== '.',
    unstaged: !conflict && workingTree !== '.',
    conflict
  }
}

function compatibilityLines(
  branch: string,
  detached: boolean,
  upstream: string | undefined,
  ahead: number,
  behind: number,
  entries: readonly GitStatusEntry[]
): string[] {
  const branchLabel = detached ? 'HEAD (no branch)' : branch
  const tracking = upstream ? `...${upstream}` : ''
  const divergence = ahead || behind
    ? ` [${[ahead ? `ahead ${ahead}` : '', behind ? `behind ${behind}` : ''].filter(Boolean).join(', ')}]`
    : ''
  const lines = branchLabel ? [`## ${branchLabel}${tracking}${divergence}`] : []
  for (const entry of entries) {
    const path = entry.originalPath ? `${entry.originalPath} -> ${entry.path}` : entry.path
    if (entry.kind === 'untracked') {
      lines.push(`?? ${path}`)
      continue
    }
    const x = entry.index === '.' ? ' ' : entry.index
    const y = entry.workingTree === '.' ? ' ' : entry.workingTree
    lines.push(`${x}${y} ${path}`)
  }
  return lines
}

/** Parse `git status --porcelain=v2 --branch -z` without line- or quote-based path decoding. */
export function parseStatusPorcelainV2Z(output: string, kind: RepoKind = 'git'): WorktreeStatus {
  let branch = ''
  let detached = false
  let headOid: string | undefined
  let upstream: string | undefined
  let ahead = 0
  let behind = 0
  const entries: GitStatusEntry[] = []
  const records = output.split('\0')

  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (!record) continue
    if (record.startsWith(HEADER_PREFIX)) {
      const separator = record.indexOf(' ', HEADER_PREFIX.length)
      if (separator === -1) continue
      const key = record.slice(HEADER_PREFIX.length, separator)
      const value = record.slice(separator + 1)
      if (key === 'branch.oid' && value !== INITIAL_OID) headOid = value
      if (key === 'branch.head') {
        detached = value === DETACHED_HEAD
        branch = detached ? '' : value
      } else if (key === 'branch.upstream') {
        upstream = value
      } else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value)
        if (match) {
          ahead = Number(match[1])
          behind = Number(match[2])
        }
      }
      continue
    }

    const recordType = record[0]
    if (recordType === '?') {
      const path = record.slice(2)
      entries.push({
        path,
        kind: 'untracked',
        index: '?',
        workingTree: '?',
        staged: false,
        unstaged: true,
        conflict: false
      })
      continue
    }
    if (recordType === '!') continue
    if (recordType === '1') {
      const { fields, remainder } = splitPrefix(record, 8)
      entries.push(trackedEntry('1', fields[1] ?? '', remainder))
      continue
    }
    if (recordType === '2') {
      const { fields, remainder } = splitPrefix(record, 9)
      const originalPath = records[++index]
      if (originalPath === undefined) throw new Error('Malformed renamed git status record')
      entries.push(trackedEntry('2', fields[1] ?? '', remainder, originalPath))
      continue
    }
    if (recordType === 'u') {
      const { fields, remainder } = splitPrefix(record, 10)
      entries.push(trackedEntry('u', fields[1] ?? '', remainder))
      continue
    }
    throw new Error(`Unsupported git status record: ${record.slice(0, 24)}`)
  }

  let staged = 0
  let modified = 0
  let untracked = 0
  let conflicts = 0
  for (const entry of entries) {
    if (entry.conflict) conflicts++
    else if (entry.kind === 'untracked') untracked++
    else {
      if (entry.staged) staged++
      if (entry.unstaged) modified++
    }
  }
  return {
    kind,
    branch,
    detached,
    headOid,
    upstream,
    ahead,
    behind,
    staged,
    modified,
    untracked,
    conflicts,
    entries,
    changedFiles: entries.map((entry) => entry.path),
    raw: compatibilityLines(branch, detached, upstream, ahead, behind, entries)
  }
}

export function emptyWorkspaceStatus(kind: RepoKind): WorktreeStatus {
  return {
    kind,
    branch: '',
    detached: false,
    ahead: 0,
    behind: 0,
    staged: 0,
    modified: 0,
    untracked: 0,
    conflicts: 0,
    entries: [],
    changedFiles: [],
    raw: []
  }
}
