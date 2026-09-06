import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectTools, resolveProjectToolScope, type ProjectToolDefinition } from '../src/main/project-tools'
import { createCodeGraphDefinition } from '../src/main/project-code-graph'
import { ProcessExecutionError } from '../src/shared/child-process/run-process'

const owners: ProjectTools[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.close()))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture(mode = 'normal', scope: 'project' | 'checkout' = 'checkout') {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'donwells-tool-')))
  directories.push(directory)
  const project = join(directory, 'project'), checkout = join(directory, 'linked'), other = join(directory, 'other')
  for (const path of [project, checkout, other]) mkdirSync(path)
  let registered = true
  let checkoutProject = project
  const resolve = async (path: string) => {
    if (!registered || ![project, checkout, other].includes(path)) throw new Error('Unknown workspace')
    return { path, projectPath: path === checkout ? checkoutProject : path === other ? other : project }
  }
  const counter = join(directory, 'starts'), writes = join(directory, 'writes'), script = join(directory, 'server.cjs')
  writeFileSync(script, `
const fs = require('node:fs'), readline = require('node:readline');
const mode = process.argv[2], counter = process.argv[3], writes = process.argv[4];
fs.appendFileSync(counter, process.pid+'\\n');
if(mode==='graceful')process.stdin.on('end',()=>{fs.appendFileSync(writes,'closed\\n');process.exit(0)});
if(mode==='ignore-eof')setInterval(()=>{},1000);
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); if(!m.id)return;
 const send=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
 if(m.method==='initialize'){
   if(mode==='timeout')return;
   if(mode==='malformed'){process.stdout.write('broken\\n');return}
   send({protocolVersion:'2025-11-25',serverInfo:{name:'fixture',version: mode==='version'?'2':'1'},capabilities:{tools:{}}});return;
 }
 if(m.method==='tools/list'){send({tools:[{name:'inspect'},{name:'write'}]});return}
 if(m.method==='tools/call'){
   if(m.params.name==='write')fs.appendFileSync(writes, 'write\\n');
   if(mode==='crash'||(mode==='crash-once'&&fs.readFileSync(counter,'utf8').trim().split('\\n').length===1)){process.exit(1);return}
   if(mode==='late'){setTimeout(()=>send({content:[],pid:process.pid}),500);return}
   send({content:[],pid:process.pid,cwd:process.cwd(),args:m.params.arguments});
 }
});
`)
  const text = (value: unknown) => { if (typeof value !== 'string' || value.length > 1000) throw new Error('Expected bounded text'); return value }
  const operation = { tool: 'inspect', readOnly: true, parameters: { query: text }, targets: (bound: { projectKey: string; indexKey: string }) => ({ project: bound.projectKey, index: bound.indexKey }) }
  const definition: ProjectToolDefinition = { id: 'fixture', version: '1', scope, launch: () => ({ program: process.execPath, args: [script, mode, counter, writes] }), operations: { search: operation, get: operation, history: operation, export: operation, write: { ...operation, tool: 'write', readOnly: false } } }
  const tools = new ProjectTools(resolve, [definition], 150)
  owners.push(tools)
  return { tools, definition, project, checkout, other, resolve, counter, writes, deregister: () => { registered = false }, reassignCheckout: () => { checkoutProject = other } }
}

it.each(['start', 'search', 'write'])('refuses %s when checkout ownership changes during preparation', async operation => {
  const f = fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  f.definition.prepare = async () => { entered.resolve(); await release.promise }
  const pending = operation === 'start' ? f.tools.start(f.checkout, 'fixture') : f.tools.call(f.checkout, 'fixture', operation, { query: 'hello' })
  const outcome = expect(pending).rejects.toThrow('Tool scope changed during preparation')
  await entered.promise
  f.reassignCheckout()
  release.resolve()
  await outcome
  expect(() => readFileSync(f.counter)).toThrow()
  expect(() => readFileSync(f.writes)).toThrow()
})

it.each(['search', 'write'])('does not dispatch %s with targets from a previous project registration', async operation => {
  const f = fixture()
  f.definition.operations[operation]!.targets = () => { f.reassignCheckout(); return { project: 'previous-project' } }
  await expect(f.tools.call(f.checkout, 'fixture', operation, { query: 'hello' })).rejects.toThrow('Tool scope changed before request')
  expect(() => readFileSync(f.writes)).toThrow()
})

it('deduplicates setup and cancels it before launching a native service', async () => {
  const f = fixture()
  let setups = 0
  f.definition.prepare = async (_scope, signal) => {
    setups++
    await new Promise<void>((_resolve, reject) => {
      if (signal.aborted) reject(new Error('Setup cancelled'))
      else signal.addEventListener('abort', () => reject(new Error('Setup cancelled')), { once: true })
    })
  }
  const first = f.tools.start(f.project, 'fixture').catch(error => error)
  const second = f.tools.start(f.project, 'fixture').catch(error => error)
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(setups).toBe(1)
  await f.tools.stop(f.project, 'fixture')
  expect(await first).toBeInstanceOf(Error)
  expect(await second).toBeInstanceOf(Error)
  expect(() => readFileSync(f.counter)).toThrow()
  expect((await f.tools.list(f.project))[0]?.status).toBe('stopped')
})

