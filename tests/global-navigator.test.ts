import { describe, expect, it } from 'vitest'
import type { WorkspaceFileSearchRequest, WorkspaceFileSearchResult } from '../src/shared/file-workspace'
import {
  GlobalNavigatorFileCache,
  type NavigatorWorkspaceSearch
} from '../src/renderer/src/global-navigator'

type FileResultGate = {
  promise: Promise<WorkspaceFileSearchResult>
  resolve(value: WorkspaceFileSearchResult | PromiseLike<WorkspaceFileSearchResult>): void
  reject(reason?: unknown): void
}

function workspaceSearch(workspacePath: string, query: string): NavigatorWorkspaceSearch {
  return {
    repoId: `repo:${workspacePath}`,
    workspacePath,
    workspaceLabel: workspacePath.split('/').pop() ?? workspacePath,
    request: { query, showHidden: false, includeIgnored: false, maxResults: 100 }
  }
}

function fileResult(path: string, score = 1_000): WorkspaceFileSearchResult {
  return {
    matches: [{ entry: { path, name: path.split('/').pop() ?? path, type: 'file' }, score, hits: [0] }],
    scanned: 1,
    truncated: false
  }
}

describe('GlobalNavigatorFileCache', () => {
  it('cancels stale query updates and only publishes the newest generation', async () => {
    const cache = new GlobalNavigatorFileCache()
    const first = Promise.withResolvers<WorkspaceFileSearchResult>()
    const second = Promise.withResolvers<WorkspaceFileSearchResult>()
    const firstUpdates: string[][] = []
    const secondUpdates: string[][] = []
    const provider = (_workspacePath: string, request: WorkspaceFileSearchRequest): Promise<WorkspaceFileSearchResult> =>
      request.query === 'old' ? first.promise : second.promise

    const oldTask = cache.search(
      [workspaceSearch('/repo', 'old')],
      provider,
      (snapshot) => firstUpdates.push(snapshot.matches.map((match) => match.match.entry.path))
    )
    const newTask = cache.search(
      [workspaceSearch('/repo', 'new')],
      provider,
      (snapshot) => secondUpdates.push(snapshot.matches.map((match) => match.match.entry.path))
    )
    first.resolve(fileResult('src/old.ts'))
    second.resolve(fileResult('src/new.ts'))

    await Promise.all([oldTask.done, newTask.done])
    expect(firstUpdates).toEqual([])
    expect(secondUpdates.at(-1)).toEqual(['src/new.ts'])
    expect((await newTask.done).matches.map((match) => match.match.entry.path)).toEqual(['src/new.ts'])
  })

  it('serves exact cache hits immediately and invalidates them after workspace changes', async () => {
    const cache = new GlobalNavigatorFileCache()
    let calls = 0
    const provider = async (): Promise<WorkspaceFileSearchResult> => {
      calls += 1
      return fileResult(`src/result-${calls}.ts`)
    }
    const search = workspaceSearch('/repo', 'result')

    await cache.search([search], provider).done
    const cached = cache.search([search], provider)
    expect(cached.initial.pending).toBe(0)
    expect(cached.initial.matches[0]?.match.entry.path).toBe('src/result-1.ts')
    await cached.done
    expect(calls).toBe(1)

    cache.invalidateWorkspace('/repo')
    const refreshed = cache.search([search], provider)
    expect(refreshed.initial.pending).toBe(1)
    expect((await refreshed.done).matches[0]?.match.entry.path).toBe('src/result-2.ts')
    expect(calls).toBe(2)
  })

  it('does not reuse results when the workspace search provider changes', async () => {
    const cache = new GlobalNavigatorFileCache()
    const search = workspaceSearch('/repo', 'provider')
    const firstProvider = async (): Promise<WorkspaceFileSearchResult> => fileResult('src/local.ts')
    const replacementProvider = async (): Promise<WorkspaceFileSearchResult> => fileResult('src/remote.ts')
    await cache.search([search], firstProvider).done

    const replacement = cache.search([search], replacementProvider)
    expect(replacement.initial.pending).toBe(1)
    expect((await replacement.done).matches[0]?.match.entry.path).toBe('src/remote.ts')
  })

  it('drops cached results when a workspace is no longer authorized', async () => {
    const cache = new GlobalNavigatorFileCache()
    let calls = 0
    const provider = async (): Promise<WorkspaceFileSearchResult> => {
      calls += 1
      return fileResult('src/authorized.ts')
    }
    const search = workspaceSearch('/repo', 'authorized')
    await cache.search([search], provider).done

    cache.reconcileAuthorizedWorkspaces(new Set(['/other']))
    const unauthorized = cache.search([search], provider)
    expect(unauthorized.initial.pending).toBe(0)
    expect(unauthorized.initial.matches).toEqual([])
    expect(unauthorized.initial.errors[0]?.message).toContain('no longer authorized')
    await unauthorized.done
    expect(calls).toBe(1)
  })

  it('limits provider fan-out to three workspaces', async () => {
    const cache = new GlobalNavigatorFileCache()
    const gates = new Map<string, FileResultGate>()
    let active = 0
    let maximumActive = 0
    let calls = 0
    const fourthStarted = Promise.withResolvers<void>()
    const allStarted = Promise.withResolvers<void>()
    const provider = (workspacePath: string): Promise<WorkspaceFileSearchResult> => {
      calls += 1
      if (calls === 4) fourthStarted.resolve()
      if (calls === 6) allStarted.resolve()
      active += 1
      maximumActive = Math.max(maximumActive, active)
      const gate = Promise.withResolvers<WorkspaceFileSearchResult>()
      gates.set(workspacePath, gate)
      return gate.promise.finally(() => {
        active -= 1
      })
    }
    const searches = Array.from({ length: 6 }, (_, index) => workspaceSearch(`/repo-${index}`, 'file'))
    const task = cache.search(searches, provider)
    await Promise.resolve()
    expect(calls).toBe(3)

    const firstGate = gates.get('/repo-0')
    expect(firstGate).toBeDefined()
    firstGate?.resolve(fileResult('src/zero.ts'))
    await fourthStarted.promise
    expect(calls).toBe(4)
    expect(maximumActive).toBe(3)

    for (const [workspacePath, gate] of gates) gate.resolve(fileResult(`${workspacePath}/file.ts`))
    await allStarted.promise
    for (const [workspacePath, gate] of gates) gate.resolve(fileResult(`${workspacePath}/file.ts`))
    await task.done
    expect(maximumActive).toBe(3)
  })

  it('surfaces per-workspace provider errors without hiding healthy results', async () => {
    const cache = new GlobalNavigatorFileCache()
    const task = cache.search(
      [workspaceSearch('/healthy', 'file'), workspaceSearch('/offline', 'file')],
      async (workspacePath) => {
        if (workspacePath === '/offline') throw new Error('remote host unavailable')
        return fileResult('src/healthy.ts')
      }
    )

    const result = await task.done
    expect(result.matches.map((match) => match.match.entry.path)).toEqual(['src/healthy.ts'])
    expect(result.errors).toEqual([
      { workspacePath: '/offline', workspaceLabel: 'offline', message: 'remote host unavailable' }
    ])
  })
})
