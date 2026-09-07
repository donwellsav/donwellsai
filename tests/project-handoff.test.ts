import type { RunningAgent } from '../src/shared/agent-runtime'
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fork, type ChildProcess } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { ProjectHandoffService, ProjectHandoffStore } from '../src/main/project-handoff'
import { parseProjectHandoff, type ProjectHandoff } from '../src/shared/project-handoff'

const roots: string[] = []
const children: ChildProcess[] = []
afterEach(async () => {
  await Promise.all(children.splice(0).map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    child.once('exit', () => resolve())
    child.kill('SIGKILL')
  })))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'donwells-handoff-')); roots.push(root)
  return { root, store: new ProjectHandoffStore(root) }
}
const record: ProjectHandoff = {
  id: 'handoff-1', projectKey: 'a'.repeat(64), taskId: null, fromSessionId: 'omp-session', toAgent: 'hermes',
  checkoutPath: '/project', sourceRevision: 'b'.repeat(40), contentFingerprint: `sha256:${'c'.repeat(64)}`,
  goal: 'Finish preview', summary: 'The terminal layout is working.', openQuestions: ['Does the preview preserve focus?'],
  nextSteps: ['Check keyboard focus'], changedFiles: ['src/main.ts'], evidenceIds: [],
  state: 'open', delivery: 'not-sent', revision: 1, acceptedBySessionId: null
}

it('persists one claim, retries only the same request, and never replays uncertain delivery', () => {
  const { root, store } = setup()
  store.create(record)
  const other = new ProjectHandoffStore(root)
  const accepted = store.accept(record.projectKey, record.id, 1, 'hermes-session', 'claim-1')
  expect(accepted).toMatchObject({ state: 'accepted', revision: 2, delivery: 'not-sent' })
  expect(other.accept(record.projectKey, record.id, 1, 'hermes-session', 'claim-1')).toEqual(accepted)
  expect(() => other.accept(record.projectKey, record.id, 99, 'hermes-session', 'claim-1')).toThrow()
  expect(() => other.accept(record.projectKey, record.id, 1, 'kimi-session', 'claim-2')).toThrow()
  expect(() => other.get('d'.repeat(64), record.id)).toThrow('not found')
  const uncertain = other.beginDelivery(record.projectKey, record.id, 2, 'hermes-session')
  expect(new ProjectHandoffStore(root).get(record.projectKey, record.id)).toEqual(uncertain)
  expect(() => store.beginDelivery(record.projectKey, record.id, 3, 'hermes-session')).toThrow()
  expect(() => store.confirmDelivery(record.projectKey, record.id, 3, 'wrong-session')).toThrow()
  expect(store.confirmDelivery(record.projectKey, record.id, 3, 'hermes-session')).toMatchObject({ revision: 4, delivery: 'confirmed' })
  expect(store.supersede(record.projectKey, record.id, 4)).toMatchObject({ state: 'superseded', revision: 5 })
  expect(() => store.accept(record.projectKey, record.id, 1, 'hermes-session', 'claim-1')).toThrow()
  expect(other.list(record.projectKey)).toHaveLength(1)
  expect(other.list('d'.repeat(64))).toEqual([])
  if (process.platform !== 'win32') expect(statSync(join(root, 'project-handoffs.sqlite')).mode & 0o077).toBe(0)
})

it('rejects malformed records and traversal without mutating saved handoffs', () => {
  const { store } = setup()
  store.create(record)
  for (const patch of [{ changedFiles: ['../secret'] }, { changedFiles: ['/secret'] }, { state: 'accepted' }, { revision: 0 }, { contentFingerprint: 'HEAD' }, { unexpected: true }, { goal: '\u001b[31m' }]) {
    expect(() => parseProjectHandoff({ ...record, ...patch })).toThrow()
  }
  expect(() => store.create({ ...record, id: 'new', state: 'accepted', acceptedBySessionId: 'receiver' })).toThrow()
  expect(store.get(record.projectKey, record.id)).toEqual(record)
})

it('refuses symlink storage and preserves the target', () => {
  const { root, store } = setup()
  const target = join(root, 'original')
  writeFileSync(target, 'keep')
  symlinkSync(target, join(root, 'project-handoffs.sqlite'))
  expect(() => store.list(record.projectKey)).toThrow('private regular file')
  expect(statSync(target).size).toBe(4)
})


