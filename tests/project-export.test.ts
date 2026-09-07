import * as fs from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store, idFromPath } from '../src/main/store'
import { ProjectExport } from '../src/main/project-export'
import { ProjectMemoryService } from '../src/main/project-memory'
import { ProjectMemoryStore } from '../src/main/project-memory-store'
import { ProjectHandoffStore } from '../src/main/project-handoff'
import { resolveProjectToolScope } from '../src/main/project-tools'
import { migrateProjectMemory } from '../src/main/project-memory-migration'
import { parseCliArguments } from '../src/cli/arguments'
import { APP_WORKFLOW_FILES } from '../src/shared/project-creation'
import { WorktreeFiles } from '../src/main/worktree-files'

vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) }
})
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'project-kit-'))); roots.push(root)
  const source = join(root, 'source'), profile = join(root, 'profile'); await mkdir(source); await mkdir(profile)
  const store = new Store(profile), id = idFromPath(source)
  store.addRepo({ id, path: source, kind: 'folder', addedAt: new Date().toISOString() })
  const resolve = async (path: string) => { if (!store.listRepos().some(repo => repo.path === path)) throw new Error('Unregistered'); return { path, projectPath: path } }
  const scope = await resolveProjectToolScope(source, resolve)
  const memory = new ProjectMemoryService(profile, async path => { const { projectKey, projectPath } = await resolveProjectToolScope(path, resolve); return { projectKey, projectPath } })
  const request = { workspacePath: source, kind: 'fact' as const, title: 'Portable memory', content: 'KIT_CANARY_ONE', attribution: { harness: 'omp', sourceRef: 'api_key=secret-value' } }
  const first = await memory.projectMemoryCreate(request)
  await memory.projectMemoryUpdate({ ...request, id: first.id, expectedRevision: 1, content: 'KIT_CANARY_TWO password=secret-value' })
  const handoffs = new ProjectHandoffStore(profile)
  handoffs.create({ id: 'handoff-one', projectKey: scope.projectKey, taskId: null, fromSessionId: 'old-session', toAgent: 'hermes', checkoutPath: source, sourceRevision: null, contentFingerprint: 'sha256:' + 'a'.repeat(64), goal: 'Continue task', summary: 'password=secret-value', openQuestions: [], nextSteps: ['Recall KIT_CANARY_TWO'], changedFiles: [], evidenceIds: [], state: 'open', delivery: 'not-sent', revision: 1, acceptedBySessionId: null })
  store.setWorkspaceSession({ activeRepoId: id, repos: { [id]: { panes: { [source]: [{ key: 'term:old-session', kind: 'terminal', sessionId: 'old-session', label: 'password=secret-value' }, { key: 'browser', kind: 'browser', url: 'https://user:secret-value@example.org' }] }, activePane: {}, activeTerminal: {}, terminalOrder: {}, layouts: {}, activeWorktreePath: source } } })
  await writeFile(join(source, 'task.md'), 'Task receipt KIT_ARTIFACT password=secret-value')
  const doctor = { configuration: async () => ({ disabled: [], referenceRoots: ['/secret-value'], codeGraphBinary: '/secret-value/native' }) }
  const kit = new ProjectExport(profile, store, resolve, doctor)
  const output = join(root, 'kit.json')
  return { root, source, profile, store, resolve, scope, memory, first, kit, output, doctor }
}
async function editArchive(path: string, change: (kit: any) => void) {
  const value = JSON.parse(await readFile(path, 'utf8')); change(value)
  for (const key of Object.keys(value.payload)) value.checksums[key] = createHash('sha256').update(JSON.stringify(value.payload[key])).digest('hex')
  await writeFile(path, JSON.stringify(value))
}
it.each(['json', 'sqlite'])('restores %s memory with history, stale handoffs, disabled tools and a portable layout into another clean profile', async backend => {
  const f = await fixture(); if (backend === 'sqlite') migrateProjectMemory(f.profile)
  const originalHandoffs = new ProjectHandoffStore(f.profile)
  originalHandoffs.accept(f.scope.projectKey, 'handoff-one', 1, 'old-receiver', 'claim')
  originalHandoffs.beginDispatch(f.scope.projectKey, 'handoff-one', 2)
  const exported = await f.kit.projectKitExport(f.source, f.output, ['task.md'])
  expect(exported).toMatchObject({ memories: 1, revisions: 1, handoffs: 1 })
  const bytes = await readFile(f.output, 'utf8'); expect(bytes).not.toContain('secret-value'); expect(bytes).not.toContain(f.root); expect(bytes).not.toContain('old-session')
  expect((await stat(f.output)).mode & 0o077).toBe(0)
  const targetProfile = join(f.root, 'clean-profile'); await mkdir(targetProfile)
  if (backend === 'sqlite') migrateProjectMemory(targetProfile)
  const targetStore = new Store(targetProfile)
  const resolve = async (path: string) => { if (!targetStore.listRepos().some(repo => repo.path === path)) throw new Error('Unregistered'); return { path, projectPath: path } }
  const targetKit = new ProjectExport(targetProfile, targetStore, resolve, f.doctor)
  const destination = join(f.root, 'restored'), imported = await targetKit.projectKitImport(f.output, destination, exported.sha256, exported.sourceProjectKey)
  const restored = new ProjectMemoryService(targetProfile, async path => { const { projectKey, projectPath } = await resolveProjectToolScope(path, resolve); return { projectKey, projectPath } })
  const found = await restored.projectMemoryList({ workspacePath: destination, query: 'KIT_CANARY_TWO' })
  expect(found.entries).toHaveLength(1); expect(found.entries[0].id).not.toBe(f.first.id)
  expect((await restored.projectMemoryHistory({ workspacePath: destination, id: found.entries[0].id })).revisions.map(value => value.content)).toEqual(['KIT_CANARY_TWO password=[redacted]', 'KIT_CANARY_ONE'])
  const handoffs = new ProjectHandoffStore(targetProfile).list(imported.report.projectKey)
  expect(handoffs[0].dispatch).toBeUndefined()
  expect(handoffs[0]).toMatchObject({ state: 'superseded', delivery: 'not-sent', checkoutPath: destination, contentFingerprint: 'sha256:' + '0'.repeat(64) })
  expect(await readFile(join(destination, 'task.md'), 'utf8')).toContain('KIT_ARTIFACT password=[redacted]')
  const config = JSON.parse(await readFile(join(targetProfile, 'project-tools/configuration', imported.report.projectKey, 'tools.json'), 'utf8'))
  expect(config.disabled).toHaveLength(6); expect(config.codeGraphBinary).toBeUndefined()
  const session = new Store(targetProfile).getWorkspaceSession()!.repos[imported.repo.id]
  expect(session.panes[destination]).toEqual([{ key: 'kit-pane-0', kind: 'terminal' }, { key: 'kit-pane-1', kind: 'browser' }])
  expect(await targetKit.projectKitReport(destination)).toEqual(imported.report)
  await expect(targetKit.projectKitImport(f.output, destination, exported.sha256, exported.sourceProjectKey)).rejects.toThrow('already registered')
  expect(new Store(targetProfile).listRepos()).toHaveLength(1)
})
it('refuses damaged archives, duplicate IDs, path traversal, collisions and changed identity before creating a destination', async () => {
  const f = await fixture(); const exported = await f.kit.projectKitExport(f.source, f.output, [])
  const original = await readFile(f.output), destination = join(f.root, 'must-not-exist')
  await expect(f.kit.projectKitImport(f.output, destination, 'wrong', exported.sourceProjectKey)).rejects.toThrow('changed')
  await expect(f.kit.projectKitImport(f.output, destination, exported.sha256, 'b'.repeat(64))).rejects.toThrow('identity')
  for (const change of [
    (k: any) => k.payload.memory.entries.push(k.payload.memory.entries[0]),
    (k: any) => k.payload.handoffs.push(k.payload.handoffs[0]),
    (k: any) => k.payload.artifacts.push({ path: '../escape', content: 'no' }),
    (k: any) => k.payload.artifacts.push({ path: 'A', content: '' }, { path: 'a/child', content: '' }),
    (k: any) => k.payload.artifacts.push({ path: '.env', content: 'secret' }),
    (k: any) => k.payload.layout.panes.push(k.payload.layout.panes[0])
  ]) {
    await writeFile(f.output, original); await editArchive(f.output, change)
    await expect(f.kit.projectKitPreview(f.output)).rejects.toThrow()
  }
  await writeFile(f.output, '{bad')
  await expect(f.kit.projectKitPreview(f.output)).rejects.toThrow('invalid JSON')
  await writeFile(f.output, original.toString().replace('KIT_CANARY_ONE', 'CORRUPTED'))
  await expect(f.kit.projectKitPreview(f.output)).rejects.toThrow('checksum')
  await expect(stat(destination)).rejects.toThrow()
})
it('keeps existing destinations and exports unchanged, cleans interrupted export, and refuses symlink artifacts', async () => {
  const f = await fixture(), exported = await f.kit.projectKitExport(f.source, f.output, [])
  const before = await readFile(f.output)
  await expect(f.kit.projectKitExport(f.source, f.output, [])).rejects.toThrow()
  expect(await readFile(f.output)).toEqual(before)
  await expect(f.kit.projectKitImport(f.output, f.source, exported.sha256, exported.sourceProjectKey)).rejects.toThrow('already registered')
  const other = join(f.root, 'existing'); await mkdir(other); await writeFile(join(other, 'keep'), 'untouched')
  await expect(f.kit.projectKitImport(f.output, other, exported.sha256, exported.sourceProjectKey)).rejects.toThrow()
  expect(await readFile(join(other, 'keep'), 'utf8')).toBe('untouched')
  await symlink(f.output, join(f.source, 'linked.txt'))
  await expect(f.kit.projectKitExport(f.source, join(f.root, 'bad.json'), ['linked.txt'])).rejects.toThrow()
  // Failure after staging bytes but before publication must not leave an apparently complete archive.
  await expect(f.kit.projectKitExport(f.source, join(f.root, 'absent-parent', 'kit.json'), [])).rejects.toThrow()
  expect((await readdir(f.root)).filter(name => name.startsWith('.project-kit-'))).toEqual([])
})
it.each(['json', 'sqlite'])('rolls back only the new %s authority data when final activation fails', async backend => {
  const f = await fixture(); if (backend === 'sqlite') migrateProjectMemory(f.profile)
  const exported = await f.kit.projectKitExport(f.source, f.output, [])
  const before = new ProjectMemoryStore(f.profile).exportProject(f.scope), destination = join(f.root, 'failed')
  vi.spyOn(f.store, 'addImportedRepo').mockImplementationOnce(() => { throw new Error('disk full') })
  await expect(f.kit.projectKitImport(f.output, destination, exported.sha256, exported.sourceProjectKey)).rejects.toThrow('did not finish')
  expect(f.store.listRepos()).toHaveLength(1)
  expect(new ProjectMemoryStore(f.profile).exportProject(f.scope)).toEqual(before)
  const scope = await resolveProjectToolScope(destination, async () => ({ path: destination, projectPath: destination }))
  expect(new ProjectMemoryStore(f.profile).exportProject(scope).entries).toEqual([])
  expect(new ProjectHandoffStore(f.profile).list(scope.projectKey)).toEqual([])
  expect(await readFile(join(destination, '.donwells-restore-incomplete'), 'utf8')).toContain(exported.archiveId)
})
it('fails a selected artifact write before activation and reports unsupported tools without executing them', async () => {
  const f = await fixture(); await f.kit.projectKitExport(f.source, f.output, ['task.md'])
  await editArchive(f.output, k => k.payload.tools.push({ id: 'future-tool', version: '99', configured: true, enabled: true }))
  const preview = await f.kit.projectKitPreview(f.output)
  expect(preview.warnings).toContain('Unsupported tool version: future-tool 99')
  vi.spyOn(WorktreeFiles.prototype, 'createWorkspaceEntry').mockRejectedValueOnce(new Error('permission denied'))
  await expect(f.kit.projectKitImport(f.output, join(f.root, 'failed'), preview.sha256, preview.sourceProjectKey)).rejects.toThrow('did not finish')
  expect(f.store.listRepos()).toHaveLength(1)
})
it('routes CLI kit arguments through the existing validated catalog', () => {
  expect(parseCliArguments(['project-kit-export', '--params', '{"workspacePath":"/project","outputPath":"/output.json","artifacts":"docs/plan.md\\nbacklog/tasks/task-1.md"}']).params).toEqual({ workspacePath: '/project', outputPath: '/output.json', artifacts: 'docs/plan.md\nbacklog/tasks/task-1.md' })
  expect(parseCliArguments(['project-kit-import', '/kit.json', '/new-project', 'a'.repeat(64), 'b'.repeat(64)]).command?.method).toBe('project.kit.import')
  expect(parseCliArguments(['project-kit-export', '/project', '/output.json', '--include-learned']).params.includeLearned).toBe(true)
})

