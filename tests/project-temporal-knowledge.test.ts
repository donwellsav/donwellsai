import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ProjectMemoryService } from '../src/main/project-memory'
import { ProjectTemporalKnowledge, type GraphitiWorker } from '../src/main/project-temporal-knowledge'
import { temporalSources } from '../src/main/project-temporal-sources'
import type { TemporalSource } from '../src/shared/project-temporal-knowledge'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const projectKey = 'a'.repeat(64), path = '/project'
async function fixture() {
  const profile = mkdtempSync(join(tmpdir(), 'temporal-')); roots.push(profile)
  let day = 0
  const memory = new ProjectMemoryService(profile, async () => ({ projectKey, projectPath: path }), { now: () => new Date(Date.UTC(2026, 0, ++day)) })
  let entry = await memory.projectMemoryCreate({ workspacePath: path, title: 'Decision', content: 'Use A', kind: 'decision', tags: [], attribution: { harness: 'human' } })
  const selected = () => [{ kind: 'memory' as const, id: entry.id, revision: entry.revision }]
  const update = async () => { entry = await memory.projectMemoryUpdate({ workspacePath: path, id: entry.id, expectedRevision: entry.revision, title: entry.title, content: 'Use B', kind: 'decision', tags: [], attribution: { harness: 'human' } }) }
  const groups = new Map<string, TemporalSource[]>()
  let failRetain = false, failDelete = false, mutate = false
  const worker: GraphitiWorker = async request => {
    if (request.operation === 'retain') { groups.set(request.group, request.sources!); if (failRetain) { failRetain = false; throw new Error('Lost retain response') }; return { group: request.group, receipts: request.sources!.map(source => ({ episode: source.episodeId, edges: ['edge-' + source.episodeId] })) } }
    if (request.operation === 'delete') { if (failDelete) throw new Error('Delete unavailable'); groups.delete(request.group); return { group: request.group, deleted: true } }
    if (mutate) await update()
    return { group: request.group, edges: groups.get(request.group)!.map(source => ({ group_id: request.group, uuid: source.episodeId, fact: source.content, episodes: [source.episodeId], valid_at: source.availableFrom, invalid_at: source.availableUntil })).concat([{ group_id: request.group, uuid: 'foreign', fact: 'FOREIGN TEXT', episodes: ['unowned'], valid_at: null!, invalid_at: null }]) }
  }
  const owner = (scopeKey = projectKey) => new ProjectTemporalKnowledge(profile, { enabled: true, python: '/python', neo4jUri: 'bolt://127.0.0.1:7687', neo4jUser: 'neo4j', modelUrl: 'http://127.0.0.1:8000/v1', model: 'local', embeddingUrl: 'http://127.0.0.1:8000/v1', embeddingModel: 'embed', embeddingDimensions: 1024 }, async () => ({ projectKey: scopeKey, projectPath: path, checkoutPath: path, indexKey: scopeKey }), undefined, worker)
  return { owner, groups, selected, update, profile, memory, set: (options: { failRetain?: boolean; failDelete?: boolean; mutate?: boolean }) => { failRetain = options.failRetain ?? false; failDelete = options.failDelete ?? false; mutate = options.mutate ?? false } }
}
it('rebuilds retained history with generation-unique episode IDs and gates current versus historical source intervals', async () => {
  const f = await fixture(), owner = f.owner()
  await owner.reconcile(path, f.selected())
  await expect(f.owner('b'.repeat(64)).reconcile(path, f.selected())).rejects.toThrow()
  expect(f.groups.size).toBe(1)
  const first = [...f.groups.values()][0][0].episodeId
  await f.update(); expect((await owner.status(path)).stale).toBe(true)
  await owner.reconcile(path, f.selected())
  expect(f.groups.size).toBe(1)
  expect([...f.groups.values()][0][0].episodeId).not.toBe(first)
  expect((await owner.query(path, 'Decision')).relationships.map(row => row.text)).toEqual(['decision: Decision\nUse B'])
  const historical = await f.owner().query(path, 'Decision', '2026-01-01T12:00:00Z')
  expect(historical.relationships.map(row => row.text)).toEqual(['decision: Decision\nUse A'])
  expect(historical.omitted).toBe(2)
  const source = f.selected()[0]
  await f.memory.projectMemoryErase({ workspacePath: path, id: source.id, expectedRevision: source.revision })
  await expect(owner.query(path, 'Decision', '2026-01-01T12:00:00Z')).rejects.toThrow('stale')
  await owner.reconcile(path, []); expect(f.groups.size).toBe(1)
})
it('keeps uncertain groups durable, blocks failed cleanup and rejects changed sources after a query', async () => {
  const f = await fixture(), owner = f.owner()
  f.set({ failRetain: true }); await expect(owner.reconcile(path, f.selected())).rejects.toThrow('Lost')
  expect((await f.owner().status(path)).pendingCleanup).toBe(1)
  f.set({ failDelete: true }); await expect(f.owner().reconcile(path, f.selected())).rejects.toThrow('Delete')
  f.set({}); await f.owner().reconcile(path, f.selected()); expect(f.groups.size).toBe(1)
  f.set({ mutate: true }); await expect(f.owner().query(path, 'Decision')).rejects.toThrow('changed')
})
it('refuses fabricated handoff dates and reports unavailable canonical history intervals', async () => {
  const f = await fixture()
  expect(() => temporalSources(f.profile, projectKey, [{ kind: 'handoff', id: 'handoff', revision: 1 }])).toThrow('no authored timestamps')
  for (let i = 0; i < 34; i++) await f.update()
  const owner = f.owner(); await owner.reconcile(path, f.selected())
  await expect(owner.query(path, 'Decision', '2026-01-01T12:00:00Z')).rejects.toThrow('truncated')
})
