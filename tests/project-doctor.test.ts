import { afterEach, expect, it, vi } from 'vitest'
import { WorktreeFiles } from '../src/main/worktree-files'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectDoctor, measureProjectToolPath } from '../src/main/project-doctor'
import { parseProjectToolConfiguration, projectDoctorDiagnostics, projectToolSetupStatus } from '../src/shared/project-doctor'

const roots: string[] = [], doctors: ProjectDoctor[] = []
afterEach(async () => { await Promise.all(doctors.splice(0).map(doctor => doctor.close())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'donwells-doctor-'))); roots.push(root)
  const project = join(root, 'project'), linked = join(root, 'linked'), other = join(root, 'other')
  for (const path of [project, linked, other]) await mkdir(path)
  const script = join(root, 'tool.cjs'), counter = join(root, 'starts')
  await writeFile(script, `const fs=require('node:fs'); fs.appendFileSync(process.argv[2],'start\\n'); require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;const result=m.method==='initialize'?{protocolVersion:'2025-11-25',serverInfo:{version:'1'},capabilities:{tools:{}}}:m.method==='tools/list'?{tools:[{name:'status'}]}:{content:[]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')})`)
  let fail = false, checks = 0
  const doctor = new ProjectDoctor(join(root, 'config'), async path => {
    if (![project, linked, other].includes(path)) throw new Error('Unregistered project')
    return { path, projectPath: path === linked ? project : path }
  }, () => ({ referenceRoots: [], disabled: [] }), () => [{ id: 'documents', version: '1', scope: 'checkout', prepare: async () => { checks++; if (fail) throw new Error('Native readiness failed') }, launch: () => ({ program: process.execPath, args: [script, counter] }), operations: { status: { tool: 'status', readOnly: true, parameters: {}, targets: () => ({}) } } }])
  doctors.push(doctor)
  return { doctor, project, linked, other, root, counter, fail: (value: boolean) => { fail = value }, checks: () => checks }
}

it('validates only integrated local fields and rejects commands, credentials and unbounded roots', () => {
  for (const config of [{ command: 'sh' }, { token: 'secret' }, { browserExecutable: 'https://example.com' }, { computerBinary: '/tmp/a\ncommand' }, { disabled: ['unknown'] }, { referenceRoots: Array(16).fill('/tmp') }, { documentRetrievalMode: ['auto'] }, { documentRetrievalMode: 'remote' }]) expect(() => parseProjectToolConfiguration(config)).toThrow()
  expect(parseProjectToolConfiguration({ documentRetrievalMode: 'lexical' }).documentRetrievalMode).toBe('lexical')
  expect(parseProjectToolConfiguration({ historyHermesRoots: ['/tmp/hermes', '/tmp/hermes'], historyKimiRoots: ['/tmp/kimi'] })).toMatchObject({ historyHermesRoots: ['/tmp/hermes'], historyKimiRoots: ['/tmp/kimi'] })
  expect(parseProjectToolConfiguration({ referenceRoots: ['/tmp', '/tmp'], disabled: ['documents', 'documents'] })).toEqual({ referenceRoots: ['/tmp'], disabled: ['documents'] })
})

it('saves configuration through a symlinked app data directory', async () => {
  const f = await fixture(), actual = join(f.root, 'actual'), alias = join(f.root, 'alias')
  await mkdir(actual); await symlink(actual, alias)
  const doctor = new ProjectDoctor(alias, async path => ({ path, projectPath: path }), () => ({ referenceRoots: [], disabled: [] }), () => [])
  doctors.push(doctor)
  const saved = await doctor.configure(f.project, { documentRetrievalMode: 'lexical' }, null)
  expect(saved.configuration.documentRetrievalMode).toBe('lexical')
  expect(saved.configurationPath.startsWith(actual + '/')).toBe(true)
  const updated = await doctor.configure(f.project, { documentRetrievalMode: 'hybrid' }, saved.revision)
  expect(updated.configuration.documentRetrievalMode).toBe('hybrid')
  expect(updated.backups).toHaveLength(1)
})