it('cleans a partially written export when flushing fails before publication', async () => {
  const f = await fixture()
  vi.mocked(fs.fsyncSync).mockImplementationOnce(() => { throw new Error('interrupted flush') })
  await expect(f.kit.projectKitExport(f.source, f.output, [])).rejects.toThrow('interrupted flush')
  await expect(stat(f.output)).rejects.toThrow()
  expect((await readdir(f.root)).filter(name => name.startsWith('.project-kit-'))).toEqual([])
})
it('redacts quoted credential assignments in retained history and selected text artifacts', async () => {
  const f = await fixture()
  await writeFile(join(f.source, 'receipt.txt'), '\"api_key\": \"DO_NOT_EXPORT\", \"password\": \"OTHER_SECRET\"')
  await f.kit.projectKitExport(f.source, f.output, ['receipt.txt'])
  const bytes = await readFile(f.output, 'utf8')
  expect(bytes).not.toContain('DO_NOT_EXPORT'); expect(bytes).not.toContain('OTHER_SECRET')
})

it('refreshes an existing JSON reader after import and preserves its pending layout against an older renderer save', async () => {
  const f = await fixture(), saved = f.store.getWorkspaceSession()!
  const kit = new ProjectExport(f.profile, f.store, f.resolve, f.doctor, () => f.memory.reloadStorage())
  const exported = await kit.projectKitExport(f.source, f.output, [])
  const result = await kit.projectKitImport(f.output, join(f.root, 'second'), exported.sha256, exported.sourceProjectKey)
  expect((await f.memory.projectMemoryList({ workspacePath: result.repo.path, query: 'KIT_CANARY_TWO' })).entries).toHaveLength(1)
  f.store.setWorkspaceSession(saved)
  expect(f.store.getWorkspaceSession()!.repos[result.repo.id].panes[result.repo.path]).toHaveLength(2)
})

