import { afterEach, expect, it, vi } from 'vitest'
import { WorktreeFiles } from '../src/main/worktree-files'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectDoctor } from '../src/main/project-doctor'
import { parseProjectToolConfiguration } from '../src/shared/project-doctor'

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
  for (const config of [{ command: 'sh' }, { token: 'secret' }, { browserExecutable: 'https://example.com' }, { computerBinary: '/tmp/a\ncommand' }, { disabled: ['unknown'] }, { referenceRoots: Array(16).fill('/tmp') }]) expect(() => parseProjectToolConfiguration(config)).toThrow()
  expect(parseProjectToolConfiguration({ referenceRoots: ['/tmp', '/tmp'], disabled: ['documents', 'documents'] })).toEqual({ referenceRoots: ['/tmp'], disabled: ['documents'] })
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
  await writeFile(report.configurationPath, '{"token":"do-not-expose",broken')
  const corrupt = await f.doctor.inspect(f.other)
  expect(corrupt.problem).toContain('Cannot read')
  expect(JSON.stringify(corrupt)).not.toContain('do-not-expose')
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
