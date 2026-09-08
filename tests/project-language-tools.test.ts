import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { ProjectLanguageTools } from '../src/main/project-language-tools'

const services: ProjectLanguageTools[] = []
const roots: string[] = []

it('uses the installed native TypeScript server for real diagnostics, definitions and edits', async () => {
  const root = process.cwd()
  await mkdir(join(root, 'out'), { recursive: true })
  const fixture = await mkdtemp(join(root, 'out/language-check-'))
  roots.push(fixture)
  await writeFile(join(fixture, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }))
  await writeFile(join(fixture, 'value.ts'), 'export const projectValue = "wrong"\n')
  const content = "import { projectValue } from './value'\nexport const result: number = projectValue\n"
  await writeFile(join(fixture, 'main.ts'), content)
  const service = new ProjectLanguageTools(async () => ({ checkoutPath: root, indexKey: root }))
  services.push(service)
  const input = { workspacePath: root, path: relative(root, join(fixture, 'main.ts')), version: 1, content }
  expect((await service.diagnostics(input)).diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 2322 })]))
  const column = content.split('\n')[1]!.lastIndexOf('projectValue') + 1
  expect((await service.definition(input, 2, column)).definitions).toEqual(expect.arrayContaining([expect.objectContaining({ path: relative(root, join(fixture, 'value.ts')) })]))
  expect((await service.references(input, 2, column)).references.length).toBeGreaterThan(1)
  expect((await service.diagnostics({ ...input, version: 2, content: content.replace(': number', ': string') })).diagnostics).toEqual([])
  const before = await service.inspect(root)
  expect((await service.restart(root)).generation).toBeGreaterThan(before.generation)
}, 30000)
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function languageProject() {
  const root = await mkdtemp(join(tmpdir(), 'donwells-language-'))
  roots.push(root)
  const packageRoot = join(root, 'node_modules/typescript')
  await mkdir(join(packageRoot, 'lib'), { recursive: true })
  await writeFile(join(root, 'package.json'), '{}')
  await writeFile(join(root, 'value.ts'), 'export const projectValue = "wrong"\n')
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'typescript', version: '5.9.3', exports: { './package.json': './package.json' } }))
  await writeFile(join(packageRoot, 'lib/tsserver.js'), String.raw`
const readline = require('node:readline')
require('node:fs').appendFileSync(process.cwd() + '/starts', 'x')
const send = value => { const body = JSON.stringify(value); process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body) }
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  let body = {}
  if (request.command === 'semanticDiagnosticsSync') body = [{ start: 44, length: 5, startLocation: { line: 2, offset: 14 }, endLocation: { line: 2, offset: 19 }, category: 'error', code: 2322, message: 'Type string is not assignable to type number.' }]
  if (request.command === 'definitionAndBoundSpan') body = { definitions: [{ file: process.cwd() + '/value.ts', start: { line: 1, offset: 14 }, end: { line: 1, offset: 26 } }] }
  if (request.command === 'references') body = { refs: [{ file: process.cwd() + '/main.ts', start: { line: 2, offset: 32 }, end: { line: 2, offset: 44 } }, { file: process.cwd() + '/value.ts', start: { line: 1, offset: 14 }, end: { line: 1, offset: 26 } }] }
  send({ seq: request.seq, type: 'response', request_seq: request.seq, success: true, command: request.command, body })
})
`)
  return root
}

it('uses the checkout TypeScript project for diagnostics and unopened-file definitions', async () => {
  const checkout = await languageProject()
  const service = new ProjectLanguageTools(async () => ({ checkoutPath: checkout, indexKey: checkout }))
  services.push(service)
  const content = "import { projectValue } from './value'\nexport const result: number = projectValue\n"
  const input = { workspacePath: checkout, path: 'main.ts', version: 2, content }
  const diagnostics = await service.diagnostics(input)
  expect(diagnostics.diagnostics).toEqual([expect.objectContaining({ code: 2322 })])
  const definition = await service.definition(input, 2, content.split('\n')[1]!.lastIndexOf('projectValue') + 1)
  expect(definition.definitions).toEqual([expect.objectContaining({ path: 'value.ts', start: { line: 1, column: 14 } })])
  const references = await service.references(input, 2, content.split('\n')[1]!.lastIndexOf('projectValue') + 1)
  expect(references.references.map(item=>item.path)).toEqual(['main.ts','value.ts'])
  const restarted = await service.restart(checkout)
  expect(restarted.state).toBe('ready')
  expect(restarted.generation).toBeGreaterThan(definition.generation)
})

it('rejects files outside the checkout and reports a missing project tsserver', async () => {
  const checkout = await languageProject()
  const service = new ProjectLanguageTools(async () => ({ checkoutPath: checkout, indexKey: checkout }))
  services.push(service)
  await expect(service.open({ workspacePath: checkout, path: '../outside.ts', version: 1, content: '' })).rejects.toThrow('outside')
  await rm(join(checkout, 'node_modules/typescript/lib/tsserver.js'))
  await expect(service.restart(checkout)).rejects.toThrow('Installed TypeScript 5.9.3 has no available project language server')
})

it('isolates language servers and document versions between checkouts', async () => {
  const first = await languageProject(), second = await languageProject()
  const service = new ProjectLanguageTools(async workspacePath => ({ checkoutPath: workspacePath, indexKey: workspacePath }))
  services.push(service)
  const one = await service.open({ workspacePath:first,path:'main.ts',version:1,content:'const one = 1' })
  const two = await service.open({ workspacePath:second,path:'main.ts',version:1,content:'const two = 2' })
  expect(two.generation).not.toBe(one.generation)
  await expect(service.change({ workspacePath:first,path:'main.ts',version:1,content:'const changed = 2' })).rejects.toThrow('without a new version')
})

it('starts one checkout server for concurrent document opens', async () => {
  const checkout = await languageProject()
  const service = new ProjectLanguageTools(async () => ({ checkoutPath:checkout,indexKey:checkout }))
  services.push(service)
  await Promise.all(['one.ts','two.ts'].map(path=>service.open({workspacePath:checkout,path,version:1,content:'export {}'})))
  expect(await readFile(join(checkout,'starts'),'utf8')).toBe('x')
})

it('inspects without starting, pauses a verified owner and requires explicit resume before new editor work', async () => {
  const checkout = await languageProject(), other = await languageProject()
  const service = new ProjectLanguageTools(async path => { if (![checkout, other].includes(path)) throw new Error('unregistered'); return { checkoutPath: path, indexKey: path } })
  services.push(service)
  expect(await service.inspect(checkout)).toMatchObject({ state: 'stopped', version: null })
  await expect(readFile(join(checkout, 'starts'), 'utf8')).rejects.toThrow()
  const first = await service.restart(checkout), second = await service.restart(other)
  expect(first.pid).toBeTypeOf('number'); expect(second.pid).not.toBe(first.pid)
  expect(await service.stopProject(checkout)).toMatchObject({ state: 'paused' })
  expect(() => process.kill(first.pid!, 0)).toThrow()
  expect(await service.inspect(other)).toMatchObject({ state: 'ready', pid: second.pid })
  await expect(service.open({ workspacePath: checkout, path: 'main.ts', version: 1, content: '' })).rejects.toThrow('paused')
  await expect(service.stopProject('/unregistered')).rejects.toThrow('unregistered')
  const resumed = await service.restart(checkout)
  expect(resumed.pid).not.toBe(first.pid)
  expect(resumed.state).toBe('ready')
})
