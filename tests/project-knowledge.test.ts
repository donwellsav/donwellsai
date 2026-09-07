import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ProjectKnowledge } from '../src/main/project-knowledge'
import { ProjectMemoryService } from '../src/main/project-memory'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const projectKey = 'a'.repeat(64), path = '/project'
async function fixture() {
  const profile = mkdtempSync(join(tmpdir(), 'knowledge-')); roots.push(profile)
  const memory = new ProjectMemoryService(profile, async () => ({ projectKey, projectPath: path }))
  let entry = await memory.projectMemoryCreate({ workspacePath: path, kind: 'decision', title: 'Unique canonical title', content: 'Original private source content', tags: [], attribution: { harness: 'human' } })
  const banks = new Map<string, { document: string; operations: Set<string>; config: unknown }>()
  let failAcknowledgement = false, failDelete = false, unknownOperation = false, foreignReflection = false, changeDuringRecall = false
  const calls: string[] = []
  const update = async () => { entry = await memory.projectMemoryUpdate({ workspacePath: path, id: entry.id, expectedRevision: entry.revision, kind: 'decision', title: entry.title, content: 'Corrected source', tags: [], attribution: { harness: 'human' } }); return entry }
  const request = (async (url: string | URL | Request, init: RequestInit) => {
    const parts = new URL(String(url)).pathname.split('/'), bankId = parts[4], suffix = parts.slice(5).join('/'), method = init.method
    const body = init.body && !(init.body instanceof FormData) ? JSON.parse(String(init.body)) : undefined
    calls.push(method + ':' + suffix)
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
    if (!suffix && method === 'PUT') { banks.set(bankId, { document: '', operations: new Set(), config: {} }); return json({ bank_id: bankId }) }
    const bank = banks.get(bankId)!
    if (!suffix && method === 'DELETE') { if (failDelete) return new Response('', { status: 503 }); banks.delete(bankId); return json({ success: true }) }
    if (suffix === 'config') { if (method === 'PATCH') bank.config = body.updates; return json({ config: bank.config }) }
    if(suffix==='document-transfer'){
      expect(init.body).toBeInstanceOf(FormData)
      bank.document=createHash('sha256').update(JSON.stringify(['memory',entry.id,entry.revision])).digest('hex');bank.operations.add('native-import')
      if(failAcknowledgement){failAcknowledgement=false;throw new Error('Lost native import receipt')}
      return json({operation_id:'native-import'})
    }
    if(suffix==='operations')return json({bank_id:bankId,total:unknownOperation?0:1,operations:unknownOperation?[]:[{id:'native-import'}]})
    if (suffix.startsWith('operations/')) return json({ status: unknownOperation ? 'not_found' : 'completed', ...(suffix==='operations/native-import'?{result_metadata:{documents_imported:1,documents_skipped:0,facts_imported:1,remapped_document_ids:{}}}:{}) })
    if (suffix === 'memories') {
      bank.document = body.items[0].document_id; bank.operations.add(body.operation_id)
      if (failAcknowledgement) { failAcknowledgement = false; throw new Error('Connection lost after submission') }
      return json({ success: true, bank_id: bankId, async: true, operation_id: body.operation_id, items_count: 1 })
    }
    if (suffix === 'memories/recall') {
      if (changeDuringRecall) await update()
      return json({ results: [{ id: 'fact', text: 'Useful learned result', type: 'world', document_id: bank.document }, { id: 'foreign', text: 'WITHDRAWN TEXT', type: 'world', document_id: 'foreign' }] })
    }
    if (suffix === 'reflect') return json({ text: 'REFLECTION TEXT', based_on: { memories: [{ id: foreignReflection ? 'foreign' : 'fact' }] } })
    if (suffix.startsWith('memories/')) return json({ id: suffix.slice(9), type: 'world', state: 'active', document_id: suffix.endsWith('foreign') ? 'foreign' : bank.document })
    throw new Error('Unexpected request ' + suffix)
  }) as typeof fetch
  const owner = () => new ProjectKnowledge(profile, { enabled: true, endpoint: 'http://127.0.0.1:8888', model: 'reviewed-local-model' }, async () => ({ projectKey, projectPath: path, checkoutPath: path, indexKey: projectKey }), undefined, request)
  return { owner, profile, memory, update, calls, banks, selected: () => [{ kind: 'memory' as const, id: entry.id, revision: entry.revision }], set: (options: { failAcknowledgement?: boolean; failDelete?: boolean; unknownOperation?: boolean; foreignReflection?: boolean; changeDuringRecall?: boolean }) => { failAcknowledgement = options.failAcknowledgement ?? false; failDelete = options.failDelete ?? false; unknownOperation = options.unknownOperation ?? false; foreignReflection = options.foreignReflection ?? false; changeDuringRecall = options.changeDuringRecall ?? false } }
}
it('publishes selected revisions, excludes foreign text, and blocks corrected or erased sources across restart', async () => {
  const f = await fixture(), owner = f.owner()
  await owner.reconcile(path, f.selected())
  expect((await owner.recall(path, 'What decision?')).items).toEqual([expect.objectContaining({ text: 'Useful learned result' })])
  expect(await owner.recall(path, 'What decision?')).toMatchObject({ omitted: 1 })
  const ledger = readFileSync(join(f.profile, 'project-knowledge/projections.sqlite')).toString()
  expect(ledger).not.toContain('Original private source content')
  await f.update()
  const restarted = f.owner()
  expect((await restarted.status(path)).stale).toBe(true)
  await expect(restarted.recall(path, 'What decision?')).rejects.toThrow('stale')
  await restarted.reconcile(path, f.selected()); expect(f.banks.size).toBe(1)
  const source = f.selected()[0]
  await f.memory.projectMemoryErase({ workspacePath: path, id: source.id, expectedRevision: source.revision })
  await expect(restarted.reflect(path, 'What decision?')).rejects.toThrow('stale')
  await restarted.reconcile(path, []); expect(f.banks.size).toBe(1)
})
it('persists uncertain retain receipts and refuses answers until acknowledged cleanup succeeds', async () => {
  const f = await fixture(), owner = f.owner()
  f.set({ failAcknowledgement: true })
  await expect(owner.reconcile(path, f.selected())).rejects.toThrow('Connection lost')
  expect((await f.owner().status(path)).pendingCleanup).toBe(1)
  f.set({ unknownOperation: true })
  await expect(f.owner().reconcile(path, f.selected())).rejects.toThrow('uncertain')
  f.set({ failDelete: true })
  await expect(f.owner().reconcile(path, f.selected())).rejects.toThrow('503')
  await expect(f.owner().recall(path, 'query')).rejects.toThrow('cleanup')
  f.set({}); await f.owner().reconcile(path, f.selected())
  expect(f.banks.size).toBe(1)
  expect(f.calls.filter(call => call === 'POST:memories')).toHaveLength(2)
})
it('rejects an entire untraceable reflection and a response whose canonical source changes in flight', async () => {
  const f = await fixture(), owner = f.owner()
  await owner.reconcile(path, f.selected())
  f.set({ foreignReflection: true })
  await expect(owner.reflect(path, 'query')).rejects.toThrow('unknown source')
  f.set({ changeDuringRecall: true })
  await expect(owner.recall(path, 'query')).rejects.toThrow('changed')
  await owner.close()
  await expect(owner.reconcile(path, f.selected())).rejects.toThrow('stopped')
})

it('imports learned facts into the existing recall owner without extraction and recovers lost import receipts',async()=>{
  const f=await fixture(),owner=f.owner(),archive=Buffer.from([0x50,0x4b,0x03,0x04]).toString('base64')
  const imported=await owner.importTransfer(path,f.selected(),archive,1)
  expect(imported.stale).toBe(false)
  expect((await owner.recall(path,'Remember?')).items[0].text).toBe('Useful learned result')
  expect(f.calls).not.toContain('POST:memories')
  f.set({failAcknowledgement:true})
  await expect(owner.importTransfer(path,f.selected(),archive,1)).rejects.toThrow('Lost native import receipt')
  expect((await owner.status(path)).generation).toBe(imported.generation)
  f.set({unknownOperation:true})
  await expect(owner.importTransfer(path,f.selected(),archive,1)).rejects.toThrow('submission remains uncertain')
  f.set({})
  const next=await owner.importTransfer(path,f.selected(),archive,1)
  expect(next.pendingCleanup).toBe(0);expect(f.banks.size).toBe(1)
  await expect(owner.importTransfer(path,f.selected(),archive,2)).rejects.toThrow('count or identity')
  expect((await owner.status(path)).generation).toBe(next.generation)
})
