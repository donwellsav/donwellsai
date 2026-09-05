import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROJECT_MEMORY_MAX_CONTENT_LENGTH,
  PROJECT_MEMORY_MAX_HISTORY_REVISIONS,
  parseProjectMemoryCreateRequest,
  type ProjectMemoryEntry,
  type ProjectMemoryProject,
  type ProjectMemoryRevision
} from '../src/shared/project-memory'
import { ProjectMemoryService, type ProjectMemoryResolver } from '../src/main/project-memory'
import {
  ProjectMemoryConflictError,
  ProjectMemoryLoadError,
  ProjectMemoryStateError
} from '../src/main/project-memory-store'

const temporaryRoots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'donwells-project-memory-'))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const mainWorkspace = '/projects/product'
const linkedWorktree = '/projects/product-worktrees/feature'
const folderWorkspace = '/folders/notes'
const productProject: ProjectMemoryProject = {
  projectKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  projectPath: mainWorkspace
}
const folderProject: ProjectMemoryProject = {
  projectKey: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  projectPath: folderWorkspace
}

function resolver(): ProjectMemoryResolver {
  return async (workspacePath) => {
    if (workspacePath === mainWorkspace || workspacePath === linkedWorktree) return productProject
    if (workspacePath === folderWorkspace) return folderProject
    throw new Error('Workspace is not a registered local project')
  }
}

function clock(start = Date.parse('2026-09-05T12:00:00.000Z')): () => Date {
  let milliseconds = start
  return () => {
    const instant = new Date(milliseconds)
    milliseconds += 1_000
    return instant
  }
}

