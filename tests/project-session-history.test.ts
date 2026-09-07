import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, stat, rm, rename, realpath, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ProjectSessionHistory, SESSION_HISTORY_BINARY_SHA256, SESSION_HISTORY_VERSION } from '../src/main/project-session-history'
import { resolveProjectToolScope } from '../src/main/project-tools'

const fixtures: string[] = []
afterEach(async () => { for (const path of fixtures.splice(0)) await rm(path, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'history-scope-')); fixtures.push(root)
  const project = join(root, 'project'), foreign = join(root, 'foreign')
  await mkdir(project); await mkdir(foreign)
  const resolveScope = (path: string) => resolveProjectToolScope(path, async path => {
    if (![project, foreign].includes(path)) throw new Error('Not registered')
    return { path, projectPath: path }
  })
  const scope = await resolveScope(project), directory = join(root, 'cache', scope.indexKey, SESSION_HISTORY_VERSION)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'receipt.json'), JSON.stringify({ version: SESSION_HISTORY_VERSION, binarySha256: SESSION_HISTORY_BINARY_SHA256, indexKey: scope.indexKey, indexedAt: '2026-09-06T00:00:00Z' }))
  const source = join(root, 'session.jsonl'); await writeFile(source, 'native source')
  const file = await stat(source, { bigint: true })
  const db = new DatabaseSync(join(directory, 'sessions.db'))
  db.exec(`CREATE TABLE sessions(id TEXT,agent TEXT,cwd TEXT,file_path TEXT,file_size INTEGER,file_mtime INTEGER,transcript_revision TEXT,session_name TEXT,display_name TEXT,first_message TEXT,source_session_id TEXT,source_version TEXT,parent_session_id TEXT,relationship_type TEXT,session_kind TEXT,deleted_at TEXT,source_missing_at TEXT);
    CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,ordinal INTEGER,content TEXT,is_system INTEGER,role TEXT);
    CREATE VIRTUAL TABLE messages_fts USING fts5(content,content='messages',content_rowid='id');`)
  const insert = db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)')
  for (const [id, agent, cwd] of [['omp:duplicate', 'omp', project], ['deepseek-harness:duplicate', 'deepseek-harness', project], ['omp:foreign', 'omp', foreign]]) {
    insert.run(id!,agent!,cwd!,source,Number(file.size),file.mtimeNs,'1',null,null,'History canary',null,'fixture-v1',null,'','')
    db.prepare('INSERT INTO messages(session_id,ordinal,content,is_system,role) VALUES(?,0,?,0,?)').run(id!, 'historycanary original', 'assistant')
  }
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')"); db.close()
  return { root, project, foreign, scope, directory, source, service: new ProjectSessionHistory({ binary: '/unused', cache: join(root, 'cache'), roots: { omp: [], 'deepseek-harness': [] } }, resolveScope) }
}

it('keeps agent IDs distinct and rejects foreign rows and direct identifiers', async () => {
  const f = await fixture(), result = await f.service.search(f.project, 'historycanary')
  expect(result.hits).toHaveLength(2)
  expect(new Set(result.hits.map(hit => hit.id)).size).toBe(2)
  const source = await f.service.get(f.project, result.hits[0]!.id)
  expect(source.messages[0]!.content).toBe('historycanary original')
  expect(source.untrusted).toBe(true)
  await expect(f.service.get(f.project, `session:${f.scope.indexKey}:${encodeURIComponent('omp:foreign')}:0`)).rejects.toThrow('outside this project')
  await expect(f.service.get(f.project, 'session:another-project:omp:0')).rejects.toThrow('another checkout')
})

