import assert from 'node:assert/strict'
import {mkdirSync,readFileSync,writeFileSync,readdirSync,existsSync,realpathSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createServer} from 'node:http'
import {parseArgs} from 'node:util'
import {hash,sourceIdentity,validateOptions} from './workspace-baseline.mjs'
import {cleanupOwnedSmokeDaemon,closeOwnedSmokeApp,delay} from '../helpers/smoke-processes.mjs'
const {values}=parseArgs({options:{app:{type:'string'},profile:{type:'string'},evidence:{type:'string'},playwright:{type:'string'},package:{type:'string'},browser:{type:'string'}}})
assert(values.package&&values.browser&&values.playwright)
const {app:executable,resources,profile,evidence}=validateOptions(values);mkdirSync(profile);mkdirSync(evidence)
mkdirSync(join(profile,'fixture'));const project=realpathSync(join(profile,'fixture')),source=join(project,'index.html'),sessions=join(profile,'omp-sessions');mkdirSync(sessions)
const broken='<!doctype html><title>Build loop fixture</title><style>form{width:1800px}label{display:block}</style><h1>Project form</h1><form><label>Task name<input id="name"></label><button type="button" id="save">Save task</button><p id="status">Ready</p></form><script>console.error("FIXTURE_BROKEN_15");document.querySelector("#save").onclick=()=>document.querySelector("#missing").textContent="Saved "+document.querySelector("#name").value</script>'
writeFileSync(source,broken)
const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(readFileSync(source))});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/`
const {_electron}=await import(pathToFileURL(resolve(values.playwright)))
const {callRuntime}=await import(pathToFileURL(join(resources,'dist-cli/cli/rpc-client.js')))
const invoke=async(method,params={})=>{const result=await callRuntime(method,params,profile,45000);assert(result.ok,result.error);return result.result}
const report={source:sourceIdentity(),artifactSha256:hash(readFileSync(join(resources,'app.asar'))),fixture:project,model:'omlx/Ornith-1.5-35B-A3B-MLX-8bit',url,sourceBefore:hash(Buffer.from(broken))}
const audit=join(evidence,'native-browser-methods.jsonl'),bridge=join(profile,'browser-agent-bridge.mjs')
writeFileSync(bridge,`import {appendFileSync} from 'node:fs';
import {runProjectMemoryMcp} from ${JSON.stringify(pathToFileURL(join(resources,'dist-cli/cli/project-memory-mcp.js')).href)};
import {callRuntime} from ${JSON.stringify(pathToFileURL(join(resources,'dist-cli/cli/rpc-client.js')).href)};
await runProjectMemoryMcp({workspacePath:${JSON.stringify(project)},harness:'omp',invoke:async(method,params)=>{const result=await callRuntime(method,params,${JSON.stringify(profile)},45000);appendFileSync(${JSON.stringify(audit)},JSON.stringify({method,operation:params.operation,ok:result.ok,context:result.result?.structuredContent?.id,revision:result.result?.structuredContent?.revision})+'\\n');if(!result.ok)throw new Error(result.error);return result.result;}});\n`,{mode:0o600})
mkdirSync(join(project,'.omp'));writeFileSync(join(project,'.omp/mcp.json'),JSON.stringify({mcpServers:{'donwells-project-memory':{command:executable,args:[bridge],env:{ELECTRON_RUN_AS_NODE:'1'}}}}),{mode:0o600})
let app,page,sessionId
try{
 const env={...process.env,DONWELLS_USER_DATA:profile,DONWELLS_BROWSER_TOOL_PACKAGE:resolve(values.package),DONWELLS_BROWSER_TOOL_EXECUTABLE:resolve(values.browser)};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;delete env.DONWELLS_SMOKE
 app=await _electron.launch({executablePath:executable,env});page=await app.firstWindow();await page.getByRole('navigation',{name:'Workspace tools'}).waitFor();await invoke('settings.set',{theme:'dark'});await invoke('repo.add',{dir:project});await page.getByTitle(project,{exact:true}).and(page.getByRole('button')).click();await invoke('browser.open',{worktreePath:project,url})
 const providers=(await invoke('agent.providers')).providers,omp=providers.find(p=>p.id==='omp');assert(omp?.executablePath)
 const prompt=`Repair the disposable app in index.html in this project. It has a broken Save task button, an intentional console error, and horizontal overflow at 1280 pixels. Before editing, use the donwells-project-memory MCP browser_test_open, browser_test_console, browser_test_layout and browser_test_snapshot tools to reproduce these problems. Start a trace with browser_test_trace_start. Use the native file editing tools to fix index.html. Reload using browser_test_open; this must reuse the same managed testing context. Fill Task name with BROWSER_BUILD_LOOP_15 using browser_test_type, then click Save task using browser_test_click. Both need current snapshot target refs and revision; refresh snapshot whenever refs are stale. Verify Saved BROWSER_BUILD_LOOP_15 appears, console errors are resolved and browser_test_layout reports horizontalOverflow false. Take browser_test_screenshot and save the trace with browser_test_trace_stop. Do not stop the browser context. Do not change .omp configuration. Finish only after verification and report BROWSER_BUILD_LOOP_15.`
 const started=await invoke('agent.start',{workspacePath:project,launch:{executable:omp.executablePath,args:['--print','--model',report.model,'--session-dir',sessions,'--no-title',prompt]}});sessionId=started.run.sessionId;report.agentSession=sessionId
 const deadline=Date.now()+600000
 while(Date.now()<deadline){const run=(await invoke('agent.list')).agents.find(r=>r.sessionId===sessionId);writeFileSync(join(evidence,'progress.json'),JSON.stringify({liveness:run?.liveness,sourceChanged:readFileSync(source,'utf8')!==broken,methods:existsSync(audit)?readFileSync(audit,'utf8').trim().split('\n').length:0}));if(run?.liveness==='exited')break;await delay(1000)}
 const run=(await invoke('agent.list')).agents.find(r=>r.sessionId===sessionId);assert.equal(run?.liveness,'exited','Native agent did not finish within the bound')
 const calls=readFileSync(audit,'utf8').trim().split('\n').map(JSON.parse);report.nativeOperations=calls
 for(const operation of ['navigate','console','layout','snapshot','type','click','traceStart','screenshot','traceStop'])assert(calls.some(call=>call.ok&&call.operation===operation),'Native agent did not execute '+operation)
 const ids=new Set(calls.map(call=>call.context).filter(Boolean));assert.equal(ids.size,1,'Native workflow changed browser context');report.sameManagedContext=[...ids][0]
 assert.notEqual(readFileSync(source,'utf8'),broken);report.sourceAfter=hash(readFileSync(source));writeFileSync(join(evidence,'repaired-index.html'),readFileSync(source))
 const snapshot=await invoke('tool.call',{workspacePath:project,id:'browser-testing',operation:'snapshot',arguments:{}});assert(JSON.stringify(snapshot).includes('Saved BROWSER_BUILD_LOOP_15'));assert.equal(snapshot.structuredContent.id,report.sameManagedContext)
 const layout=await invoke('tool.call',{workspacePath:project,id:'browser-testing',operation:'layout',arguments:{}});assert.match(JSON.stringify(layout),/horizontalOverflow\\?":\s*false/);report.finalLayout=layout
 // Drive the final review through native webContents; the Chromium debugging socket is a separate test transport.
 report.debuggingPageClosedBeforeReview=page.isClosed()
 for(const name of ['Browser testing','Inspect']){
  const activated=await app.evaluate(async({BrowserWindow},name)=>{
   const window=BrowserWindow.getAllWindows()[0];window.webContents.focus()
   const found=await window.webContents.executeJavaScript(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||b.textContent.trim())===${JSON.stringify(name)}&&b.getClientRects().length&&!b.disabled);if(!b)return false;b.focus();return document.activeElement===b})()`)
   if(found){window.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'})}return found
  },name);assert(activated,'Review button unavailable: '+name);await delay(200)
 }
 const reviewDeadline=Date.now()+15000
 while(!await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`!!document.querySelector('dialog pre')?.textContent.includes('Page URL:')`))){assert(Date.now()<reviewDeadline,'Browser inspection did not render');await delay(100)}
 const capture=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
 writeFileSync(join(evidence,'testing-panel.png'),Buffer.from(capture,'base64'));report.reviewDriver='Electron webContents keyboard and capturePage';report.verified=true
}catch(error){report.error=error.stack;process.exitCode=1;if(page)await page.screenshot({path:join(evidence,'failure.png')}).catch(()=>{})}
finally{
 if(app){try{if(sessionId){const run=(await invoke('agent.list')).agents.find(r=>r.sessionId===sessionId);if(run&&run.liveness!=='exited')await invoke('agent.stop',{sessionId});for(let n=0;n<100;n++){if((await invoke('agent.list')).agents.find(r=>r.sessionId===sessionId)?.liveness==='exited')break;await delay(50)}await invoke('agent.dismiss',{sessionId})}await invoke('tool.stop',{workspacePath:project,id:'browser-testing'});for(const s of(await invoke('terminal.list')).sessions)await invoke('terminal.close',{sessionId:s.id});report.appShutdown=await closeOwnedSmokeApp(app)}catch(error){report.cleanupError=String(error);process.exitCode=1;await closeOwnedSmokeApp(app).catch(()=>{})}}
 report.idleDaemonStopped=await cleanupOwnedSmokeDaemon(profile);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));if(report.error||report.cleanupError||!report.idleDaemonStopped)report.verified=false;writeFileSync(join(evidence,'result.json'),JSON.stringify(report,null,2)+'\n')
}