it('rejects oversized or linked archive inputs and oversized selected artifacts', async () => {
  const f = await fixture()
  await writeFile(f.output, ''); await truncate(f.output, 32 * 1024 * 1024 + 1)
  await expect(f.kit.projectKitPreview(f.output)).rejects.toThrow('32 MiB')
  await writeFile(f.output, '{}'); const link = join(f.root, 'linked-kit.json'); await symlink(f.output, link)
  await expect(f.kit.projectKitPreview(link)).rejects.toThrow()
  await writeFile(join(f.source, 'large.txt'), 'x'.repeat(512 * 1024 + 1))
  await expect(f.kit.projectKitExport(f.source, join(f.root, 'large-kit.json'), ['large.txt'])).rejects.toThrow('bounded UTF-8')
})

it.each(['json', 'sqlite'])('maps %s fact, tombstone and handoff identities consistently and preserves original origin through re-export', async backend => {
  const f = await fixture()
  const erased = await f.memory.projectMemoryCreate({ workspacePath: f.source, kind: 'fact', title: 'Erase me', content: 'ERASED_KIT_CONTENT', attribution: { harness: 'human' } })
  if (backend === 'sqlite') migrateProjectMemory(f.profile)
  const memory = new ProjectMemoryService(f.profile, async () => ({ projectKey: f.scope.projectKey, projectPath: f.scope.projectPath }))
  await memory.projectMemoryErase({ workspacePath: f.source, id: erased.id, expectedRevision: 1 })
  const handoffs = new ProjectHandoffStore(f.profile)
  handoffs.create({ ...handoffs.list(f.scope.projectKey)[0], id: 'linked-handoff', memorySources: [{ id: f.first.id, revision: 2 }, { id: erased.id, revision: 1 }, { id: 'absent-fact', revision: 1 }] })
  const exported = await f.kit.projectKitExport(f.source, f.output, [])
  expect(exported.schemaVersion).toBe(3)
  expect(exported.erasedMemories).toBe(1)
  expect(exported.warnings.some(text => text.includes(erased.id) && text.includes('will not be restored'))).toBe(true)
  expect(exported.warnings.some(text => text.includes('absent-fact'))).toBe(true)
  expect(await readFile(f.output, 'utf8')).not.toContain('ERASED_KIT_CONTENT')
  const restored = await f.kit.projectKitImport(f.output, join(f.root, 'mapped'), exported.sha256, exported.sourceProjectKey)
  const map = restored.report.identityMapping!
  const factId = map.find(ref => ref.kind === 'memory' && ref.id === f.first.id)!.targetId
  const erasedId = map.find(ref => ref.kind === 'memory' && ref.id === erased.id)!.targetId
  expect(erasedId).not.toBe(erased.id)
  const scoped = { projectKey: restored.report.projectKey, projectPath: restored.repo.path }
  const saved = new ProjectMemoryStore(f.profile).exportProject(scoped)
  expect(saved.entries[0].current.id).toBe(factId)
  expect(saved.erased).toEqual([{ id: erasedId, revision: 1, erasedAt: expect.any(String) }])
  const handoffId = map.find(ref => ref.kind === 'handoff' && ref.id === 'linked-handoff')!.targetId
  expect(new ProjectHandoffStore(f.profile).get(scoped.projectKey, handoffId)).toMatchObject({ state: 'superseded', memorySources: [{ id: factId, revision: 2 }] })
  const nextPath = join(f.root, 'reexport.json')
  await f.kit.projectKitExport(restored.repo.path, nextPath, [])
  const next = JSON.parse(await readFile(nextPath, 'utf8'))
  expect(next.payload.references.find((ref: any) => ref.id === factId)).toEqual({ kind: 'memory', id: factId, originalProjectKey: f.scope.projectKey, originalId: f.first.id })
  expect(next.payload.references.find((ref: any) => ref.id === erasedId)).toEqual({ kind: 'memory', id: erasedId, originalProjectKey: f.scope.projectKey, originalId: erased.id })
  expect(new ProjectMemoryStore(f.profile).exportProject(f.scope).entries[0].current.id).toBe(f.first.id)
})