it('preserves native identity and blocks helper resume', async () => {
  const f = await fixture(), file = await stat(f.source, { bigint: true })
  const db = new DatabaseSync(join(f.directory, 'sessions.db'))
  const insert = db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)')
  insert.run('hermes:primary','hermes',f.project,f.source,Number(file.size),file.mtimeNs,'1',null,null,'Hermes primary','native-hermes','state-db-v23',null,'','')
  insert.run('kimi:helper','kimi',f.project,f.source,Number(file.size),file.mtimeNs,'1',null,null,'Kimi helper','native-kimi','wire-v2','kimi:parent','subagent','helper')
  insert.run('kimi:wd_project_hash:main:session_8231090d-b0e3-4084-be6a-9fc6119170c4','kimi',f.project,f.source,Number(file.size),file.mtimeNs,'1',null,null,'Kimi primary','session_8231090d-b0e3-4084-be6a-9fc6119170c4','kimi-wire+state-v2',null,'','')
  for (const id of ['hermes:primary','kimi:helper','kimi:wd_project_hash:main:session_8231090d-b0e3-4084-be6a-9fc6119170c4']) db.prepare('INSERT INTO messages(session_id,ordinal,content,is_system,role) VALUES(?,0,?,0,?)').run(id, 'nativeidentity canary', 'assistant')
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')"); db.close()
  const hits = (await f.service.search(f.project, 'nativeidentity')).hits
  expect(hits.map(hit => hit.title)).toEqual(expect.arrayContaining([expect.stringContaining('hermes ·'), expect.stringContaining('kimi helper ·')]))
  const hermes = await f.service.get(f.project, hits.find(hit => hit.title.startsWith('hermes'))!.id)
  expect(hermes).toMatchObject({ sourceFormat: 'Hermes state.db', sourceVersion: 'state-db-v23', projectAttribution: 'cwd', parentNativeId: null, role: 'primary', resume: { executable: 'hermes', args: ['--tui', '--resume', 'native-hermes'] } })
  const helper = await f.service.get(f.project, hits.find(hit => hit.title.includes('Kimi helper'))!.id)
  expect(helper).toMatchObject({ sourceFormat: 'Kimi wire.jsonl', sourceVersion: 'wire-v2', parentNativeId: 'kimi:parent', role: 'helper', resume: null })
  const kimi = await f.service.get(f.project, hits.find(hit => hit.title.includes('Kimi primary'))!.id)
  expect(kimi).toMatchObject({ nativeId:'kimi:wd_project_hash:main:session_8231090d-b0e3-4084-be6a-9fc6119170c4',sourceVersion:'kimi-wire+state-v2',resume:{executable:'kimi',args:['--session','session_8231090d-b0e3-4084-be6a-9fc6119170c4']} })
  await expect(f.service.get(f.project, hermes.id, { fromOrdinal: -1 })).rejects.toThrow('Invalid session page')
})

it('checks Hermes archive freshness using state, WAL, and transcript metadata', async () => {
  const f=await fixture(),profile=join(f.root,'hermes'),state=join(profile,'state.db'),sessions=join(profile,'sessions')
  await mkdir(sessions,{recursive:true});await writeFile(state,'db');await writeFile(state+'-wal','wal');await writeFile(join(sessions,'native.jsonl'),'transcript')
  const parts=await Promise.all([state,state+'-wal',join(sessions,'native.jsonl')].map(path=>stat(path,{bigint:true})))
  const size=parts.reduce((total,item)=>total+item.size,0n),mtime=parts.reduce((latest,item)=>item.mtimeNs>latest?item.mtimeNs:latest,0n)
  const db=new DatabaseSync(join(f.directory,'sessions.db'))
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)').run('hermes:archive','hermes',f.project,state,Number(size),mtime.toString(),'1',null,null,'Hermes archive','native','state-db-v23',null,'','')
  db.prepare('INSERT INTO messages(session_id,ordinal,content,is_system,role) VALUES(?,0,?,0,?)').run('hermes:archive','archivefreshness canary','assistant')
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");db.close()
  const hits=(await f.service.search(f.project,'archivefreshness')).hits
  expect(hits).toHaveLength(1)
  expect((await f.service.get(f.project,hits[0].id)).resume).toMatchObject({executable:'hermes',hermesHome:profile,args:['--tui','--resume','native']})
  await writeFile(join(sessions,'native.jsonl'),'changed transcript')
  expect((await f.service.search(f.project,'archivefreshness')).hits).toEqual([])
})

it('rejects changed/deleted native sources and changed parser receipts', async () => {
  const f = await fixture(), { hits } = await f.service.search(f.project, 'historycanary')
  await writeFile(f.source, 'changed source')
  expect((await f.service.search(f.project, 'historycanary')).hits).toEqual([])
  await expect(f.service.get(f.project, hits[0]!.id)).rejects.toThrow('missing, changed')
  await rm(f.source)
  expect((await f.service.search(f.project, 'historycanary')).hits).toEqual([])
  await writeFile(join(f.directory, 'receipt.json'), JSON.stringify({ version: 'another-parser', indexKey: f.scope.indexKey, indexedAt: 'today' }))
  await expect(f.service.search(f.project, 'historycanary')).rejects.toThrow('parser version')
})