it('does not launch on inspection and shares reversible configuration only within the registered project', async () => {
  const f = await fixture(), report = await f.doctor.inspect(f.project)
  await expect(readFile(f.counter)).rejects.toThrow()
  const saved = await f.doctor.configure(f.linked, { ...report.configuration, codeGraphBinary: '/missing/native' }, report.revision)
  expect((await f.doctor.inspect(f.project)).revision).toBe(saved.revision)
  expect((await f.doctor.inspect(f.other)).configuration.codeGraphBinary).toBeUndefined()
  expect(saved.resources).toContainEqual({ field: 'codeGraphBinary', bytes: null, problem: 'Missing path' })
  await f.doctor.configure(f.project, { ...saved.configuration, disabled: ['documents'] }, saved.revision)
  const backups = (await readdir(join(saved.configurationPath, '..'))).filter(name => name.startsWith('tools-backup-'))
  expect(backups).toHaveLength(1)
  expect(JSON.parse(await readFile(join(saved.configurationPath, '..', backups[0]!), 'utf8'))).toEqual(saved.configuration)
  await expect(f.doctor.start(f.project, 'documents')).rejects.toThrow('not admitted')
  await expect(f.doctor.configure(f.project, report.configuration, saved.revision)).rejects.toThrow('changed')
  await expect(f.doctor.inspect(f.root)).rejects.toThrow('Unregistered')
})

it('stops every owned checkout before applying settings and leaves another project running', async () => {
  const f = await fixture()
  await f.doctor.start(f.project, 'documents'); await f.doctor.start(f.linked, 'documents'); await f.doctor.start(f.other, 'documents')
  const report = await f.doctor.inspect(f.project)
  await f.doctor.configure(f.project, report.configuration, report.revision)
  expect((await f.doctor.list(f.project))[0]!.status).toBe('stopped')
  expect((await f.doctor.list(f.linked))[0]!.status).toBe('stopped')
  expect((await f.doctor.list(f.other))[0]!.status).toBe('ready')
})

it('retries the actual readiness operation after failure and reports corrupt configuration without exposing its contents', async () => {
  const f = await fixture()
  f.fail(true)
  await expect(f.doctor.start(f.project, 'documents')).rejects.toThrow('readiness')
  expect(f.checks()).toBe(1)
  f.fail(false); await f.doctor.retry(f.project, 'documents')
  expect(f.checks()).toBe(2)
  const report = await f.doctor.inspect(f.other)
  await f.doctor.start(f.other, 'documents')
  await writeFile(report.configurationPath, '{"token":"do-not-expose",broken')
  const corrupt = await f.doctor.inspect(f.other)
  expect(corrupt.problem).toContain('Cannot read')
  expect(JSON.stringify(corrupt)).not.toContain('do-not-expose')
  await f.doctor.stop(f.other, 'documents')
  await expect(f.doctor.configure(f.other, report.configuration, null)).rejects.toThrow()
  expect(await readFile(report.configurationPath, 'utf8')).toContain('do-not-expose')
})

it('blocks stale runtime configuration after external edits and applies only the revision reviewed by the operator', async () => {
  const f = await fixture(), initial = await f.doctor.inspect(f.project)
  const saved = await f.doctor.configure(f.project, initial.configuration, null)
  await f.doctor.start(f.project, 'documents')
  await writeFile(saved.configurationPath, JSON.stringify({ ...saved.configuration, disabled: ['documents'] }))
  const changed = await f.doctor.inspect(f.project)
  expect(changed.problem).toContain('changed on disk')
  await expect(f.doctor.call(f.project, 'documents', 'status', {})).rejects.toThrow('changed on disk')
  await expect(f.doctor.configure(f.project, saved.configuration, saved.revision)).rejects.toThrow('changed')
  expect((await f.doctor.configure(f.project, changed.configuration, changed.revision)).problem).toBeNull()
  await expect(f.doctor.start(f.project, 'documents')).rejects.toThrow('not admitted')
})

it.each(['ENOSPC', 'EACCES'])('preserves configuration when its real write operation fails with %s and retries that write', async code => {
  const f = await fixture(), initial = await f.doctor.inspect(f.project)
  const saved = await f.doctor.configure(f.project, initial.configuration, null)
  const before = await readFile(saved.configurationPath, 'utf8')
  const write = vi.spyOn(WorktreeFiles.prototype, 'writeFile').mockRejectedValueOnce(Object.assign(new Error('write failed'), { code }))
  try { await expect(f.doctor.configure(f.project, { ...saved.configuration, disabled: ['documents'] }, saved.revision)).rejects.toMatchObject({ code }) }
  finally { write.mockRestore() }
  expect(await readFile(saved.configurationPath, 'utf8')).toBe(before)
  const repaired = await f.doctor.configure(f.project, { ...saved.configuration, disabled: ['documents'] }, saved.revision)
  expect(repaired.configuration.disabled).toEqual(['documents'])
})

