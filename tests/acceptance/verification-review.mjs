import assert from 'node:assert/strict'
import {mkdirSync,readFileSync,writeFileSync,realpathSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createServer} from 'node:http'
import {parseArgs} from 'node:util'
import {hash,sourceIdentity,validateOptions} from './workspace-baseline.mjs'
import {cleanupOwnedSmokeDaemon,delay} from '../helpers/smoke-processes.mjs'
const {values}=parseArgs({options:{app:{type:'string'},profile:{type:'string'},evidence:{type:'string'},playwright:{type:'string'},package:{type:'string'},browser:{type:'string'}}})
const {app:executable,resources,profile,evidence}=validateOptions(values)
mkdirSync(profile);mkdirSync(evidence);mkdirSync(join(profile,'fixture'))
const project=realpathSync(join(profile,'fixture'))
const git=(...args)=>execFileSync('git',args,{cwd:project,stdio:'ignore'})
writeFileSync(join(project,'package.json'),JSON.stringify({scripts:{test:'node check.cjs'}}))
writeFileSync(join(project,'check.cjs'),`const fs=require('node:fs');require('node:assert/strict').equal(fs.readFileSync('value.txt','utf8'),'fixed');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/result.txt','VERIFIED_17');console.log('VERIFIED_17')`)
writeFileSync(join(project,'value.txt'),'broken');writeFileSync(join(project,'.gitignore'),'dist/\n')
git('init','-b','main');git('config','user.email','fixture@example.test');git('config','user.name','Fixture');git('add','.');git('commit','-m','Fixture')
const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<h1>Verification fixture</h1><p>Current artifact reference</p>')});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/`
const {_electron}=await import(pathToFileURL(resolve(values.playwright)))
const {callRuntime}=await import(pathToFileURL(join(resources,'dist-cli/cli/rpc-client.js')))
const invoke=async(method,params={})=>{const result=await callRuntime(method,params,profile,45000);assert(result.ok,result.error);return result.result}
const report={packageExecutable:executable,source:sourceIdentity(),artifactSha256:hash(readFileSync(join(resources,'app.asar'))),fixture:project}
const waitRun=async(id)=>{for(let i=0;i<150;i++){const entries=await invoke('verification.list',{workspacePath:project});const entry=entries.find(entry=>entry.runId===id);if(entry&&entry.sourceState!=='running')return entry;await delay(200)}throw new Error('Verification did not finish')}
let app,page
try {
 const env={...process.env,DONWELLS_USER_DATA:profile,DONWELLS_BROWSER_TOOL_PACKAGE:resolve(values.package),DONWELLS_BROWSER_TOOL_EXECUTABLE:resolve(values.browser)};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;delete env.DONWELLS_SMOKE
 app=await _electron.launch({executablePath:executable,env});page=await app.firstWindow();await page.getByRole('navigation',{name:'Workspace tools'}).waitFor()
 await invoke('settings.set',{theme:'dark'});await invoke('repo.add',{dir:project});await page.getByTitle(project,{exact:true}).and(page.getByRole('button')).click()
 const broken=await invoke('verification.run',{workspacePath:project,script:'test'});report.failed=await waitRun(broken.id);assert.equal(report.failed.task.status,'failed');assert.notEqual(report.failed.task.exitCode,0)
 writeFileSync(join(project,'value.txt'),'fixed');await invoke('ui.diff.open',{worktreePath:project,relPath:'value.txt'});await page.getByRole('button',{name:/Review notes/}).click()
 const panel=page.getByRole('region',{name:'Verification evidence'});await panel.getByRole('button',{name:'Run script',exact:true}).waitFor();await panel.getByRole('button',{name:'Run script',exact:true}).click()
 let latest
 for(let i=0;i<100;i++){latest=(await invoke('verification.list',{workspacePath:project}))[0];if(latest&&latest.runId!==broken.id)break;await delay(100)}
 assert.notEqual(latest.runId,broken.id);report.passed=await waitRun(latest.runId);assert.equal(report.passed.task.status,'succeeded');assert.equal(report.passed.sourceState,'current')
 await panel.getByRole('button',{name:'Recheck evidence'}).click();await page.waitForFunction(()=>[...document.querySelectorAll('summary')].some(el=>el.textContent.includes('succeeded')&&el.textContent.includes('source current')))
 const row=panel.locator('details').filter({has:page.locator('summary').filter({hasText:'succeeded'})}).first();await row.locator(':scope > summary').click();await row.getByLabel('Artifact path').fill(join(project,'dist/result.txt'));await row.getByRole('button',{name:'Attach reference'}).click();await row.getByText(/attached reference; producer not verified/).waitFor()
 await panel.getByRole('button',{name:'Recheck evidence'}).click();await row.getByText(/result.txt · unchanged/).waitFor();await page.screenshot({path:join(evidence,'review-pass.png')})
 await invoke('browser.open',{worktreePath:project,url})
 const browserCall=operation=>invoke('tool.call',{workspacePath:project,id:'browser-testing',operation,arguments:{}})
 await browserCall('navigate');await browserCall('traceStart');await browserCall('snapshot')
 const screenshot=await browserCall('screenshot'),trace=await browserCall('traceStop');report.browserArtifacts=[]
 for(const result of [screenshot,trace]){assert(result.structuredContent.artifacts.length);for(const artifact of result.structuredContent.artifacts){const attached=await invoke('verification.attach',{workspacePath:project,runId:latest.runId,taskId:report.passed.task.id,path:artifact.path});assert.equal(attached.sha256,artifact.sha256);report.browserArtifacts.push(attached)}}
 await invoke('tool.stop',{workspacePath:project,id:'browser-testing'})
 await invoke('ui.diff.open',{worktreePath:project,relPath:'value.txt'})
 writeFileSync(join(project,'value.txt'),'edited after passing');report.stale=(await invoke('verification.list',{workspacePath:project,verifyArtifacts:true}))[0];assert.equal(report.stale.sourceState,'stale');assert.equal(report.stale.artifacts[0].state,'unchanged')
 await panel.getByRole('button',{name:'Recheck evidence'}).click();await page.waitForFunction(()=>[...document.querySelectorAll('summary')].some(el=>el.textContent.includes('succeeded')&&el.textContent.includes('source stale')));await page.screenshot({path:join(evidence,'review-stale.png')})
 report.verified=true
} catch(error) {report.error=error.stack;process.exitCode=1;if(page)await page.screenshot({path:join(evidence,'failure.png')}).catch(()=>{})}
finally {
 if(app){try{await invoke('tool.stop',{workspacePath:project,id:'browser-testing'});for(const session of(await invoke('terminal.list')).sessions)await invoke('terminal.close',{sessionId:session.id})}catch(error){report.cleanupError=String(error)}await app.close().catch(()=>{})}
 report.idleDaemonStopped=await cleanupOwnedSmokeDaemon(profile);await new Promise(resolve=>server.close(resolve));writeFileSync(join(evidence,'result.json'),JSON.stringify(report,null,2)+'\n')
}