it('converts v1 explicitly and rejects incomplete v2 reference maps before restore', async () => {
  const f = await fixture()
  await f.kit.projectKitExport(f.source, f.output, [])
  const original = await readFile(f.output)
  await editArchive(f.output, kit => { kit.payload.references.pop() })
  await expect(f.kit.projectKitPreview(f.output)).rejects.toThrow('reference map is incomplete')
  await writeFile(f.output, original)
  await editArchive(f.output, kit => { kit.schemaVersion = 1; delete kit.payload.references; delete kit.checksums.references; delete kit.payload.knowledge; delete kit.checksums.knowledge })
  const preview = await f.kit.projectKitPreview(f.output)
  expect(preview.schemaVersion).toBe(1)
  expect(preview.warnings.some(text => text.includes('Version 1 kit will be converted'))).toBe(true)
  const restored = await f.kit.projectKitImport(f.output, join(f.root, 'legacy'), preview.sha256, preview.sourceProjectKey)
  expect(restored.report.identityMapping).toHaveLength(2)
  expect(restored.report.identityMapping?.find(ref => ref.kind === 'memory')).toMatchObject({ id: f.first.id, originalId: f.first.id, originalProjectKey: f.scope.projectKey })
})

it('round-trips learned facts, canonical source mappings and explicit workflow files without enabling services', async () => {
  const f=await fixture(), documentId='d'.repeat(64)
  const knowledge={hindsight:{transferSchemaRevision:'e'.repeat(40),exportedAt:new Date().toISOString(),model:'local-model',sources:[{kind:'memory',id:f.first.id,revision:2,projectKey:f.scope.projectKey,sourceTime:null,documentId}],documents:[{id:documentId,original_text:'Source text',retain_params:{credential:'secret-value'},tags:[],chunks:[{chunk_index:0,chunk_text:'Source text'}],facts:[{text:'Learned relationship',fact_type:'world',metadata:{credential:'secret-value'},chunk_index:0,entities:['Project'],causal_relations:[]}]}]},temporal:[{kind:'memory',id:f.first.id,revision:2}],settings:{documentRetrievalMode:'hybrid',hindsightModel:'local-model'}}
  await mkdir(join(f.source,'donwells-import')); await writeFile(join(f.source,'donwells-import/knowledge.json'),JSON.stringify(knowledge))
  await mkdir(join(f.source,'.github/workflows'),{recursive:true});await writeFile(join(f.source,'.github/workflows/check.yml'),'name: check\non: workflow_dispatch\n')
  const workflowPath='.agents/skills/app-workflow/SKILL.md'
  await mkdir(join(f.source,'.agents/skills/app-workflow'),{recursive:true});await writeFile(join(f.source,workflowPath),APP_WORKFLOW_FILES[workflowPath])
  for(const rejected of ['.agents/skills/other/SKILL.md','.agents/skills/app-workflow/.env','.agents/skills/app-workflow/../secrets'])await expect(f.kit.projectKitExport(f.source,f.output,[rejected])).rejects.toThrow('relative, non-secret')
  const exported=await f.kit.projectKitExport(f.source,f.output,['.github/workflows/check.yml',workflowPath])
  expect(exported).toMatchObject({schemaVersion:3,learnedFacts:1,temporalSources:1})
  expect(await readFile(f.output,'utf8')).not.toContain('secret-value')
  const destination=join(f.root,'learned-restored'), imported=await f.kit.projectKitImport(f.output,destination,exported.sha256,exported.sourceProjectKey)
  const restored=JSON.parse(await readFile(join(destination,'donwells-import/knowledge.json'),'utf8'))
  const ref=restored.hindsight.sources[0]
  expect(ref.id).not.toBe(f.first.id);expect(ref.projectKey).toBe(imported.report.projectKey)
  expect(restored.temporal[0].id).toBe(ref.id);expect(restored.hindsight.documents[0].id).toBe(ref.documentId)
  expect(restored.hindsight.documents[0].facts[0].text).toBe('Learned relationship')
  expect(restored.hindsight.documents[0].facts[0].metadata).toEqual({})
  expect(await readFile(join(destination,'.github/workflows/check.yml'),'utf8')).toContain('workflow_dispatch')
  expect(await readFile(join(destination,workflowPath),'utf8')).toBe(APP_WORKFLOW_FILES[workflowPath])
  const again=join(f.root,'again.json');await f.kit.projectKitExport(destination,again,[])
  const roundTrip=JSON.parse(await readFile(again,'utf8'))
  expect(roundTrip.payload.knowledge.hindsight.documents).toEqual(restored.hindsight.documents)
  expect(roundTrip.payload.references.find((v:any)=>v.id===ref.id)).toMatchObject({originalId:f.first.id,originalProjectKey:f.scope.projectKey})
  await f.memory.projectMemoryErase({workspacePath:f.source,id:f.first.id,expectedRevision:2})
  await expect(f.kit.projectKitExport(f.source,join(f.root,'erased.json'),[])).rejects.toThrow(/absent or erased/)
})

it('rejects a learned causal edge or chunk reference that cannot survive restore', async () => {
  const f=await fixture();await f.kit.projectKitExport(f.source,f.output,[])
  const base=JSON.parse(await readFile(f.output,'utf8')),documentId='d'.repeat(64)
  for(const bad of [{chunk_index:42},{causal_relations:[{relation_type:'causes',target_fact_index:42}]}]){
    await writeFile(f.output,JSON.stringify(base))
    await editArchive(f.output,kit=>{kit.payload.knowledge.hindsight={transferSchemaRevision:'e'.repeat(40),exportedAt:new Date().toISOString(),model:'local',sources:[{kind:'memory',id:f.first.id,revision:2,projectKey:f.scope.projectKey,sourceTime:null,documentId}],documents:[{id:documentId,chunks:[],facts:[{text:'fact',fact_type:'world',...bad}]}]}})
    await expect(f.kit.projectKitPreview(f.output)).rejects.toThrow(/absent/)
  }
})