it('serializes claims from separate processes and retains uncertainty after SIGKILL', async () => {
  const { root, store } = setup()
  store.create(record)
  function child(action: string, recipient: string) {
    const process = fork(join(import.meta.dirname, 'fixtures/handoff-child.mjs'), [root, action, record.projectKey, record.id, recipient], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    children.push(process)
    let result: { ok: boolean; value?: ProjectHandoff; error?: string; pid: number } | undefined
    let stderr = ''
    process.stderr!.on('data', data => { stderr += data })
    const ready = new Promise<void>((resolve, reject) => {
      process.on('error', reject)
      process.on('message', (message: { ready?: boolean; ok: boolean; value?: ProjectHandoff; error?: string; pid: number }) => {
        if (message.ready) resolve(); else result = message
      })
      process.on('exit', () => reject(new Error(stderr || 'Fixture exited before ready')))
    })
    const done = new Promise<{ code: number | null; signal: string | null }>(resolve => process.on('exit', (code, signal) => resolve({ code, signal })))
    return { process, ready, done, result: () => result }
  }
  const first = child('claim', 'hermes')
  const second = child('claim', 'kimi')
  await Promise.all([first.ready, second.ready])
  first.process.send('go'); second.process.send('go')
  expect(await Promise.all([first.done, second.done])).toEqual([{ code: 0, signal: null }, { code: 0, signal: null }])
  const results = [first.result()!, second.result()!]
  expect(results.filter(result => result.ok)).toHaveLength(1)
  expect(results.filter(result => !result.ok)[0].error).toContain('already claimed')
  expect(results[0].pid).not.toBe(results[1].pid)
  const winner = results.find(result => result.ok)!.value!
  const crashing = child('delivery-crash', winner.acceptedBySessionId!)
  await crashing.ready; crashing.process.send('go')
  expect(await crashing.done).toEqual({ code: null, signal: 'SIGKILL' })
  const reader = child('read', 'reader')
  await reader.ready; reader.process.send('go')
  expect(await reader.done).toEqual({ code: 0, signal: null })
  expect(reader.result()?.value).toMatchObject({ delivery: 'uncertain', revision: 3, acceptedBySessionId: winner.acceptedBySessionId })
  expect(() => store.beginDelivery(record.projectKey, record.id, 3, winner.acceptedBySessionId!)).toThrow('not ready')
}, 20000)


it('does not adopt an unrelated database or silently recreate a missing handoff table', () => {
  const { root, store } = setup()
  const path = join(root, 'project-handoffs.sqlite')
  writeFileSync(path, '', { mode: 0o600 })
  const db = new DatabaseSync(path)
  try {
    db.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('keep')")
    expect(() => store.list(record.projectKey)).toThrow('Unrecognized')
    expect(db.prepare('SELECT value FROM unrelated').get()?.value).toBe('keep')
    db.exec('PRAGMA user_version=1')
    expect(() => store.list(record.projectKey)).toThrow('no such table')
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='handoffs'").get()).toBeUndefined()
  } finally { db.close() }
})

it.each(['create', 'get', 'accept', 'receive', 'acknowledge'] as const)('rejects a replaced checkout identity during handoff %s', async action => {
  const { root, store } = setup()
  let indexKey = 'old-checkout', captures = 0, lists = 0, authentications = 0, resolves = 0
  const scope = () => ({ projectKey: record.projectKey, projectPath: '/project', checkoutPath: '/project', indexKey })
  const receiver = { sessionId: 'receiver', workspacePath: '/project', liveness: 'live' } as RunningAgent
  const resolveScope = async () => {
    const current = scope()
    if (action === 'acknowledge' && ++resolves === 2) indexKey = 'replacement'
    return current
  }
  const service = new ProjectHandoffService(root, resolveScope, {
    handoffSource: async () => {
      if (['create', 'get'].includes(action) && ++captures === 1) indexKey = 'replacement'
      return { sourceRevision: record.sourceRevision, contentFingerprint: record.contentFingerprint, changedFiles: record.changedFiles }
    }
  }, { list: async () => {
    if (action === 'accept' && ++lists === 2) indexKey = 'replacement'
    return [receiver, { ...receiver, sessionId: record.fromSessionId }]
  } })
  const { taskId, fromSessionId, toAgent, goal, summary, openQuestions, nextSteps, evidenceIds } = record
  const draft = { taskId, fromSessionId, toAgent, goal, summary, openQuestions, nextSteps, evidenceIds }
  if (action !== 'create') store.create(record)
  if (action === 'receive' || action === 'acknowledge') store.accept(record.projectKey, record.id, 1, 'receiver', 'claim')
  if (action === 'acknowledge') store.beginDelivery(record.projectKey, record.id, 2, 'receiver')
  const before = store.list(record.projectKey)
  const authenticate = async () => { if (action === 'receive' && ++authentications === 2) indexKey = 'replacement'; return receiver }
  const credential = { runId: 'run', sessionId: 'receiver', token: 'fixture-only' }
  const result = action === 'create' ? service.projectHandoffCreate('/project', draft)
    : action === 'get' ? service.projectHandoffGet('/project', record.id)
    : action === 'accept' ? service.projectHandoffAccept('/project', record.id, 1, 'receiver', 'claim')
    : action === 'receive' ? service.receive(authenticate, credential, '/project', record.id, 2)
    : service.acknowledge(authenticate, credential, '/project', record.id, 3)
  await expect(result).rejects.toThrow('scope changed')
  expect(store.list(record.projectKey)).toEqual(before)
})

it('binds reviewed facts to project revisions and refuses changed, archived, erased, or foreign sources before claim and delivery', async () => {
  const { root } = setup()
  const { ProjectMemoryService } = await import('../src/main/project-memory')
  const memory = new ProjectMemoryService(root, async path => ({ projectKey: path === '/other' ? 'd'.repeat(64) : record.projectKey, projectPath: path }))
  const scope = { projectKey: record.projectKey, projectPath: '/project', checkoutPath: '/project', indexKey: 'checkout' }
  const receiver = { sessionId: 'receiver', workspacePath: '/project', liveness: 'live' } as RunningAgent
  const service = new ProjectHandoffService(root, async () => scope, { handoffSource: async () => ({ sourceRevision: record.sourceRevision, contentFingerprint: record.contentFingerprint, changedFiles: record.changedFiles }) }, { list: async () => [receiver, { ...receiver, sessionId: record.fromSessionId }] })
  const fact = await memory.projectMemoryCreate({ workspacePath: '/project', kind: 'fact', title: 'Reviewed source', content: 'Version one', attribution: { harness: 'human' } })
  const { taskId, fromSessionId, toAgent, goal, summary, openQuestions, nextSteps, evidenceIds } = record
  const draft = { taskId, fromSessionId, toAgent, goal, summary, openQuestions, nextSteps, evidenceIds, memorySources: [{ id: fact.id, revision: 1 }] }
  const handoff = await service.projectHandoffCreate('/project', draft)
  expect((await service.projectHandoffGet('/project', handoff.id)).memorySources?.[0]).toMatchObject({ state: 'current', revision: 1 })
  await memory.projectMemoryUpdate({ workspacePath: '/project', id: fact.id, expectedRevision: 1, kind: 'fact', title: fact.title, content: 'Version two', attribution: { harness: 'human' } })
  expect(await service.projectHandoffGet('/project', handoff.id)).toMatchObject({ stale: true, memorySources: [{ state: 'changed', current: { revision: 2 } }] })
  await expect(service.projectHandoffAccept('/project', handoff.id, 1, 'receiver', 'claim')).rejects.toThrow('source changed')
  await expect(service.projectHandoffCreate('/project', draft)).rejects.toThrow('Referenced memory changed')
  const fresh = await service.projectHandoffCreate('/project', { ...draft, memorySources: [{ id: fact.id, revision: 2 }] })
  await service.projectHandoffAccept('/project', fresh.id, 1, 'receiver', 'fresh-claim')
  await memory.projectMemoryArchive({ workspacePath: '/project', id: fact.id, expectedRevision: 2, archived: true, attribution: { harness: 'human' } })
  expect((await service.projectHandoffGet('/project', fresh.id)).memorySources?.[0].state).toBe('archived')
  await expect(service.receive(async () => receiver, { runId: 'run', sessionId: 'receiver', token: 'fixture' }, '/project', fresh.id, 2)).rejects.toThrow('source changed')
  expect((await service.projectHandoffGet('/project', fresh.id)).handoff.delivery).toBe('not-sent')
  await memory.projectMemoryErase({ workspacePath: '/project', id: fact.id, expectedRevision: 3 })
  expect((await service.projectHandoffGet('/project', fresh.id)).memorySources).toEqual([{ id: fact.id, revision: 2, state: 'unavailable' }])
  const foreign = await memory.projectMemoryCreate({ workspacePath: '/other', kind: 'fact', title: 'Foreign', content: 'Other project', attribution: { harness: 'human' } })
  await expect(service.projectHandoffCreate('/project', { ...draft, memorySources: [{ id: foreign.id, revision: 1 }] })).rejects.toThrow('unavailable')
  expect(() => parseProjectHandoff({ ...record, memorySources: [{ id: 'a', revision: 1 }, { id: 'a', revision: 1 }] })).toThrow('duplicate')
})
