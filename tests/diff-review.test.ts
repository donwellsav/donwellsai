import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDiffReviewAnchor,
  createDiffReviewSnapshot,
  diffReviewSnapshotsEqual,
  formatDiffReviewAttachment,
  parseDiffReviewCreateRequest,
  splitDiffReviewLines,
  type DiffReviewNote,
  type DiffReviewSnapshotIdentity,
  type DiffReviewTarget
} from '../src/shared/diff-review'
import { DiffReviewService } from '../src/main/diff-review'
import { DiffReviewConflictError, DiffReviewLoadError } from '../src/main/diff-review-store'
import { diffSourcePaths, reviewSelectionFromPierre } from '../src/renderer/src/diff-review'
import type { GitStatusEntry } from '../src/shared/types'

const temporaryRoots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'donwells-diff-review-'))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const target: DiffReviewTarget = {
  workspacePath: '/workspace/project',
  filePath: 'src/example.ts',
  comparison: 'working'
}

function note(
  id: string,
  snapshot: DiffReviewSnapshotIdentity,
  body: string,
  createdAt: string,
  line = 2
): DiffReviewNote {
  return {
    id,
    target,
    snapshot,
    anchor: {
      side: 'after',
      startLine: line,
      endLine: line,
      context: [{ lineNumber: line, text: `line ${line}\n` }]
    },
    body,
    createdAt,
    updatedAt: createdAt,
    revision: 1
  }
}

describe('diff review snapshot anchors', () => {
  it('distinguishes absent, empty, and exact newline-preserving content without synthetic lines', async () => {
    const absentToEmpty = await createDiffReviewSnapshot(
      { path: 'src/empty.ts', contents: null },
      { path: 'src/empty.ts', contents: '' }
    )
    expect(absentToEmpty.before).toEqual({ kind: 'absent', path: 'src/empty.ts' })
    expect(absentToEmpty.after).toEqual({
      kind: 'content',
      path: 'src/empty.ts',
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      byteLength: 0,
      lineCount: 0
    })
    expect(splitDiffReviewLines('first\r\nsecond\n')).toEqual(['first\r\n', 'second\n'])
    expect(() => createDiffReviewAnchor('after', 1, 1, '')).toThrow('available source lines')

    const contents = 'one\ntwo\nthree\nfour\nfive\n'
    expect(createDiffReviewAnchor('after', 3, 2, contents, 1)).toEqual({
      side: 'after',
      startLine: 2,
      endLine: 3,
      context: [
        { lineNumber: 1, text: 'one\n' },
        { lineNumber: 2, text: 'two\n' },
        { lineNumber: 3, text: 'three\n' },
        { lineNumber: 4, text: 'four\n' }
      ]
    })
  })

  it('preserves rename side semantics and rejects cross-side or unavailable selections', async () => {
    const stagedRename: GitStatusEntry = {
      path: 'src/new.ts',
      originalPath: 'src/old.ts',
      kind: 'renamed',
      index: 'R',
      workingTree: 'M',
      staged: true,
      unstaged: true,
      conflict: false
    }
    expect(diffSourcePaths(stagedRename.path, 'staged', stagedRename)).toEqual({ beforePath: 'src/old.ts', afterPath: 'src/new.ts' })
    expect(diffSourcePaths(stagedRename.path, 'unstaged', stagedRename)).toEqual({ beforePath: 'src/new.ts', afterPath: 'src/new.ts' })
    expect(diffSourcePaths(stagedRename.path, 'working', stagedRename)).toEqual({ beforePath: 'src/old.ts', afterPath: 'src/new.ts' })

    const snapshot = await createDiffReviewSnapshot(
      { path: 'src/old.ts', contents: 'old\n' },
      { path: 'src/new.ts', contents: 'new\nnext\n' }
    )
    expect(reviewSelectionFromPierre({ start: 2, end: 1, side: 'additions', endSide: 'additions' }, snapshot)).toEqual({
      side: 'after', startLine: 1, endLine: 2
    })
    expect(() => reviewSelectionFromPierre({ start: 1, end: 1, side: 'deletions', endSide: 'additions' }, snapshot))
      .toThrow('entirely within one snapshot side')
    expect(() => reviewSelectionFromPierre({ start: 2, end: 2, side: 'deletions', endSide: 'deletions' }, snapshot))
      .toThrow('outside the loaded snapshot')
    expect(() => reviewSelectionFromPierre({ start: 1, end: 201, side: 'additions', endSide: 'additions' }, {
      before: snapshot.before,
      after: { ...snapshot.after, lineCount: 201 }
    })).toThrow('cannot span more than 200 lines')
  })
})

