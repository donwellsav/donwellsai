import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcpAgent } from '../src/main/agents/acp'

const owners: AcpAgent[] = [], directories: string[] = []
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.stop()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'donwells-acp-'))
  directories.push(root)
  const path = join(root, 'agent.mjs')
  writeFileSync(path, `import {createInterface} from 'node:readline';import{writeFileSync,appendFileSync}from'node:fs';
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');let pending,permission,turn=0;
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:!process.argv.includes('no-load')}}});
if(m.method==='session/new'||m.method==='session/load'){writeFileSync('setup.json',JSON.stringify(m.params));if(m.method==='session/load')send({method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'saved history'}}}});send({id:m.id,result:m.method==='session/new'?{sessionId:'protocol-session'}:{}})}
if(m.method==='session/prompt'){pending=m.id;appendFileSync('prompts.txt','turn\\n');const text=m.params.prompt[0].text;
if(text==='wait')return;
if(text==='overflow'){process.stdout.write('x'.repeat(1024*1024+1));return}
if(text==='permission'){permission='permission-'+(++turn);send({id:permission,method:'session/request_permission',params:{sessionId:'protocol-session',toolCall:{toolCallId:'write',title:'Write chosen output'},options:[{optionId:'allow',name:'Allow once',kind:'allow_once'},{optionId:'deny',name:'Deny',kind:'reject_once'}]}});return}
send({method:'session/update',params:{sessionId:'protocol-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ready'}}}});send({id:pending,result:{stopReason:'end_turn'}});pending=null}
if(m.method==='session/cancel'&&pending){send({id:pending,result:{stopReason:'cancelled'}});pending=null}
if(m.id===permission&&m.result){if(m.result.outcome.optionId==='allow')appendFileSync('writes.txt','write\\n');if(pending)send({id:pending,result:{stopReason:'end_turn'}});pending=null}
});process.stdin.on('end',()=>process.exit(0));`)
  const start = async (args: string[] = [], loadSessionId?: string) => {
    const owner = await AcpAgent.start({ workspacePath: root, launch: { executable: process.execPath, args: [path, ...args] }, mcpServers: [{ name: 'project-memory', command: 'fixture-mcp', args: ['--workspace', root], env: [] }], loadSessionId, onChange: () => {} })
    owners.push(owner)
    return owner
  }
  return { root, start }
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) { if (Date.now() > deadline) throw new Error('ACP fixture did not reach expected state'); await new Promise(resolve => setTimeout(resolve, 5)) }
}

it('owns a real stdio session, preserves scoped setup, denies/approves permissions and cancels without replay', async () => {
  const { root, start } = fixture(), owner = await start()
  const setup = JSON.parse(readFileSync(join(root, 'setup.json'), 'utf8'))
  expect(setup.cwd).toBe(owner.get().workspacePath)
  expect(setup.mcpServers[0].args).toEqual(['--workspace', root])
  expect(owner.get()).toMatchObject({ mode: 'acp', protocolSessionId: 'protocol-session', state: 'ready' })
  await owner.prompt('hello')
  expect(owner.observe().updates[0]?.notification.update.sessionUpdate).toBe('agent_message_chunk')
  for (const option of ['deny', 'allow']) {
    const turn = owner.prompt('permission')
    await until(() => owner.get().permissions.length === 1)
    const id = owner.get().permissions[0]!.id
    expect(() => owner.answerPermission(id, 'forged')).toThrow('not offered')
    owner.answerPermission(id, option)
    expect(() => owner.answerPermission(id, option)).toThrow('no longer pending')
    await turn
  }
  expect(readFileSync(join(root, 'writes.txt'), 'utf8')).toBe('write\n')
  const pending = owner.prompt('wait')
  await expect(owner.prompt('duplicate')).rejects.toThrow('not ready')
  await owner.cancel()
  expect(await pending).toMatchObject({ stopReason: 'cancelled' })
  expect(owner.get().state).toBe('ready')
  expect(readFileSync(join(root, 'prompts.txt'), 'utf8').trim().split('\n')).toHaveLength(4)
})

it('loads only negotiated sessions and shuts down on unsupported loading', async () => {
  const { start } = fixture()
  await expect(start(['no-load'], 'saved')).rejects.toThrow('does not support loading')
  const owner = await start([], 'saved')
  expect(owner.get()).toMatchObject({ protocolSessionId: 'saved', state: 'ready' })
  expect(owner.observe().updates[0]?.notification.update).toMatchObject({ content: { text: 'saved history' } })
})

it('bounds protocol frames and retains uncertainty rather than resubmitting a prompt', async () => {
  const { root, start } = fixture(), owner = await start()
  await expect(owner.prompt('overflow')).rejects.toThrow()
  await owner.stop()
  expect(owner.get().state).toBe('uncertain')
  expect(readFileSync(join(root, 'prompts.txt'), 'utf8')).toBe('turn\n')
  await expect(owner.prompt('retry')).rejects.toThrow('not ready')
})