it('reports an unadmitted graph executable without launching it or creating its cache', async () => {
  const f = fixture(), binary = join(f.project, 'unknown-binary'), cache = join(f.project, 'graph-cache')
  writeFileSync(binary, 'unadmitted')
  f.definition.prepare = createCodeGraphDefinition(binary, cache).prepare
  await expect(f.tools.start(f.project, 'fixture')).rejects.toThrow(/admitted|qualified/)
  expect((await f.tools.list(f.project))[0]?.status).toBe('failed')
  expect(() => readFileSync(f.counter)).toThrow()
  expect(() => readFileSync(join(cache, 'config.json'))).toThrow()
})

it('retains an unverified setup termination across stop, restart and shutdown', async () => {
  const f = fixture(), entered = Promise.withResolvers<void>()
  f.definition.prepare = async (_scope, signal) => {
    entered.resolve()
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new ProcessExecutionError('termination-unverified', 'Fixture termination unverified')), { once: true }))
  }
  const starting = f.tools.start(f.project, 'fixture').catch(error => error)
  await entered.promise
  await expect(f.tools.stop(f.project, 'fixture')).rejects.toMatchObject({ kind: 'termination-unverified' })
  await starting
  expect((await f.tools.list(f.project))[0]?.status).toBe('failed')
  await expect(f.tools.start(f.project, 'fixture')).rejects.toThrow('termination could not be verified')
  await expect(f.tools.close()).rejects.toThrow('could not be stopped')
  // This fixture never launched a process; its simulated failure deliberately remains quarantined.
  owners.splice(owners.indexOf(f.tools), 1)
})

it('shares project identity across linked checkouts while isolating code indexes and unrelated projects', async () => {
  const f = fixture()
  const main = await resolveProjectToolScope(f.project, f.resolve), linked = await resolveProjectToolScope(f.checkout, f.resolve), other = await resolveProjectToolScope(f.other, f.resolve)
  expect(main.projectKey).toBe(linked.projectKey)
  expect(main.indexKey).not.toBe(linked.indexKey)
  expect(other.projectKey).not.toBe(main.projectKey)
  await expect(f.tools.start('/unregistered', 'fixture')).rejects.toThrow('Unknown workspace')
})

it('deduplicates concurrent starts and binds all operation targets outside caller arguments', async () => {
  const f = fixture()
  await Promise.all(Array.from({ length: 8 }, () => f.tools.start(f.project, 'fixture')))
  expect(readFileSync(f.counter, 'utf8').trim().split('\n')).toHaveLength(1)
  for (const operation of ['search', 'get', 'history', 'export', 'write']) {
    await expect(f.tools.call(f.project, 'fixture', operation, { query: 'hello', project: 'other' })).rejects.toThrow('not permitted')
    await expect(f.tools.call(f.project, 'fixture', operation, { query: { project: 'other' } })).rejects.toThrow('bounded text')
  }
  await expect(f.tools.call(f.project, 'fixture', 'batch', { query: 'hello' })).rejects.toThrow('Invalid tool operation')
  const result = await f.tools.call(f.project, 'fixture', 'search', { query: 'hello' }) as { args: Record<string, string> }
  expect(result.args.project).toBe((await resolveProjectToolScope(f.project, f.resolve)).projectKey)
  f.deregister()
  await expect(f.tools.call(f.project, 'fixture', 'get', { query: 'hello' })).rejects.toThrow('Unknown workspace')
})

it('launches shared project services from the main checkout and reuses them from linked checkouts', async () => {
  const f = fixture('normal', 'project')
  const linked = await f.tools.call(f.checkout, 'fixture', 'search', { query: 'hello' }) as { cwd: string; pid: number; args: unknown }
  const main = await f.tools.call(f.project, 'fixture', 'search', { query: 'hello' }) as typeof linked
  expect(linked.cwd).toBe(f.project)
  expect(main.pid).toBe(linked.pid)
  expect(main.args).toEqual(linked.args)
})

it.each(['timeout', 'malformed', 'version'])('fails readiness for %s and bounds restart attempts', async mode => {
  const f = fixture(mode)
  for (let attempt = 0; attempt < 3; attempt++) await expect(f.tools.start(f.project, 'fixture')).rejects.toThrow()
  expect((await f.tools.list(f.project))[0]?.status).toBe('failed')
  await expect(f.tools.start(f.project, 'fixture')).rejects.toThrow('restart limit')
})

it('retries a failed read once and never repeats a potentially completed write', async () => {
  const read = fixture('crash-once')
  await expect(read.tools.call(read.project, 'fixture', 'search', { query: 'hello' })).resolves.toMatchObject({ content: [] })
  expect(readFileSync(read.counter, 'utf8').trim().split('\n')).toHaveLength(2)
  const write = fixture('crash')
  await expect(write.tools.call(write.project, 'fixture', 'write', { query: 'hello' })).rejects.toMatchObject({ code: 'TOOL_OUTCOME_UNCERTAIN' })
  expect(readFileSync(write.writes, 'utf8').trim().split('\n')).toHaveLength(1)
})

