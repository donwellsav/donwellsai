import { afterEach, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcpAgent } from '../src/main/agents/acp'
import { AcpSessions } from '../src/main/agents/acp-sessions'
import { TerminalDaemon } from '../src/main/terminal-daemon'
import { DaemonClient } from '../src/main/daemon-client'
import { ProjectHandoffService } from '../src/main/project-handoff'

const owners: AcpAgent[] = [], directories: string[] = []
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.stop()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'donwells-acp-')))
  directories.push(root)
  const path = join(root, 'agent.mjs')
  writeFileSync(path, `import {createInterface} from 'node:readline';import{writeFileSync,appendFileSync}from'node:fs';
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');let pending,permission,turn=0;
writeFileSync('authority.json',JSON.stringify({daemon:!!process.env.DONWELLS_DAEMON_TOKEN,hook:!!process.env.DONWELLS_AGENT_HOOK_TOKEN,electron:!!process.env.ELECTRON_RUN_AS_NODE}));
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize'){if(process.argv.includes('no-init'))return;send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:!process.argv.includes('no-load')}}})}
if(m.method==='session/new'||m.method==='session/load'){writeFileSync('setup.json',JSON.stringify(m.params));if(m.method==='session/load')send({method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'saved history'}}}});send({id:m.id,result:m.method==='session/new'?{sessionId:'protocol-session'}:{}})}
if(m.method==='session/prompt'){pending=m.id;appendFileSync('prompts.txt','turn\\n');const text=m.params.prompt[0].text;
if(text==='wait')return;
if(text==='overflow'){process.stdout.write('x'.repeat(1024*1024+1));return}
if(text==='permission-details'){
const update=(sessionId,toolCallId,rawInput)=>send({method:'session/update',params:{sessionId,update:{sessionUpdate:'tool_call_update',toolCallId,rawInput,title:'Run reviewed verifier'}}});
update('protocol-session','write',{script:'first'});permission='permission-'+(++turn);
send({id:permission,method:'session/request_permission',params:{sessionId:'protocol-session',toolCall:{toolCallId:'write',title:'Run reviewed verifier',rawInput:{}},options:[{optionId:'allow',name:'Allow once',kind:'allow_once'},{optionId:'deny',name:'Deny',kind:'reject_once'}]}});
setTimeout(()=>{update('protocol-session','write',{script:'verify',outputs:['dist/acp.txt']});update('wrong-session','write',{script:'foreign'});update('protocol-session','other-call',{script:'other'});},30);return}
if(text==='permission'){permission='permission-'+(++turn);send({id:permission,method:'session/request_permission',params:{sessionId:'protocol-session',toolCall:{toolCallId:'write',title:'Write chosen output'},options:[{optionId:'allow',name:'Allow once',kind:'allow_once'},{optionId:'deny',name:'Deny',kind:'reject_once'}]}});return}
send({method:'session/update',params:{sessionId:'protocol-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ready'}}}});send({id:pending,result:{stopReason:'end_turn'}});pending=null}
if(m.method==='session/cancel'&&pending){send({id:pending,result:{stopReason:'cancelled'}});pending=null}
if(m.id===permission&&m.result){if(m.result.outcome.optionId==='allow')appendFileSync('writes.txt','write\\n');if(pending)send({id:pending,result:{stopReason:'end_turn'}});pending=null}
});process.stdin.on('end',()=>process.exit(0));`)
  const start = async (args: string[] = [], loadSessionId?: string, onChange: (snapshot: ReturnType<AcpAgent['get']>) => void = () => {}) => {
    const owner = await AcpAgent.start({ workspacePath: root, launch: { executable: process.execPath, args: [path, ...args] }, env: { ...process.env, DONWELLS_DAEMON_TOKEN: 'must-not-leak', DONWELLS_AGENT_HOOK_TOKEN: 'other-owner', ELECTRON_RUN_AS_NODE: '1' }, mcpServers: [{ name: 'project-memory', command: 'fixture-mcp', args: ['--workspace', root], env: [] }], loadSessionId, onChange })
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
  expect(JSON.parse(readFileSync(join(root, 'authority.json'), 'utf8'))).toEqual({ daemon: false, hook: false, electron: false })
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

it('journals prompts before dispatch, rejects changed IDs and preserves uncertain records across restart', async () => {
  const { root } = fixture(), launch = { executable: process.execPath, args: [join(root, 'agent.mjs')] }
  const sessions = new AcpSessions(join(root, 'profile'), () => {})
  sessions.start(root, 'owner', launch, [])
  try {
    await until(() => sessions.observe(root, 'owner').snapshot.state === 'ready')
    expect(sessions.prompt(root, 'owner', 'one', 'wait')).toEqual({ requestId: 'one', state: 'accepted' })
    expect(sessions.prompt(root, 'owner', 'one', 'wait')).toEqual({ requestId: 'one', state: 'accepted' })
    expect(() => sessions.prompt(root, 'owner', 'one', 'changed')).toThrow('different prompt')
    expect(() => sessions.observe('/different-project', 'owner')).toThrow('not owned')
    await until(() => { try { return readFileSync(join(root, 'prompts.txt'), 'utf8') === 'turn\n' } catch { return false } })
    await sessions.control(root, 'owner', 'stop')
    await until(() => sessions.observe(root, 'owner').requests[0]?.state === 'uncertain')
    const restarted = new AcpSessions(join(root, 'profile'), () => {})
    expect(restarted.prompt(root, 'owner', 'one', 'wait').state).toBe('uncertain')
    expect(restarted.start(root, 'owner', launch, []).state).toBe('uncertain')
    expect(readFileSync(join(root, 'prompts.txt'), 'utf8')).toBe('turn\n')
    await restarted.control(root, 'owner', 'dismiss')
    expect(restarted.list(root)).toEqual([])
    expect(restarted.start(root, 'owner', launch, []).state).toBe('uncertain')
  } finally { await sessions.control(root, 'owner', 'stop').catch(() => {}) }
})

it('exposes ACP through the real daemon transport without allocating a terminal', async () => {
  const { root } = fixture(), profile = join(root, 'daemon-profile')
  const daemon = new TerminalDaemon({ userDataDir: profile, authToken: 'acp-fixture-token' })
  const client = new DaemonClient(profile, { data() {}, exit() {}, title() {}, agent() {}, agentDismissed() {} }, join(profile, 'unused-daemon-entry.js'))
  await daemon.start()
  try {
    await client.startAcp(root, 'transport-owner', { executable: process.execPath, args: [join(root, 'agent.mjs')] }, [{ name: 'donwells-project-memory', command: 'fixture-mcp', args: [], env: [] }])
    for (let index = 0; index < 100; index++) {
      if ((await client.observeAcp(root, 'transport-owner')).snapshot.state === 'ready') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect((await client.observeAcp(root, 'transport-owner')).snapshot.state).toBe('ready')
    const env = Object.fromEntries(JSON.parse(readFileSync(join(root, 'setup.json'), 'utf8')).mcpServers[0].env.map((item: { name: string; value: string }) => [item.name, item.value]))
    const credential = { runId: env.DONWELLS_AGENT_HOOK_RUN_ID, sessionId: env.DONWELLS_AGENT_HOOK_SESSION_ID, token: env.DONWELLS_AGENT_HOOK_TOKEN }
    expect(await client.authenticateAgent(credential)).toMatchObject({ mode: 'acp', workspacePath: root, sessionId: 'transport-owner', liveness: 'live' })
    expect(JSON.stringify(await client.observeAcp(root, 'transport-owner'))).not.toContain(credential.token)
    await expect(client.authenticateAgent({ ...credential, token: 'wrong' })).rejects.toThrow('Invalid agent session credential')
    expect(await daemon.stopIfIdle()).toBe(false)
    await expect(client.observeAcp('/different-project', 'transport-owner')).rejects.toThrow('not owned')
    await client.promptAcp(root, 'transport-owner', 'hello', 'hello')
    for (let index = 0; index < 100; index++) {
      if ((await client.observeAcp(root, 'transport-owner')).requests[0]?.state === 'completed') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect((await client.observeAcp(root, 'transport-owner')).requests[0]?.state).toBe('completed')
    expect((await client.status()).sessionCount).toBe(0)
    await client.controlAcp(root, 'transport-owner', 'stop')
    await expect(client.authenticateAgent(credential)).rejects.toThrow('Invalid agent session credential')
    await client.controlAcp(root, 'transport-owner', 'dismiss')
  } finally {
    await client.controlAcp(root, 'transport-owner', 'stop').catch(() => {})
    client.disconnect()
    expect(await daemon.stopIfIdle()).toBe(true)
  }
})

it('accepts ACP source and receiving identities in the existing handoff ledger', async () => {
  const { root } = fixture()
  const scope = { projectKey: 'a'.repeat(64), projectPath: root, checkoutPath: root, indexKey: 'b'.repeat(64) }
  const service = new ProjectHandoffService(join(root, 'handoff-profile'), async () => scope, {
    handoffSource: async () => ({ sourceRevision: 'c'.repeat(40), contentFingerprint: 'sha256:' + 'd'.repeat(64), changedFiles: [] })
  }, { list: async () => [], findAcpSession: async sessionId => ({ sessionId, workspacePath: root, liveness: 'live' }) })
  const created = await service.projectHandoffCreate(root, { taskId: null, fromSessionId: 'acp-source', toAgent: 'opencode', goal: 'Continue work', summary: 'Use shared project facts', openQuestions: [], nextSteps: ['Read the handoff'], evidenceIds: [] })
  const accepted = await service.projectHandoffAccept(root, created.id, created.revision, 'acp-receiver', 'claim')
  const credential = { runId: 'acp-receiver', sessionId: 'acp-receiver', token: 'fixture-only' }
  const authenticate = async () => ({ id: 'acp-receiver', sessionId: 'acp-receiver', workspacePath: root, liveness: 'live' as const, mode: 'acp' as const })
  const received = await service.receive(authenticate, credential, root, created.id, accepted.revision)
  expect(received.delivery).toBe('uncertain')
  expect((await service.acknowledge(authenticate, credential, root, created.id, received.revision)).delivery).toBe('confirmed')
})

it('stops its own child while ACP initialization is stalled', async () => {
  const { root } = fixture(), sessions = new AcpSessions(join(root, 'profile'), () => {})
  sessions.start(root, 'stalled', { executable: process.execPath, args: [join(root, 'agent.mjs'), 'no-init'] }, [])
  await sessions.control(root, 'stalled', 'stop')
  await until(() => sessions.observe(root, 'stalled').snapshot.state === 'exited' && !sessions.hasOwnedSessions())
  expect(sessions.hasOwnedSessions()).toBe(false)
})


it('journals switch intent before dispatch and never replays it after uncertain restart', async () => {
  const { root } = fixture(), profile = join(root, 'switch-profile'), sessions = new AcpSessions(profile, () => {})
  let invoked = 0
  const execute = async () => { invoked++; throw new Error('owned process stop unverified') }
  expect(sessions.switchMode(root, 'source', 'request', 'acp', 'reviewed context', execute).state).toBe('accepted')
  expect(sessions.switchResult(root, 'request').state).toBe('accepted')
  sessions.switchMode(root, 'source', 'request', 'acp', 'reviewed context', execute)
  await until(() => sessions.switchResult(root, 'request').state === 'uncertain')
  expect(invoked).toBe(1)
  expect(() => sessions.switchResult('/other', 'request')).toThrow('another workspace')
  expect(() => sessions.switchMode(root, 'source', 'request', 'native', undefined, execute)).toThrow('different parameters')
  const restarted = new AcpSessions(profile, () => {})
  expect(restarted.switchMode(root, 'source', 'request', 'acp', 'reviewed context', execute).state).toBe('uncertain')
  expect(invoked).toBe(1)
})

it('switches daemon owners only after verified exit and preserves the exact protocol history in native argv', async () => {
  const { root } = fixture(), profile = join(root, 'switch-daemon'), executable = join(root, 'opencode')
  writeFileSync(executable, '#!/bin/sh\nexec "' + process.execPath + '" "' + join(root, 'agent.mjs') + '" "$@"\n')
  chmodSync(executable, 0o700)
  const daemon = new TerminalDaemon({ userDataDir: profile, authToken: 'switch-token' })
  const client = new DaemonClient(profile, { data() {}, exit() {}, title() {}, agent() {}, agentDismissed() {} }, join(profile, 'unused.js'))
  let nativeId: string | undefined, newAcpId: string | undefined
  await daemon.start()
  const result = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const receipt = await client.modeSwitchResult(root, id)
      if (receipt.state !== 'accepted') return receipt
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('Switch did not settle')
  }
  try {
    await client.startAcp(root, 'switch-source', { executable, args: ['acp'] }, [])
    for (let i = 0; i < 100 && (await client.observeAcp(root, 'switch-source')).snapshot.state !== 'ready'; i++) await new Promise(resolve => setTimeout(resolve, 10))
    await client.switchMode(root, 'switch-source', 'native', 'to-native', executable, [])
    const native = await result('to-native')
    expect(native.state).toBe('completed')
    expect(native.continuity).toBe('same-history')
    nativeId = native.native!.run.sessionId
    expect(native.native!.run.launch?.args).toEqual([root, '--session', 'protocol-session'])
    expect((await client.observeAcp(root, 'switch-source')).snapshot.state).toBe('exited')
    expect((await client.switchMode(root, 'switch-source', 'native', 'to-native', executable, [])).native!.run.sessionId).toBe(nativeId)
    await expect(client.startAcp(root, 'duplicate-owner', { executable, args: ['acp'] }, [], 'switch-source')).rejects.toThrow('owned by a native')
    await client.stopAgent(nativeId)
    await client.switchMode(root, nativeId, 'acp', 'to-acp', executable, [], 'hello')
    const acp = await result('to-acp')
    expect(acp.state).toBe('completed')
    expect(acp.continuity).toBe('new-session')
    newAcpId = acp.acp!.id
    for (let i = 0; i < 100 && !(await client.observeAcp(root, newAcpId)).requests.some(r => r.requestId === 'reviewed-context' && r.state === 'completed'); i++) await new Promise(resolve => setTimeout(resolve, 10))
    expect((await client.observeAcp(root, newAcpId)).requests).toContainEqual(expect.objectContaining({ requestId: 'reviewed-context', state: 'completed' }))
    await client.promptAcp(root, newAcpId, 'pending', 'wait')
    await client.controlAcp(root, newAcpId, 'stop')
    expect((await client.observeAcp(root, newAcpId)).snapshot.state).toBe('uncertain')
  } finally {
    await client.controlAcp(root, 'switch-source', 'stop').catch(() => {})
    if (newAcpId) await client.controlAcp(root, newAcpId, 'stop').catch(() => {})
    if (nativeId) { await client.stopAgent(nativeId).catch(() => {}); await client.dismissAgent(nativeId).catch(() => {}) }
    client.disconnect()
    expect(await daemon.stopIfIdle()).toBe(true)
  }
})

it('shows matching current-turn tool input before and after permission without changing the offered decision', async () => {
  const changes: ReturnType<AcpAgent['get']>[] = []
  const { start } = fixture(), owner = await start([], undefined, snapshot => changes.push(snapshot))
  const pending = owner.prompt('permission-details')
  await until(() => JSON.stringify(owner.get().permissions[0]?.request.toolCall.rawInput)?.includes('dist/acp.txt') ?? false)
  const initial = changes.flatMap(snapshot => snapshot.permissions).find(permission => JSON.stringify(permission.request.toolCall.rawInput) === JSON.stringify({ script: 'first' }))!
  expect(initial).toBeDefined()
  const reviewed = owner.get().permissions[0]!
  expect(reviewed.id).toBe(initial.id)
  expect(reviewed.request.options).toEqual(initial.request.options)
  expect(reviewed.request.sessionId).toBe(initial.request.sessionId)
  expect(reviewed.request.toolCall.rawInput).toEqual({ script: 'verify', outputs: ['dist/acp.txt'] })
  owner.answerPermission(reviewed.id, 'deny'); await pending
  const next = owner.prompt('permission')
  await until(() => owner.get().permissions.length === 1)
  expect(owner.get().permissions[0]!.request.toolCall.rawInput).toBeUndefined()
  owner.answerPermission(owner.get().permissions[0]!.id, 'deny'); await next
})

it('loads a lost owner history in the same daemon only after verified cleanup without replaying its uncertain prompt', async () => {
  const { root } = fixture(), launch = { executable: process.execPath, args: [join(root, 'agent.mjs')] }
  const sessions = new AcpSessions(join(root, 'loss-profile'), () => {})
  sessions.start(root, 'lost-owner', launch, [])
  try {
    await until(() => sessions.list(root)[0]?.state === 'ready')
    sessions.prompt(root, 'lost-owner', 'one-prompt', 'wait')
    await until(() => existsSync(join(root, 'prompts.txt')) && readFileSync(join(root, 'prompts.txt'), 'utf8') === 'turn\n')
    expect(() => sessions.start(root, 'live-load', launch, [], 'lost-owner')).toThrow('verified stopped')
    expect(sessions.list(root)).toHaveLength(1)
    const pid = sessions.list(root)[0]!.pid!
    process.kill(pid, 'SIGKILL')
    await until(() => sessions.observe(root, 'lost-owner').requests[0]?.state === 'uncertain')
    await until(() => { try { process.kill(pid, 0); return false } catch { return true } })
    const before = sessions.observe(root, 'lost-owner').requests
    sessions.start(root, 'recovered-owner', launch, [], 'lost-owner')
    await until(() => sessions.list(root).find(value => value.id === 'recovered-owner')?.state === 'ready')
    expect(sessions.observe(root, 'lost-owner').requests).toEqual(before)
    expect(sessions.observe(root, 'lost-owner').snapshot.state).toBe('uncertain')
    expect(sessions.observe(root, 'recovered-owner').requests).toEqual([])
    expect(sessions.observe(root, 'recovered-owner').snapshot.protocolSessionId).toBe('protocol-session')
    expect(sessions.observe(root, 'recovered-owner').updates[0]?.notification.update).toMatchObject({ content: { text: 'saved history' } })
    expect(readFileSync(join(root, 'prompts.txt'), 'utf8')).toBe('turn\n')
  } finally {
    for (const owner of sessions.list(root)) await sessions.control(root, owner.id, 'stop').catch(() => {})
  }
})
