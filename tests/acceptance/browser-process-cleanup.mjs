import assert from 'node:assert/strict'
import {mkdirSync,readFileSync,writeFileSync,readdirSync,existsSync,realpathSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createServer} from 'node:http'
import {parseArgs} from 'node:util'
import {hash,sourceIdentity,validateOptions} from './workspace-baseline.mjs'
import {cleanupOwnedSmokeDaemon,delay} from '../helpers/smoke-processes.mjs'
const {values}=parseArgs({options:{app:{type:'string'},profile:{type:'string'},evidence:{type:'string'},playwright:{type:'string'},package:{type:'string'},browser:{type:'string'},'crash-service':{type:'boolean',default:false},'crash-app':{type:'boolean',default:false}}})
assert(values.package&&values.browser&&values.playwright)
assert(!(values['crash-service']&&values['crash-app']))
const {app:executable,resources,profile,evidence}=validateOptions(values);mkdirSync(profile);mkdirSync(evidence)
mkdirSync(join(profile,'fixture'));const project=realpathSync(join(profile,'fixture')),source=join(project,'index.html')
const broken='<!doctype html><title>Owned browser fixture</title><p>Browser cleanup</p>'
writeFileSync(source,broken)
const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(readFileSync(source))});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/`
const {_electron}=await import(pathToFileURL(resolve(values.playwright)))
const {callRuntime}=await import(pathToFileURL(join(resources,'dist-cli/cli/rpc-client.js')))
const invoke=async(method,params={})=>{const result=await callRuntime(method,params,profile,45000);assert(result.ok,result.error);return result.result}
const report={source:sourceIdentity(),artifactSha256:hash(readFileSync(join(resources,'app.asar'))),fixture:project,url,sourceBefore:hash(Buffer.from(broken))}
let app,page
try{
 const env={...process.env,DONWELLS_USER_DATA:profile,DONWELLS_BROWSER_TOOL_PACKAGE:resolve(values.package),DONWELLS_BROWSER_TOOL_EXECUTABLE:resolve(values.browser)};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;delete env.DONWELLS_SMOKE
 app=await _electron.launch({executablePath:executable,env});page=await app.firstWindow();await page.getByRole('navigation',{name:'Workspace tools'}).waitFor();await invoke('settings.set',{theme:'dark'});await invoke('repo.add',{dir:project});await page.getByTitle(project,{exact:true}).and(page.getByRole('button')).click();await invoke('browser.open',{worktreePath:project,url})
 const opened=await invoke('tool.call',{workspacePath:project,id:'browser-testing',operation:'navigate',arguments:{}})
 const {execFileSync}=await import('node:child_process')
 const rows=()=>execFileSync('/bin/ps',['-axo','pid=,ppid=,args='],{encoding:'utf8'}).trim().split('\n').map(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return {pid:Number(m[1]),parent:Number(m[2]),args:m[3]}})
 const descendants=new Set([app.process().pid]);let processes=rows();for(let n=0;n<10;n++)for(const p of processes)if(descendants.has(p.parent))descendants.add(p.pid)
 const browsers=processes.filter(p=>descendants.has(p.pid)&&p.args.includes('--remote-debugging-pipe')&&p.args.includes('Google Chrome for Testing')&&!p.args.includes('--type='))
 assert.equal(browsers.length,1,'Must identify exactly the managed browser via current ancestry')
 report.ownedBrowser=browsers[0]
 if(values['crash-app']){const child=app.process();report.crashedAppPid=child.pid;child.kill('SIGKILL');const exited=Date.now()+5000;while(child.signalCode===null&&child.exitCode===null){assert(Date.now()<exited);await delay(50)}}
 else if(values['crash-service']){const owner=processes.find(p=>p.pid===browsers[0].parent);assert(owner&&descendants.has(owner.pid));report.crashedService=owner;process.kill(owner.pid,'SIGKILL');await delay(1000)}
 else {await invoke('tool.stop',{workspacePath:project,id:'browser-testing'});await delay(250)}
 let remaining;const deadline=Date.now()+5000;do{remaining=rows().filter(p=>browsers.some(b=>b.pid===p.pid&&b.args===p.args));if(!remaining.length)break;await delay(100)}while(Date.now()<deadline);report.browserSurvivedStop=remaining.length>0
 for(const p of remaining){const group=Number(execFileSync('/bin/ps',['-p',String(p.pid),'-o','pgid='],{encoding:'utf8'}).trim());assert.equal(group,p.pid);process.kill(-group,'SIGKILL')}
 if(values['crash-app']){app=await _electron.launch({executablePath:executable,env});page=await app.firstWindow();await page.getByRole('navigation',{name:'Workspace tools'}).waitFor();await invoke('browser.open',{worktreePath:project,url})}
 assert.equal(remaining.length,0,'Managed browser survived tool stop or app crash')
 if(values['crash-service']||values['crash-app']){const recovered=await invoke('tool.call',{workspacePath:project,id:'browser-testing',operation:'navigate',arguments:{}});assert(!recovered.isError);assert.notEqual(recovered.structuredContent.id,opened.structuredContent.id);report.recoveredFreshContext=true}
 report.verified=true

}catch(error){report.error=error.stack;process.exitCode=1;if(page)await page.screenshot({path:join(evidence,'failure.png')}).catch(()=>{})}
finally{
 if(app){try{await invoke('tool.stop',{workspacePath:project,id:'browser-testing'});for(const s of(await invoke('terminal.list')).sessions)await invoke('terminal.close',{sessionId:s.id});await app.close()}catch(error){report.cleanupError=String(error);process.exitCode=1;await app.close().catch(()=>{})}}
 report.idleDaemonStopped=await cleanupOwnedSmokeDaemon(profile);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));writeFileSync(join(evidence,'result.json'),JSON.stringify(report,null,2)+'\n')
}