it('waits for an in-flight configuration write before shutdown completes', async () => {
  const f = await fixture(), initial = await f.doctor.inspect(f.project)
  const saved = await f.doctor.configure(f.project, initial.configuration, null)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const original = WorktreeFiles.prototype.writeFile
  const write = vi.spyOn(WorktreeFiles.prototype, 'writeFile').mockImplementationOnce(async function (...args) { entered.resolve(); await release.promise; return original.apply(this, args) })
  const applying = f.doctor.configure(f.project, { ...saved.configuration, disabled: ['documents'] }, saved.revision)
  const outcome = applying.catch(() => null)
  await entered.promise
  let closed = false
  const closing = f.doctor.close().then(() => { closed = true })
  try { await new Promise(resolve => setTimeout(resolve, 20)); expect(closed).toBe(false) }
  finally { release.resolve(); await outcome; await closing; write.mockRestore() }
  expect(JSON.parse(await readFile(saved.configurationPath, 'utf8')).disabled).toEqual(['documents'])
})

it.skipIf(!process.env.DONWELLS_HISTORY_BINARY)('configures native history, retains its archive on disable and restores the selected roots after restart', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'doctor-native-history-'))); roots.push(root)
  const project = await realpath('/tmp/donwells-strengthen-27-native/project'), foreign = join(root, 'foreign-project')
  await mkdir(foreign)
  const create = () => {
    const doctor = new ProjectDoctor(root, async path => { const canonical = await realpath(path); if (![project, foreign].includes(canonical)) throw new Error('Unregistered'); return { path: canonical, projectPath: canonical } }, () => ({ referenceRoots: [], disabled: [] }), () => [])
    doctors.push(doctor); return doctor
  }
  const doctor = create(), initial = await doctor.inspect(project)
  const selected = await doctor.configure(project, { ...initial.configuration, historyBinary: process.env.DONWELLS_HISTORY_BINARY, historyOmpRoots: ['/tmp/donwells-strengthen-27-native'], historyDshRoots: ['/tmp/donwells-strengthen-09-dsh-ornith-home/sessions'] }, null)
  await doctor.configure(foreign, selected.configuration, null)
  await Promise.all([doctor.historyIndex(project), doctor.historyIndex(foreign)])
  expect((await doctor.historySearch(foreign, 'HISTORY_ORNITH_27')).hits).toEqual([])
  expect((await doctor.historySearch(project, 'HISTORY_ORNITH_27')).hits.length).toBeGreaterThan(0)
  expect((await doctor.historySearch(project, 'HISTORY_DSH_27')).hits.length).toBeGreaterThan(0)
  const disabled = await doctor.configure(project, { ...selected.configuration, disabled: ['history'] }, selected.revision)
  await expect(doctor.historySearch(project, 'HISTORY_ORNITH_27')).rejects.toThrow('enable')
  await doctor.close()
  const restarted = create(), restored = await restarted.inspect(project)
  expect(restored.revision).toBe(disabled.revision)
  expect(restored.configuration.historyOmpRoots).toEqual(selected.configuration.historyOmpRoots)
  await restarted.configure(project, { ...restored.configuration, disabled: [] }, restored.revision)
  // Re-enable reads the retained derived archive without reindexing or a daemon.
  expect((await restarted.historySearch(project, 'HISTORY_ORNITH_27')).hits.length).toBeGreaterThan(0)
}, 60000)

it('refuses a non-admitted history executable before running it', async () => {
  const f = await fixture(), report = await f.doctor.inspect(f.project)
  await f.doctor.configure(f.project, { ...report.configuration, historyBinary: process.execPath }, null)
  await expect(f.doctor.historyIndex(f.project)).rejects.toThrow('admitted AgentsView')
  await f.doctor.stop(f.project, 'history')
})

