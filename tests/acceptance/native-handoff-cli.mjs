import assert from 'node:assert/strict'
import {mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, readdirSync} from 'node:fs'
import {join, resolve, basename} from 'node:path'
import {pathToFileURL} from 'node:url'
import {parseArgs, stripVTControlCharacters} from 'node:util'
import {randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {hash, sourceIdentity, validateOptions} from './workspace-baseline.mjs'
import {cleanupOwnedSmokeDaemon, closeOwnedSmokeApp, delay} from '../helpers/smoke-processes.mjs'
const {values}=parseArgs({options:{app:{type:'string'},profile:{type:'string'},evidence:{type:'string'},playwright:{type:'string'},'dsh-profile':{type:'string'},'dsh-sessions':{type:'string'},zstd:{type:'string'}}})
assert(values.playwright&&values['dsh-profile']&&values['dsh-sessions']&&values.zstd)
const {app:executable,resources,profile,evidence}=validateOptions(values)
mkdirSync(profile);mkdirSync(evidence);mkdirSync(join(profile,'fixture'))
const project=realpathSync(join(profile,'fixture')),word='HANDOFF_'+randomUUID(),source=join(project,'source.txt'),output=join(project,'result.txt')
execFileSync('git',['init','-b','main',project],{stdio:'ignore'})
const {_electron}=await import(pathToFileURL(resolve(values.playwright)))
const {callRuntime}=await import(pathToFileURL(join(resources,'dist-cli/cli/rpc-client.js')))
const invoke=async(method,params={})=>{const result=await callRuntime(method,params,profile,45000);assert(result.ok,result.error);return result.result}
const report={source:sourceIdentity(),artifactSha256:hash(readFileSync(join(resources,'app.asar'))),project,model:'omlx/Ornith-1.5-35B-A3B-MLX-8bit',limitations:['Native PTY/RPC continuation; GUI handoff review and keyboard workflows are separate acceptance checks.']}
let app,cleaning=false
// Use the existing preload API for setup/review, not the model's credential-only MCP channel.
const bridge=(method,args)=>app.evaluate(({BrowserWindow},{method,args})=>BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`window.donwells[${JSON.stringify(method)}](...${JSON.stringify(args)})`),{method,args})
const until=async(check,message)=>{const deadline=Date.now()+180000;while(!await check()){assert(Date.now()<deadline,message);await delay(250)}}
try {
 const env={...process.env,DONWELLS_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;delete env.DONWELLS_SMOKE
 app=await _electron.launch({executablePath:executable,env});const page=await app.firstWindow();page.on('close',()=>{if(!cleaning)report.debuggingPageClosedBeforeCleanup=true})
 await page.getByRole('navigation',{name:'Workspace tools'}).waitFor();await invoke('repo.add',{dir:project})
 const providers=(await invoke('agent.providers')).providers
 for(const id of ['omp','deepseek-harness'])assert(providers.find(p=>p.id===id)?.executablePath,`${id} unavailable`)
 await bridge('agentConfigureMemory',[project,'omp'])
 const dshSetup=await bridge('agentConfigureMemory',[project,'deepseek-harness'])
 const omp=providers.find(p=>p.id==='omp'),dsh=providers.find(p=>p.id==='deepseek-harness')
 const binaryHashes=[omp,dsh].map(p=>hash(readFileSync(p.executablePath)))
 const first=await invoke('agent.start',{workspacePath:project,launch:{executable:omp.executablePath,args:['--print','--model',report.model,'--session-dir',join(profile,'omp-sessions'),'--no-title',`Write source.txt containing exactly ${word} with no newline. Do not edit other files. Stop after writing it.`]}})
 report.sourceSession=first.run.sessionId
 await until(async()=> (await invoke('agent.list')).agents.find(r=>r.sessionId===first.run.sessionId)?.liveness==='exited','Source native turn did not exit')
 assert.equal((await invoke('agent.list')).agents.find(r=>r.sessionId===first.run.sessionId)?.exitCode,0);assert.equal(readFileSync(source,'utf8'),word)
 const second=await invoke('agent.start',{workspacePath:project,launch:{executable:dsh.executablePath,args:['--profile',values['dsh-profile'],...dshSetup.launchArgs]}})
 report.recipientSession=second.run.sessionId
 await delay(4000)
 const draft=await bridge('projectHandoffCreate',[project,{taskId:null,fromSessionId:first.run.sessionId,toAgent:null,goal:'Continue the source agent fixture',summary:'The source agent completed source.txt in this checkout.',openQuestions:[],nextSteps:['Read source.txt, then write result.txt containing exactly its content with no newline. Do not edit other files.'],evidenceIds:[]}])
 const accepted=await bridge('projectHandoffAccept',[project,draft.id,draft.revision,second.run.sessionId,randomUUID()])
 report.handoffId=accepted.id
 await invoke('terminal.write',{sessionId:second.run.sessionId,data:`Call mcp__donwells-project-memory__handoff_receive with id ${accepted.id} and expectedRevision ${accepted.revision}. Read its context and call mcp__donwells-project-memory__handoff_acknowledge with its id and returned revision, then complete the next steps. Do not retry an uncertain receive.`})
 await delay(500);await invoke('terminal.write',{sessionId:second.run.sessionId,data:'\r'})
 await until(async()=>{
  const snapshot=await bridge('attachTerminal',[second.run.sessionId]);writeFileSync(join(evidence,'recipient.txt'),stripVTControlCharacters(snapshot.scrollback),{mode:0o600})
  return existsSync(output)&&readFileSync(output,'utf8')===word
 },'Recipient did not complete the handed-off file')
 const status=await bridge('projectHandoffGet',[project,accepted.id]);assert.equal(status.handoff.delivery,'confirmed');report.delivery=status.handoff.delivery
 const logs=resolve(values['dsh-sessions'])
 await until(async()=>{
  const directories=readdirSync(logs).filter(name=>name.endsWith(`-${basename(project)}--`))
  const candidates=directories.flatMap(name=>readdirSync(join(logs,name)).filter(s=>s.startsWith('session-')).map(s=>join(logs,name,s,'session.jsonl.zstd')))
  for(const path of candidates){
   let events;try{events=execFileSync(values.zstd,['-dc',path],{encoding:'utf8',maxBuffer:8*1024*1024,stdio:['ignore','pipe','ignore']}).trim().split('\n').map(JSON.parse)}catch{continue}
   if(events[0].cwd!==project)continue
   const end=events.findLast(e=>e.type==='turn/end');if(!end)continue
   assert.equal(end.data.reason?.kind,'completed');report.nativeTurn={id:events[0].id,reason:end.data.reason,failedToolCalls:events.filter(e=>e.type==='tool/result'&&e.data.turn===end.data.turn).flatMap(e=>e.data.message.content).filter(p=>p.type==='tool-result'&&p.isError).length};return true
  }
  return false
 },'Recipient native turn did not complete')
 assert.deepEqual([omp,dsh].map(p=>hash(readFileSync(p.executablePath))),binaryHashes)
 report.binaryHashes=binaryHashes;report.sourceSha256=hash(readFileSync(source));report.outputSha256=hash(readFileSync(output));report.verified=true
}catch(error){report.error=error.stack;process.exitCode=1}
finally {
 cleaning=true
 if(app){try{for(const run of(await invoke('agent.list')).agents){if(run.liveness!=='exited')await invoke('agent.stop',{sessionId:run.sessionId});const deadline=Date.now()+15000;while((await invoke('agent.list')).agents.find(r=>r.sessionId===run.sessionId)?.liveness!=='exited'){assert(Date.now()<deadline,'Agent stop timed out');await delay(100)}await invoke('agent.dismiss',{sessionId:run.sessionId})}for(const session of(await invoke('terminal.list')).sessions)await invoke('terminal.close',{sessionId:session.id});report.appShutdown=await closeOwnedSmokeApp(app)}catch(error){report.cleanupError=String(error);process.exitCode=1;await closeOwnedSmokeApp(app).catch(()=>{})}}
 report.idleDaemonStopped=await cleanupOwnedSmokeDaemon(profile);if(report.error||report.cleanupError||!report.idleDaemonStopped)report.verified=false
 writeFileSync(join(evidence,'result.json'),JSON.stringify(report,null,2)+'\n')
}
