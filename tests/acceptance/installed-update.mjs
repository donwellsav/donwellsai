import assert from 'node:assert/strict'
import {mkdirSync,readFileSync,writeFileSync,realpathSync} from 'node:fs'
import {join,resolve,dirname} from 'node:path'
import {pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'
import {hash,sourceIdentity,validateOptions} from './workspace-baseline.mjs'
import {cleanupOwnedSmokeDaemon,closeOwnedSmokeApp} from '../helpers/smoke-processes.mjs'
const {values}=parseArgs({options:{app:{type:'string'},previous:{type:'string'},profile:{type:'string'},evidence:{type:'string'},playwright:{type:'string'}}})
assert(values.previous&&values.playwright)
const {app:executable,resources,profile,evidence}=validateOptions(values);mkdirSync(profile);mkdirSync(evidence);mkdirSync(join(profile,'fixture'))
const project=realpathSync(join(profile,'fixture'));writeFileSync(join(project,'README.md'),'Installed update source must remain unchanged.\n')
const sourceHash=hash(readFileSync(join(project,'README.md'))),previous=resolve(values.previous)
const {_electron}=await import(pathToFileURL(resolve(values.playwright)))
const {callRuntime}=await import(pathToFileURL(join(resources,'dist-cli/cli/rpc-client.js')))
const invoke=async(method,params={})=>{const result=await callRuntime(method,params,profile,20000);assert(result.ok,result.error);return result.result}
const env={...process.env,DONWELLS_USER_DATA:profile};for(const key of Object.keys(env))if(key.startsWith('DONWELLS_')&&key!=='DONWELLS_USER_DATA')delete env[key];delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL
const report={source:sourceIdentity(),artifactSha256:hash(readFileSync(join(resources,'app.asar'))),previousSha256:hash(readFileSync(resolve(dirname(previous),'../Resources/app.asar'))),profile,project,versions:[],shutdowns:[]}
let app,page
const open=async(exe)=>{app=await _electron.launch({executablePath:exe,env});page=await app.firstWindow();await page.getByRole('navigation',{name:'Workspace tools'}).waitFor();report.versions.push(await app.evaluate(({app})=>app.getVersion()))}
const close=async()=>{report.shutdowns.push(await closeOwnedSmokeApp(app));assert.equal(report.shutdowns.at(-1).forcedTermination,false);app=null}
try{
 await open(previous);await invoke('repo.add',{dir:project});await page.getByRole('button',{name:/Main checkout/}).click()
 const input={workspacePath:project,kind:'decision',title:'Installed update continuity',content:'Before update',attribution:{harness:'human'}}
 const first=await invoke('memory.create',input);await page.evaluate(()=>window.donwells.projectMemoryStorageAction('migrate'))
 const authority=JSON.parse(readFileSync(join(profile,'project-memory-active.json'),'utf8'));assert.equal(authority.state,'sqlite')
 const originalBackup=join(profile,authority.directory,'project-memory.json.backup'),backupHash=hash(readFileSync(originalBackup))
 const ids=(await invoke('terminal.list')).sessions.map(s=>s.id).sort();assert(ids.length)
 await invoke('project.kit.export',{workspacePath:project,outputPath:join(evidence,'before-update-kit.json')});await close()
 await open(executable);assert.deepEqual(await invoke('memory.get',{workspacePath:project,id:first.id}),first);assert.deepEqual((await invoke('terminal.list')).sessions.map(s=>s.id).sort(),ids)
 const second=await invoke('memory.update',{...input,id:first.id,expectedRevision:1,content:'Written by new installed release'})
 await invoke('project.kit.export',{workspacePath:project,outputPath:join(evidence,'before-rollback-kit.json')});await close()
 await open(previous);assert.deepEqual(await invoke('memory.get',{workspacePath:project,id:first.id}),second);assert.deepEqual((await invoke('terminal.list')).sessions.map(s=>s.id).sort(),ids)
 const third=await invoke('memory.update',{...input,id:first.id,expectedRevision:2,content:'Written after binary rollback'});await close()
 await open(executable);assert.deepEqual(await invoke('memory.get',{workspacePath:project,id:first.id}),third);assert.deepEqual((await invoke('terminal.list')).sessions.map(s=>s.id).sort(),ids)
 assert.equal(hash(readFileSync(originalBackup)),backupHash);assert.equal(hash(readFileSync(join(project,'README.md'))),sourceHash)
 assert.notEqual(report.versions[0],report.versions[1]);assert.equal(report.versions[0],report.versions[2]);assert.equal(report.versions[1],report.versions[3])
 report.continuity={sqliteRevision:third.revision,terminalIds:ids,sourceUnchanged:true,migrationBackupUnchanged:true,exportsBeforeUpdateAndRollback:true};report.verified=true
}catch(error){report.error=error.stack;process.exitCode=1}
finally{
 if(app){try{for(const session of(await invoke('terminal.list')).sessions)await invoke('terminal.close',{sessionId:session.id});await close()}catch(error){report.cleanupError=String(error);process.exitCode=1}}
 report.idleDaemonStopped=await cleanupOwnedSmokeDaemon(profile);if(report.error||report.cleanupError||!report.idleDaemonStopped)report.verified=false;writeFileSync(join(evidence,'result.json'),JSON.stringify(report,null,2)+'\n')
}