describe('project memory authority', () => {
  it('shares one identity across registered worktrees and harnesses while isolating folder projects', async () => {
    const userData = temporaryRoot()
    let productRegistered = true
    const projectResolver: ProjectMemoryResolver = async (workspacePath) => {
      if (productRegistered && (workspacePath === mainWorkspace || workspacePath === linkedWorktree)) return productProject
      if (workspacePath === folderWorkspace) return folderProject
      throw new Error('Workspace is not a registered local project')
    }
    const service = new ProjectMemoryService(userData, projectResolver, {
      now: clock(),
      createId: () => 'memory-product-1'
    })
    const created = await service.projectMemoryCreate({
      workspacePath: mainWorkspace,
      kind: 'decision',
      title: 'Use one durable cache',
      content: 'All harnesses read the same project-owned cache authority.',
      tags: ['architecture', 'cache'],
      attribution: { harness: 'codex', sourceSession: 'session-a', sourceRef: 'src/cache.ts:10' }
    })
    expect(created).toMatchObject({
      id: 'memory-product-1',
      revision: 1,
      provenance: {
        harness: 'codex',
        sourceSession: 'session-a',
        sourceRef: 'src/cache.ts:10',
        workspace: mainWorkspace
      }
    })

    const fromOtherHarness = await service.projectMemoryList({
      workspacePath: linkedWorktree,
      query: 'durable cache',
      limit: 10
    })
    expect(fromOtherHarness.project).toEqual(productProject)
    expect(fromOtherHarness.entries.map((entry: ProjectMemoryEntry) => entry.id)).toEqual([created.id])

    const folderService = new ProjectMemoryService(userData, projectResolver, {
      now: clock(Date.parse('2026-09-05T13:00:00.000Z')),
      createId: () => 'memory-folder-1'
    })
    await folderService.projectMemoryCreate({
      workspacePath: folderWorkspace,
      kind: 'fact',
      title: 'Use one durable cache',
      content: 'This folder project has an independent memory namespace.',
      attribution: { harness: 'claude-code' }
    })
    await expect(folderService.projectMemoryList({ workspacePath: folderWorkspace })).resolves.toMatchObject({
      project: folderProject,
      total: 1,
      entries: [{ id: 'memory-folder-1' }]
    })
    await expect(folderService.projectMemoryList({ workspacePath: linkedWorktree })).resolves.toMatchObject({
      project: productProject,
      total: 1,
      entries: [{ id: 'memory-product-1' }]
    })

    productRegistered = false
    await expect(service.projectMemoryGet({ workspacePath: linkedWorktree, id: created.id }))
      .rejects.toThrow('not a registered local project')
    productRegistered = true
    const readded = new ProjectMemoryService(userData, projectResolver)
    const restored = await readded.projectMemoryGet({ workspacePath: linkedWorktree, id: created.id })
    expect(restored).toEqual(created)
    expect(statSync(join(userData, 'project-memory.json')).mode & 0o077).toBe(0)
    expect(readdirSync(userData).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('ranks title and tags above content deterministically', async () => {
    const userData = temporaryRoot()
    const ids = ['content-hit', 'tag-hit', 'title-hit']
    const service = new ProjectMemoryService(userData, resolver(), {
      now: clock(),
      createId: () => ids.shift()!
    })
    await service.projectMemoryCreate({
      workspacePath: mainWorkspace,
      kind: 'fact',
      title: 'Background behavior',
      content: 'The navigator cache is refreshed lazily.',
      attribution: { harness: 'codex' }
    })
    await service.projectMemoryCreate({
      workspacePath: mainWorkspace,
      kind: 'convention',
      title: 'Refresh policy',
      content: 'Refresh results lazily.',
      tags: ['navigator-cache'],
      attribution: { harness: 'codex' }
    })
    await service.projectMemoryCreate({
      workspacePath: mainWorkspace,
      kind: 'decision',
      title: 'Navigator cache',
      content: 'Use a bounded index.',
      attribution: { harness: 'codex' }
    })
    const first = await service.projectMemoryList({ workspacePath: linkedWorktree, query: 'navigator cache' })
    const second = await service.projectMemoryList({ workspacePath: linkedWorktree, query: 'navigator cache' })
    expect(first.entries.map((entry: ProjectMemoryEntry) => entry.id)).toEqual(['title-hit', 'tag-hit', 'content-hit'])
    expect(second.entries.map((entry: ProjectMemoryEntry) => entry.id)).toEqual(first.entries.map((entry: ProjectMemoryEntry) => entry.id))
    await expect(service.projectMemoryList({ workspacePath: linkedWorktree, query: '' }))
      .resolves.toMatchObject({ total: 3 })
  })

  it('rejects a stale revision race and notifies only after committed mutations', async () => {
    const userData = temporaryRoot()
    const changed: string[] = []
    const service = new ProjectMemoryService(userData, resolver(), {
      now: clock(),
      createId: () => 'raced-memory',
      onChanged: (project) => {
        changed.push(project.projectKey)
        throw new Error('Observer is unavailable')
      }
    })
    const created = await service.projectMemoryCreate({
      workspacePath: mainWorkspace,
      kind: 'fact',
      title: 'Initial fact',
      content: 'Revision one.',
      attribution: { harness: 'codex' }
    })
    const update = (content: string, harness: string) => service.projectMemoryUpdate({
      workspacePath: linkedWorktree,
      id: created.id,
      expectedRevision: 1,
      kind: 'fact',
      title: 'Initial fact',
      content,
      attribution: { harness }
    })
    const outcomes = await Promise.allSettled([
      update('Revision from harness alpha.', 'alpha'),
      update('Revision from harness beta.', 'beta')
    ])
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled')
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({ reason: expect.any(ProjectMemoryConflictError) })
    await expect(service.projectMemoryGet({ workspacePath: mainWorkspace, id: created.id }))
      .resolves.toMatchObject({ revision: 2 })
    expect(changed).toEqual([productProject.projectKey, productProject.projectKey])
  })

  it('archives, restores, and retains immutable bounded provenance history', async () => {
    const userData = temporaryRoot()
    let id = 0
    const service = new ProjectMemoryService(userData, resolver(), {
      now: clock(),
      createId: () => `history-${++id}`
    })
    const created = await service.projectMemoryCreate({
      workspacePath: mainWorkspace,
      kind: 'procedure',
      title: 'Release procedure',
      content: 'Build the signed artifact.',
      tags: ['release'],
      attribution: { harness: 'codex', sourceSession: 'create-session' }
    })
    const updated = await service.projectMemoryUpdate({
      workspacePath: linkedWorktree,
      id: created.id,
      expectedRevision: 1,
      kind: 'procedure',
      title: 'Release procedure',
      content: 'Build, verify, and then publish the signed artifact.',
      tags: ['release', 'verification'],
      attribution: { harness: 'claude-code', sourceSession: 'update-session' }
    })
    const archived = await service.projectMemoryArchive({
      workspacePath: linkedWorktree,
      id: created.id,
      expectedRevision: updated.revision,
      archived: true,
      attribution: { harness: 'omp', sourceRef: 'cleanup-pass' }
    })
    expect(archived).toMatchObject({ revision: 3, archivedAt: archived.updatedAt })
    await expect(service.projectMemoryList({ workspacePath: mainWorkspace })).resolves.toMatchObject({ total: 0 })
    await expect(service.projectMemoryList({ workspacePath: mainWorkspace, includeArchived: true })).resolves.toMatchObject({
      total: 1,
      entries: [{ id: created.id, revision: 3 }]
    })
    await expect(service.projectMemoryUpdate({
      workspacePath: mainWorkspace,
      id: created.id,
      expectedRevision: 3,
      kind: 'procedure',
      title: 'Release procedure',
      content: 'Editing an archived memory is forbidden.',
      attribution: { harness: 'codex' }
    })).rejects.toBeInstanceOf(ProjectMemoryStateError)

    const beforeRestore = await service.projectMemoryHistory({ workspacePath: mainWorkspace, id: created.id })
    expect(beforeRestore.revisions.map((revision: ProjectMemoryRevision) => revision.revision)).toEqual([3, 2, 1])
    expect(beforeRestore.revisions.map((revision: ProjectMemoryRevision) => revision.provenance.harness)).toEqual(['omp', 'claude-code', 'codex'])
    beforeRestore.revisions[2]!.provenance.harness = 'tampered'
    const immutable = await service.projectMemoryHistory({ workspacePath: mainWorkspace, id: created.id })
    expect(immutable.revisions[2]!.provenance.harness).toBe('codex')

    const restored = await service.projectMemoryArchive({
      workspacePath: mainWorkspace,
      id: created.id,
      expectedRevision: archived.revision,
      archived: false,
      attribution: { harness: 'donwells-ui' }
    })
    expect(restored).toMatchObject({ revision: 4, archivedAt: null })
    await expect(service.projectMemoryArchive({
      workspacePath: mainWorkspace,
      id: created.id,
      expectedRevision: archived.revision,
      archived: true,
      attribution: { harness: 'stale-client' }
    })).rejects.toBeInstanceOf(ProjectMemoryConflictError)

    let current = restored
    for (let revision = 0; revision < PROJECT_MEMORY_MAX_HISTORY_REVISIONS + 2; revision += 1) {
      current = await service.projectMemoryUpdate({
        workspacePath: mainWorkspace,
        id: current.id,
        expectedRevision: current.revision,
        kind: current.kind,
        title: current.title,
        content: `Bounded history update ${revision}.`,
        tags: current.tags,
        attribution: { harness: 'history-writer', sourceSession: `revision-${revision}` }
      })
    }
    const bounded = await service.projectMemoryHistory({ workspacePath: mainWorkspace, id: created.id })
    expect(bounded.revisions).toHaveLength(PROJECT_MEMORY_MAX_HISTORY_REVISIONS + 1)
    expect(bounded.revisions[0]!.revision).toBe(current.revision)
    expect(bounded.truncated).toBe(true)
  })

  it('fails closed without overwriting corrupt or insecure persistence and strictly bounds requests', () => {
    const userData = temporaryRoot()
    const path = join(userData, 'project-memory.json')
    const corrupt = '{not valid json'
    writeFileSync(path, corrupt, { encoding: 'utf8', mode: 0o600 })
    chmodSync(path, 0o600)
    expect(() => new ProjectMemoryService(userData, resolver())).toThrow(ProjectMemoryLoadError)
    expect(readFileSync(path, 'utf8')).toBe(corrupt)

    expect(() => parseProjectMemoryCreateRequest({
      workspacePath: mainWorkspace,
      kind: 'fact',
      title: 'Strict request',
      content: 'Unknown fields are rejected.',
      attribution: { harness: 'codex' },
      unexpected: true
    })).toThrow('unknown field')
    expect(() => parseProjectMemoryCreateRequest({
      workspacePath: mainWorkspace,
      kind: 'fact',
      title: 'Oversized request',
      content: 'x'.repeat(PROJECT_MEMORY_MAX_CONTENT_LENGTH + 1),
      attribution: { harness: 'codex' }
    })).toThrow(`no longer than ${PROJECT_MEMORY_MAX_CONTENT_LENGTH}`)

    if (process.platform !== 'win32') {
      const insecureUserData = temporaryRoot()
      const insecurePath = join(insecureUserData, 'project-memory.json')
      writeFileSync(insecurePath, JSON.stringify({ schemaVersion: 1, projects: [] }), { encoding: 'utf8', mode: 0o644 })
      chmodSync(insecurePath, 0o644)
      try {
        new ProjectMemoryService(insecureUserData, resolver())
        throw new Error('Expected insecure project memory persistence to fail')
      } catch (error) {
        expect(error).toBeInstanceOf(ProjectMemoryLoadError)
        expect(error).toMatchObject({ kind: 'permissions' })
      }
    }
  })
})