describe('durable diff review service', () => {
  it('canonicalizes registered workspaces and persists create, edit, conflict, and delete atomically', async () => {
    const userData = temporaryRoot()
    const workspaces = temporaryRoot()
    const registered = join(workspaces, 'registered')
    const alias = join(workspaces, 'alias')
    mkdirSync(registered)
    symlinkSync(registered, alias, 'dir')
    const canonical = realpathSync(registered)
    const resolver = (workspacePath: string): string => {
      const resolved = realpathSync(workspacePath)
      if (resolved !== canonical) throw new Error('workspace is not registered')
      return resolved
    }
    const instants = [
      new Date('2026-09-05T10:00:00.000Z'),
      new Date('2026-09-05T10:05:00.000Z'),
      new Date('2026-09-05T10:10:00.000Z')
    ]
    const service = new DiffReviewService(userData, {
      resolveWorkspace: resolver,
      createId: () => 'note-1',
      now: () => instants.shift()!
    })
    const snapshot = await createDiffReviewSnapshot(
      { path: 'src/example.ts', contents: 'before\n' },
      { path: 'src/example.ts', contents: 'after\nsecond\n' }
    )
    const created = await service.create({
      workspacePath: alias,
      filePath: 'src/example.ts',
      comparison: 'working',
      snapshot,
      anchor: createDiffReviewAnchor('after', 2, 2, 'after\nsecond\n'),
      body: '  Keep this invariant.  '
    })
    expect(created).toMatchObject({
      id: 'note-1',
      target: { workspacePath: canonical, filePath: 'src/example.ts', comparison: 'working' },
      body: 'Keep this invariant.',
      revision: 1
    })

    const restarted = new DiffReviewService(userData, { resolveWorkspace: resolver })
    const restored = await restarted.list({ workspacePath: alias, filePath: 'src/example.ts', comparison: 'working' })
    expect(restored.target.workspacePath).toBe(canonical)
    expect(restored.notes).toEqual([created])

    const updated = await service.update({ workspacePath: alias, id: created.id, expectedRevision: 1, body: 'Clarified invariant.' })
    expect(updated).toMatchObject({ body: 'Clarified invariant.', revision: 2, updatedAt: '2026-09-05T10:05:00.000Z' })
    await expect(service.update({ workspacePath: alias, id: created.id, expectedRevision: 1, body: 'Lost edit' }))
      .rejects.toBeInstanceOf(DiffReviewConflictError)
    await service.remove({ workspacePath: alias, id: created.id, expectedRevision: 2 })
    await expect(service.list({ workspacePath: alias, filePath: 'src/example.ts', comparison: 'working' }))
      .resolves.toMatchObject({ notes: [] })
    expect(readdirSync(userData).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('fails closed on corrupt persistence and malformed or absent-side anchors', async () => {
    const userData = temporaryRoot()
    writeFileSync(join(userData, 'diff-review-notes.json'), '{not json', 'utf8')
    expect(() => new DiffReviewService(userData, { resolveWorkspace: (path) => path })).toThrow(DiffReviewLoadError)

    const snapshot = await createDiffReviewSnapshot(
      { path: 'src/new.ts', contents: null },
      { path: 'src/new.ts', contents: 'created\n' }
    )
    const newFileTarget = { ...target, filePath: 'src/new.ts' }
    expect(() => parseDiffReviewCreateRequest({
      ...newFileTarget,
      snapshot,
      anchor: { side: 'before', startLine: 1, endLine: 1, context: [{ lineNumber: 1, text: 'invented' }] },
      body: 'Do not fabricate this line.'
    })).toThrow('absent snapshot side')
    expect(() => parseDiffReviewCreateRequest({
      ...newFileTarget,
      snapshot,
      anchor: createDiffReviewAnchor('after', 1, 1, 'created\n'),
      body: 'Valid body',
      unexpected: true
    })).toThrow('unknown field')
    expect(() => parseDiffReviewCreateRequest({
      ...newFileTarget,
      snapshot: { ...snapshot, after: { ...snapshot.after, path: 'src/other.ts' } },
      anchor: createDiffReviewAnchor('after', 1, 1, 'created\n'),
      body: 'Mismatched target'
    })).toThrow('after.path must match the diff target file')
  })
})

describe('agent review attachment', () => {
  it('is deterministic and keeps stale note snapshots and original context explicit', async () => {
    const current = await createDiffReviewSnapshot(
      { path: target.filePath, contents: 'before\n' },
      { path: target.filePath, contents: 'now\nline 2\n' }
    )
    const previous = await createDiffReviewSnapshot(
      { path: target.filePath, contents: 'before\n' },
      { path: target.filePath, contents: 'then\nline 2\n' }
    )
    expect(diffReviewSnapshotsEqual(previous, current)).toBe(false)
    const notes = [
      note('later', current, 'Current concern.', '2026-09-05T11:00:00.000Z'),
      note('earlier', previous, 'Original concern.\nSecond paragraph.', '2026-09-05T10:00:00.000Z')
    ]
    const first = formatDiffReviewAttachment(target, current, notes)
    const second = formatDiffReviewAttachment(target, current, [...notes].reverse())
    expect(second).toEqual(first)
    expect(first).toMatchObject({ kind: 'diff-review', workspacePath: target.workspacePath, title: 'Diff review · example.ts' })
    expect(first.text).toContain('Workspace: "/workspace/project"')
    expect(first.text).toContain('File: "src/example.ts"')
    expect(first.text).toContain('Side: after')
    expect(first.text).toContain('Line: 2')
    expect(first.text).toContain('Range: 2')
    expect(first.text).toContain('Context:')
    expect(first.text).toContain('stale snapshot (preserved, not reanchored)')
    expect(first.text.indexOf('Original concern.')).toBeLessThan(first.text.indexOf('Current concern.'))
  })
})
