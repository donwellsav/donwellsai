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