it('previews a confined backup, repairs corrupt JSON with a revision check and preserves the damaged bytes', async () => {
  const f = await fixture(), initial = await f.doctor.inspect(f.project)
  const first = await f.doctor.configure(f.project, { ...initial.configuration, codeGraphBinary: '/saved/tool' }, null)
  const next = await f.doctor.configure(f.project, { ...first.configuration, disabled: ['documents'] }, first.revision)
  const backup = next.backups[0]!.name
  expect(await f.doctor.previewBackup(f.project, backup)).toEqual(first.configuration)
  await expect(f.doctor.previewBackup(f.other, backup)).rejects.toThrow('no longer exists')
  await expect(f.doctor.previewBackup(f.project, '../tools.json')).rejects.toThrow('Invalid')
  const damaged = '{"token":"never-print-this", broken'
  await writeFile(first.configurationPath, damaged)
  const corrupt = await f.doctor.inspect(f.project)
  expect(corrupt.configurationValid).toBe(false)
  expect(corrupt.revision).toBeTruthy()
  await expect(f.doctor.start(f.project, 'documents')).rejects.not.toThrow('never-print-this')
  const restored = await f.doctor.configure(f.project, await f.doctor.previewBackup(f.project, backup), corrupt.revision)
  expect(restored.configuration).toEqual(first.configuration)
  expect(restored.configurationValid).toBe(true)
  const backups = await Promise.all(restored.backups.map(({ name }) => readFile(join(first.configurationPath, '..', name), 'utf8')))
  expect(backups).toContain(damaged)
  const damagedName = restored.backups[backups.indexOf(damaged)]!.name
  await expect(f.doctor.previewBackup(f.project, damagedName)).rejects.toThrow('invalid configuration')
})

it('exports diagnostic facts without native output, paths or credential-shaped text', async () => {
  const f = await fixture(), report = await f.doctor.inspect(f.project)
  const exported = projectDoctorDiagnostics({ ...report, problem: 'api_key=private-secret', configuration: { ...report.configuration, codeGraphBinary: '/private-secret/path' }, services: [{ id: 'documents', status: 'failed', version: null, detail: 'Bearer private-secret' }], resources: [{ field: 'codeGraphBinary', bytes: null, problem: 'private-secret' }] })
  expect(exported).not.toContain('private-secret')
  expect(exported).not.toContain(f.root)
  expect(JSON.parse(exported)).toMatchObject({ configurationNeedsAttention: true, resources: [{ field: 'codeGraphBinary', needsAttention: true }] })
})

it('measures selected package files without counting linked shared dependencies', async () => {
  const f = await fixture(), directory = join(f.root, 'package')
  await mkdir(directory); await writeFile(join(directory, 'index.js'), '12345')
  await mkdir(join(directory, 'assets')); await writeFile(join(directory, 'assets', 'data'), '123')
  await symlink(f.project, join(directory, 'shared-dependency'))
  await writeFile(join(f.project, 'external'), 'do not count this')
  expect(await measureProjectToolPath(directory)).toEqual({ bytes: 8, sizeKind: 'directory' })
  expect(await measureProjectToolPath(join(directory, 'index.js'))).toEqual({ bytes: 5, sizeKind: 'file' })
})

it('does not treat a dangling configuration link as an absent configuration', async () => {
  const f = await fixture(), report = await f.doctor.inspect(f.project)
  await symlink(join(f.root, 'missing-config'), report.configurationPath)
  expect((await f.doctor.inspect(f.project)).configurationValid).toBe(false)
  await expect(f.doctor.start(f.project, 'documents')).rejects.toThrow()
  await expect(readFile(f.counter)).rejects.toThrow()
})


it('reports saved engine state without treating partial setup or an unverified board as ready', async () => {
  const f = await fixture(), report = await f.doctor.inspect(f.project)
  expect(projectToolSetupStatus(report, 'documents')).toBe('stopped')
  const partial = { ...report, services: [], configuration: { ...report.configuration, qmdPackage: '/selected/qmd', backlogBinary: '/selected/backlog' } }
  expect(projectToolSetupStatus(partial, 'documents')).toBe('setup incomplete')
  expect(projectToolSetupStatus(partial, 'backlog')).toBe('configured · launch unverified')
  expect(projectToolSetupStatus(partial, 'code-graph')).toBe('not configured')
  const disabled = { ...report, configuration: { ...report.configuration, disabled: ['documents'] } }
  expect(projectToolSetupStatus(disabled, 'documents')).toBe('disabled')
  expect(JSON.parse(projectDoctorDiagnostics(disabled)).tools.find((tool: { id: string }) => tool.id === 'documents').status).toBe('disabled')
  expect(projectToolSetupStatus({ ...report, configurationValid: false }, 'documents')).toBe('configuration unreadable')
})