it('shuts down owned services, rejects pending actions and fences late generations', async () => {
  const f = fixture('late')
  await f.tools.start(f.project, 'fixture')
  const action = f.tools.call(f.project, 'fixture', 'write', { query: 'hello' })
  const outcome = expect(action).rejects.toMatchObject({ code: 'TOOL_OUTCOME_UNCERTAIN' })
  await new Promise(resolve => setTimeout(resolve, 30))
  await f.tools.close()
  await outcome
  for (const pid of readFileSync(f.counter, 'utf8').trim().split('\n').map(Number)) {
    expect(() => process.kill(pid, 0)).toThrow()
  }
  await expect(f.tools.start(f.project, 'fixture')).rejects.toThrow('shutting down')
})

it('does not restart a pending read after the user stops its service', async () => {
  const f = fixture('late')
  await f.tools.start(f.project, 'fixture')
  const result = f.tools.call(f.project, 'fixture', 'search', { query: 'hello' })
  const outcome = expect(result).rejects.toThrow('Tool stopped')
  await new Promise(resolve => setTimeout(resolve, 30))
  await f.tools.stop(f.project, 'fixture')
  await outcome
  expect(readFileSync(f.counter, 'utf8').trim().split('\n')).toHaveLength(1)
  expect((await f.tools.list(f.project))[0]?.status).toBe('stopped')
  await f.tools.start(f.project, 'fixture')
  expect(readFileSync(f.counter, 'utf8').trim().split('\n')).toHaveLength(2)
})

it('honors a stop while an operation verifies source freshness', async () => {
  const f = fixture()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  f.definition.operations.search!.run = async (_scope, request) => {
    entered.resolve()
    await release.promise
    return request()
  }
  const result = f.tools.call(f.project, 'fixture', 'search', { query: 'hello' })
  const outcome = expect(result).rejects.toThrow('Tool stopped')
  await entered.promise
  await f.tools.stop(f.project, 'fixture')
  release.resolve()
  await outcome
  expect(readFileSync(f.counter, 'utf8').trim().split('\n')).toHaveLength(1)
})

it('reports an uncertain write and stops its service when the project is removed before delivery', async () => {
  const f = fixture()
  const completed = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  f.definition.operations.write!.run = async (_scope, request) => {
    const result = await request()
    completed.resolve()
    await release.promise
    return result
  }
  const writing = f.tools.call(f.project, 'fixture', 'write', { query: 'hello' })
  const outcome = expect(writing).rejects.toMatchObject({ code: 'TOOL_OUTCOME_UNCERTAIN' })
  await completed.promise
  f.deregister()
  release.resolve()
  await outcome
  expect(readFileSync(f.writes, 'utf8').trim().split('\n')).toHaveLength(1)
  for (const pid of readFileSync(f.counter, 'utf8').trim().split('\n').map(Number)) {
    expect(() => process.kill(pid, 0)).toThrow()
  }
})

it('allows deliberate stop and reattach without weakening automatic crash limits', async () => {
  const f=fixture();let stopped=0
  f.definition.stopped=()=>{const pids=readFileSync(f.counter,'utf8').trim().split('\n').map(Number);expect(()=>process.kill(pids.at(-1)!,0)).toThrow();stopped++}
  for(let i=0;i<4;i++){await f.tools.start(f.project,'fixture');await f.tools.stop(f.project,'fixture')}
  expect(stopped).toBe(4)
})

it.skipIf(process.platform === 'win32')('allows native EOF cleanup and bounds an uncooperative service', async () => {
  const graceful = fixture('graceful')
  await graceful.tools.start(graceful.project, 'fixture')
  await graceful.tools.stop(graceful.project, 'fixture')
  expect(readFileSync(graceful.writes, 'utf8')).toBe('closed\n')
  const stubborn = fixture('ignore-eof')
  await stubborn.tools.start(stubborn.project, 'fixture')
  const started = Date.now()
  await stubborn.tools.stop(stubborn.project, 'fixture')
  expect(Date.now() - started).toBeLessThan(4000)
  expect(() => process.kill(Number(readFileSync(stubborn.counter, 'utf8').trim()), 0)).toThrow()
})

it('observes an existing service without starting or restarting it', async () => {
  const f = fixture('crash-once')
  f.definition.operations.progress = { ...f.definition.operations.search!, requiresRunning: true }
  await expect(f.tools.call(f.project, 'fixture', 'progress', { query: 'status' })).rejects.toThrow('not running')
  expect(() => readFileSync(f.counter)).toThrow()
  await f.tools.start(f.project, 'fixture')
  await expect(f.tools.call(f.project, 'fixture', 'progress', { query: 'status' })).rejects.toThrow()
  expect(readFileSync(f.counter, 'utf8').trim().split('\n')).toHaveLength(1)
  await f.tools.stop(f.project, 'fixture')
  await expect(f.tools.call(f.project, 'fixture', 'progress', { query: 'status' })).rejects.toThrow('not running')
  expect(readFileSync(f.counter, 'utf8').trim().split('\n')).toHaveLength(1)
})
