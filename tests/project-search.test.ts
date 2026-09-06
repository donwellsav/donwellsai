import { expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ProjectCodeSearchResult, ProjectSearchHit } from '../src/shared/project-tools'
const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, callback: (...args: any[]) => any) => handlers.set(name, callback) } }))
import { registerProjectSearchHandlers } from '../src/main/project-search-ipc'

it('owns search cancellation per renderer, caps active requests and fences late results', async () => {
  const jobs: Array<{ signal: AbortSignal; emit: (hit: ProjectSearchHit) => void; resolve: (value: ProjectCodeSearchResult) => void }> = []
  registerProjectSearchHandlers({ searchWorkspaceContent: async (_path, _request, emit, signal) => {
    const pending = Promise.withResolvers<ProjectCodeSearchResult>()
    jobs.push({ signal: signal!, emit: emit!, resolve: pending.resolve })
    return pending.promise
  } })
  const sender = () => Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() })
  const a = sender(), b = sender(), search = handlers.get('searchWorkspaceContent')!, cancel = handlers.get('cancelWorkspaceContentSearch')!
  const request = { query: 'needle', showHidden: false, includeIgnored: false }
  const pending = Array.from({ length: 4 }, (_, i) => search({ sender: a }, '/project', `a${i}`, request))
  await expect(search({ sender: a }, '/project', 'extra', request)).rejects.toThrow('already running')
  cancel({ sender: b }, 'a0')
  expect(jobs[0]!.signal.aborted).toBe(false)
  pending.push(search({ sender: b }, '/other', 'b0', request))
  const hit: ProjectSearchHit = { source: 'code', id: 'code:fixture', path: 'file.ts', line: 2, title: 'file.ts', excerpt: 'needle', revision: null, indexedAt: null, stale: false }
  jobs[0]!.emit(hit); expect(a.send).toHaveBeenCalledTimes(1)
  a.emit('did-start-navigation', {}, 'url', false, true)
  for (const job of jobs.slice(0, 4)) { expect(job.signal.aborted).toBe(true); job.emit(hit) }
  expect(a.send).toHaveBeenCalledTimes(1)
  expect(jobs[4]!.signal.aborted).toBe(false)
  b.emit('destroyed'); expect(jobs[4]!.signal.aborted).toBe(true)
  for (const job of jobs) job.resolve({ hits: [], truncated: false, skipped: 0 })
  await Promise.all(pending)
})