it('does not reuse a renamed project archive or accept malformed queries', async () => {
  const f = await fixture()
  await expect(f.service.search(f.project, '')).rejects.toThrow('characters')
  await expect(f.service.search(f.project, 'x'.repeat(513))).rejects.toThrow('characters')
  await rename(f.project, join(f.root, 'renamed'))
  await expect(f.service.search(f.project, 'historycanary')).rejects.toThrow()
})

it('cancels a session search even when cancellation reaches the owner first', async () => {
  const f = await fixture()
  await f.service.cancelSearch(f.project, 'request-1')
  await expect(f.service.search(f.project, 'historycanary', 'request-1')).rejects.toThrow('cancelled')
})

it.skipIf(!process.env.DONWELLS_HISTORY_BINARY)('indexes a real native OMP session with owned foreground engine and no read daemon', async () => {
  const project = '/tmp/donwells-strengthen-27-native/project'
  const cache = await mkdtemp(join(tmpdir(), 'history-native-')); fixtures.push(cache)
  const service = new ProjectSessionHistory({ binary: process.env.DONWELLS_HISTORY_BINARY!, cache, roots: { omp: ['/tmp/donwells-strengthen-27-native'], 'deepseek-harness': ['/tmp/donwells-strengthen-09-dsh-ornith-home/sessions'] } }, path => resolveProjectToolScope(path, async path => ({ path, projectPath: project })))
  try {
    await service.index(await realpath(project))
    const result = await service.search(project, 'HISTORY_ORNITH_27')
    expect(result.hits.length).toBeGreaterThan(0)
    const omp = await service.get(project, result.hits[0]!.id)
    expect(omp.agent).toBe('omp')
    const dsh = await service.search(project, 'HISTORY_DSH_27')
    expect(dsh.hits.length).toBeGreaterThan(0)
    const native = await service.get(project, dsh.hits[0]!.id)
    expect(native.agent).toBe('deepseek-harness')
    expect(native.resume?.args).toEqual(['--profile', 'tui', '--resume', '06cecd53-2501-44cf-b70d-7d522af8dfaf'])
    const partialRoot = join(cache, 'partial-sources')
    await mkdir(join(partialRoot, 'project'), { recursive: true })
    await writeFile(join(partialRoot, 'project', 'partial.jsonl'), await readFile(omp.source, 'utf8') + '\n{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"UNCOMMITTED_PARTIAL_27')
    await writeFile(join(partialRoot, 'project', 'nested.jsonl'), (await readFile(omp.source, 'utf8')).replaceAll('01a077e9-7a37-7078-bc5d-ae9b5e08bfbf', '01a077e9-7a37-7078-bc5d-000000000000').replaceAll('\"cwd\":\"/tmp/donwells-strengthen-27-native/project\"', '\"cwd\":\"/tmp/donwells-strengthen-27-native/project/nested\"'))
    const partial = new ProjectSessionHistory({ binary: process.env.DONWELLS_HISTORY_BINARY!, cache: join(cache, 'partial-index'), roots: { omp: [partialRoot], 'deepseek-harness': [] } }, path => resolveProjectToolScope(path, async path => ({ path, projectPath: project })))
    try {
      await partial.index(project)
      expect((await partial.search(project, 'UNCOMMITTED_PARTIAL_27')).hits).toEqual([])
      expect((await partial.search(project, 'HISTORY_ORNITH_27')).hits.length).toBeGreaterThan(0)
      const scope = await resolveProjectToolScope(project, async path => ({ path, projectPath: project }))
      const db = new DatabaseSync(join(cache, 'partial-index', scope.indexKey, SESSION_HISTORY_VERSION, 'sessions.db'), { readOnly: true })
      try { expect(db.prepare("SELECT count(*) AS n FROM sessions WHERE cwd LIKE '%/nested'").get()?.n).toBe(0) } finally { db.close() }
    } finally { await partial.close() }
  } finally { await service.close() }
}, 150000)
