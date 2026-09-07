import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync,readFileSync,realpathSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'
import {parseArgs} from 'node:util'
import {artifactIdentity,sourceIdentity,validateOptions} from './workspace-baseline.mjs'
import {cleanSmokeAppShutdown,cleanupOwnedSmokeDaemon,closeOwnedSmokeApp,delay} from '../helpers/smoke-processes.mjs'
const {values}=parseArgs({options:{app:{type:'string'},profile:{type:'string'},evidence:{type:'string'},playwright:{type:'string'},pdf:{type:'boolean',default:false},'minimal-path':{type:'boolean',default:false}}})
assert(values.playwright)
const {app:executable,resources,profile,evidence}=validateOptions(values);mkdirSync(profile);mkdirSync(evidence);mkdirSync(join(profile,'fixture'))
const project=realpathSync(join(profile,'fixture'));writeFileSync(join(project,'README.md'),'# Keyboard fixture\nShared project keyboard journey.\n');execFileSync('git',['init','-q',project])
writeFileSync(join(project,'package.json'),JSON.stringify({scripts:{test:'node check.cjs'}}))
writeFileSync(join(project,'check.cjs'),`const fs=require('node:fs');require('node:assert/strict').ok(fs.readFileSync('README.md','utf8').includes('KEYBOARD_VERIFIED'));fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/result.txt','KEYBOARD_VERIFIED');console.log('KEYBOARD_VERIFIED')`)
writeFileSync(join(project,'.gitignore'),'dist/\n')
if(values.pdf)writeFileSync(join(project,'sample.pdf'),readFileSync(new URL('../fixtures/keyboard-preview.pdf',import.meta.url)))
for(const args of [['config','user.email','fixture@example.test'],['config','user.name','Keyboard fixture'],['add','.'],['commit','-qm','Keyboard fixture']])execFileSync('git',args,{cwd:project})
const {_electron}=await import(pathToFileURL(resolve(values.playwright)))
const {callRuntime}=await import(pathToFileURL(join(resources,'dist-cli/cli/rpc-client.js')))
const invoke=async(method,params={})=>{const r=await callRuntime(method,params,profile,10000);assert(r.ok,r.error);return r.result}
const report={sourceBefore:sourceIdentity(),artifactBefore:artifactIdentity(executable,resources),profile,project,journeys:{},limitations:['Keyboard UI uses a controllable /bin/cat CLI; native model authentication and execution are qualified separately.']}
let app,page,workflowPassed=false
const command=async(label)=>{await page.keyboard.press('Meta+k');await page.locator('.palette-input').waitFor();assert(await page.locator('.palette-input').evaluate(e=>e===document.activeElement));await page.keyboard.press('Meta+a');await page.keyboard.insertText(label);await page.keyboard.press('Enter');await page.locator('.palette-input').waitFor({state:'detached'});if(label==='Show project memory')await page.waitForFunction(()=>!!document.activeElement?.closest('.right-sidebar'),{},{timeout:2000})}
const reach=async(target)=>{await target.waitFor();const key=await target.evaluate(e=>document.activeElement&&(document.activeElement.compareDocumentPosition(e)&Node.DOCUMENT_POSITION_PRECEDING)?'Shift+Tab':'Tab');if(await page.evaluate(()=>!!document.activeElement?.closest('.monaco-editor')))await page.keyboard.press('Control+m');for(let i=0;i<160;i++){if(await target.evaluate(e=>e===document.activeElement))return;await page.keyboard.press(key)}throw Error('Control unreachable using '+key+': '+await target.evaluate(e=>e.outerHTML.slice(0,200)))}
const activate=async(target)=>{await reach(target);await page.keyboard.press('Enter')}
const enter=async(target,value)=>{await reach(target);await page.keyboard.press('Meta+a');await page.keyboard.insertText(value)}
const choose=async(target,value)=>{const label=await target.evaluate((e,value)=>Array.from(e.options).find(o=>o.value===value)?.textContent,value);assert(label);await reach(target);for(let i=0;i<20&&await target.inputValue()!==value;i++){await page.keyboard.press(label[0]);await delay(60)}assert.equal(await target.inputValue(),value);await page.keyboard.press('Tab')}
try{
 const env={...process.env,DONWELLS_USER_DATA:profile};if(values['minimal-path'])env.PATH='/usr/bin:/bin:/usr/sbin:/sbin';delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;delete env.DONWELLS_SMOKE
 app=await _electron.launch({executablePath:executable,env});page=await app.firstWindow();page.setDefaultTimeout(5000);await page.getByRole('navigation',{name:'Workspace tools'}).waitFor()
 if(values['minimal-path']){report.launchPath=env.PATH;report.resolvedPath=await app.evaluate(()=>process.env.PATH);report.discoveredProviders=await invoke('agent.providers')}
 await invoke('settings.set',{theme:'dark',agentCommand:'/bin/cat'});await invoke('repo.add',{dir:project})
 await page.evaluate(()=>{globalThis.keyboardMouseEvents=0;document.addEventListener('pointerdown',()=>globalThis.keyboardMouseEvents++,true)})
 await activate(page.getByRole('button',{name:/Main checkout/}));await command('Run default agent')
 const deadline=Date.now()+5000;let source
 while(!source){source=(await invoke('agent.list')).agents[0];assert(Date.now()<deadline,'Keyboard launch did not create a native session');if(!source)await delay(50)}
 assert.equal(source.workspacePath,project);report.journeys.start={sessionId:source.sessionId,workspacePath:source.workspacePath}
 await command('Show project memory')
 report.memoryCommandTransfersFocus=true
 await command('Show agent sessions')
 await activate(page.locator('summary').filter({hasText:/^Task and file scope$/}))
 await enter(page.getByLabel('Task intent',{exact:true}),'Review shared README')
 await enter(page.getByLabel('Intended files or directories',{exact:true}),'README.md')
 await activate(page.getByRole('button',{name:'Start agent & open terminal',exact:true}))
 await page.waitForFunction(()=>!document.querySelector('[aria-label="Close runs"]'))
 let receiver;const secondDeadline=Date.now()+5000
 while(!receiver){receiver=(await invoke('agent.list')).agents.find(r=>r.sessionId!==source.sessionId);assert(Date.now()<secondDeadline);if(!receiver)await delay(50)}
 assert.equal(receiver.workspacePath,project);assert.equal(receiver.task.intent,'Review shared README')
 await command('Show agent sessions')
 const scope=page.locator('summary').filter({hasText:/^Task and file scope$/});if(!await scope.evaluate(e=>e.parentElement.open))await activate(scope)
 await enter(page.getByLabel('Intended files or directories',{exact:true}),'README.md')
 await page.getByText(/session\(s\) may overlap/).waitFor()
 report.journeys.collaborate={sessionId:receiver.sessionId,workspacePath:receiver.workspacePath,task:receiver.task,overlapVisible:true}
 await activate(page.getByRole('button',{name:'Close runs',exact:true}))
 await command('Show project memory')
 await activate(page.locator('.handoff-panel > summary'))
 await choose(page.getByLabel('Source session',{exact:true}),source.sessionId)
 await enter(page.getByLabel('Goal',{exact:true}),'Continue keyboard project review')
 await enter(page.getByLabel('Progress summary',{exact:true}),'Shared README reviewed in the source session.')
 await enter(page.getByLabel('Open questions · one per line',{exact:true}),'Does the next build pass?')
 await enter(page.getByLabel('Next steps · one per line',{exact:true}),'Check project verification.')
 await activate(page.getByRole('button',{name:'Save handoff for review',exact:true}))
 const review=page.getByRole('region',{name:'Handoff review'});await review.waitFor()
 assert((await review.innerText()).includes(project))
 await choose(page.getByLabel('Receiving session',{exact:true}),receiver.sessionId)
 await activate(page.getByRole('button',{name:'Accept handoff',exact:true}))
 await review.getByText('Accepted by '+receiver.sessionId,{exact:true}).waitFor()
 await activate(page.getByRole('button',{name:'Copy receiving instructions',exact:true}))
 await page.getByRole('button',{name:'Instructions copied',exact:true}).waitFor()
 report.journeys.handoff={source:source.sessionId,receiver:receiver.sessionId,reviewed:true,accepted:true,instructionsCopied:true,nativeDelivery:'Qualified separately by native-handoff-cli.json'}
 await command('Show project memory')
 await activate(page.getByRole('button',{name:'New memory',exact:true}).first())
 await enter(page.getByLabel(/^Title/),'Keyboard project convention')
 await enter(page.getByLabel(/^Knowledge/),'Use README.md to explain the keyboard project workflow.')
 await activate(page.getByRole('button',{name:'Save memory',exact:true}))
 await page.locator('.memory-editor').waitFor({state:'detached'})
 await command('Show project memory')
 await enter(page.getByLabel('Search project memory',{exact:true}),'Keyboard project convention')
 await page.locator('.memory-entry-row').filter({hasText:'Keyboard project convention'}).waitFor()
 report.memoryCreatedAndFound=true
 await command('Search project…')
 await enter(page.getByRole('searchbox',{name:'Search text',exact:true}),'Shared project keyboard journey')
 const hit=page.getByRole('list',{name:'Content matches'}).getByRole('button',{name:/README.md:2/});await hit.waitFor();await activate(hit)
 await page.waitForFunction(()=>!!document.activeElement?.closest('.monaco-editor'))
 await page.keyboard.insertText('KEYBOARD_VERIFIED ');await page.keyboard.press('Meta+s')
 const saveDeadline=Date.now()+5000;while(!readFileSync(join(project,'README.md'),'utf8').includes('KEYBOARD_VERIFIED')){assert(Date.now()<saveDeadline);await delay(50)}
 assert.equal(readFileSync(join(project,'README.md'),'utf8').split('\n')[1],'KEYBOARD_VERIFIED Shared project keyboard journey.')
 report.journeys.understand={memoryCreatedAndFound:true,sourceOpenedAtLine:2,sourceEditedAndSaved:true}
 await command('Toggle Source Control')
 const file=page.locator('.git-file-name').filter({hasText:'README.md'});await file.waitFor();await activate(file)
 await activate(page.getByRole('button',{name:/Review notes/}))
 const verification=page.getByRole('region',{name:'Verification evidence'});await verification.waitFor()
 await activate(verification.getByRole('button',{name:'Run script',exact:true}))
 const verifyDeadline=Date.now()+20000;let verified
 while(!verified){verified=(await invoke('verification.list',{workspacePath:project})).find(r=>r.task.status==='succeeded');assert(Date.now()<verifyDeadline,'Keyboard verification did not succeed');if(!verified)await delay(100)}
 await activate(verification.getByRole('button',{name:'Recheck evidence',exact:true}))
 const row=verification.locator('details').filter({has:page.locator('summary').filter({hasText:'succeeded'})}).first();await row.waitFor();await activate(row.locator(':scope > summary'))
 await enter(row.getByLabel('Artifact path'),join(project,'dist/result.txt'))
 await activate(row.getByRole('button',{name:'Attach reference',exact:true}))
 await row.getByText(/attached reference; producer not verified/).waitFor()
 assert.equal(readFileSync(join(project,'dist/result.txt'),'utf8'),'KEYBOARD_VERIFIED')
 report.journeys.buildVerify={runId:verified.runId,status:verified.task.status,sourceState:verified.sourceState,artifactAttached:true}
 report.mouseEventsBeforeRestart=await page.evaluate(()=>globalThis.keyboardMouseEvents);assert.equal(report.mouseEventsBeforeRestart,0)
 const retainedIds=(await invoke('terminal.list')).sessions.map(s=>s.id).sort()
 report.restartShutdown=await closeOwnedSmokeApp(app);app=null;assert(cleanSmokeAppShutdown(report.restartShutdown),'Restart app shutdown was not clean')
 app=await _electron.launch({executablePath:executable,env});page=await app.firstWindow();page.setDefaultTimeout(5000)
 await page.getByRole('navigation',{name:'Workspace tools'}).waitFor()
 await page.evaluate(()=>{globalThis.keyboardMouseEvents=0;document.addEventListener('pointerdown',()=>globalThis.keyboardMouseEvents++,true)})
 assert.deepEqual((await invoke('terminal.list')).sessions.map(s=>s.id).sort(),retainedIds)
 await command('Show project memory')
 await enter(page.getByLabel('Search project memory',{exact:true}),'Keyboard project convention')
 const saved=page.locator('.memory-entry-row').filter({hasText:'Keyboard project convention'});await saved.waitFor();await activate(saved)
 assert.equal(await page.getByLabel(/^Knowledge/).inputValue(),'Use README.md to explain the keyboard project workflow.')
 await activate(page.getByRole('button',{name:'Close',exact:true}))
 const restored=(await invoke('verification.list',{workspacePath:project,verifyArtifacts:true})).find(r=>r.runId===verified.runId)
 assert.equal(restored.task.status,'succeeded');assert.equal(restored.sourceState,'current');assert.equal(restored.artifacts[0].state,'unchanged')
 report.journeys.returnShip={restart:'Owned app graceful close and relaunch',terminalIdentitiesRetained:true,memoryOpenedByKeyboard:true,verificationRetained:true,artifactUnchanged:true,installedRelease:'Task 22'}
 if(values.pdf){
  await page.keyboard.press('Meta+p');await page.locator('.palette-input').waitFor();await page.keyboard.press('Meta+a');await page.keyboard.insertText('sample.pdf');await page.getByRole('option',{name:/sample.pdf/}).waitFor();await page.keyboard.press('Enter');await page.locator('.palette-input').waitFor({state:'detached'})
  const pdf=page.getByRole('region',{name:'PDF preview: sample.pdf'});await pdf.waitFor()
  const assertRenderedPage=async number=>{const surface=pdf.locator(`.media-pdf-page[data-page-number="${number}"]`);await surface.getByText('Rendering page…',{exact:true}).waitFor({state:'detached'});assert.equal(await surface.getByRole('alert').count(),0,`PDF page ${number} reported a render error`);assert(await surface.locator(`canvas[aria-label="PDF page ${number}"]`).evaluate(c=>{const {data}=c.getContext('2d').getImageData(0,0,c.width,c.height);for(let i=0;i<data.length;i+=4)if(data[i+3]>0&&data[i]<180&&data[i+1]<180&&data[i+2]<180)return true;return false}),`PDF page ${number} canvas has no rendered pixels`)}
  await pdf.getByText('donwells.ai page 1',{exact:true}).waitFor();await assertRenderedPage(1)
  await activate(pdf.getByRole('button',{name:'Next page',exact:true}));await pdf.getByText('donwells.ai page 2',{exact:true}).waitFor()
  await assertRenderedPage(2)
  report.pdf={renderedCanvas:true,textLayer:true,secondPage:true,nodeCanvasRequired:false}
 }
 report.mouseEvents=await page.evaluate(()=>globalThis.keyboardMouseEvents);assert.equal(report.mouseEvents,0)
 await page.screenshot({path:join(evidence,'keyboard-workspace.png')})
 workflowPassed=true
}catch(error){report.error=error.stack;process.exitCode=1;if(page){report.focus=await page.evaluate(()=>({tag:document.activeElement?.tagName,role:document.activeElement?.getAttribute('role'),label:document.activeElement?.getAttribute('aria-label'),class:document.activeElement?.className})).catch(()=>null);await page.screenshot({path:join(evidence,'failure.png')}).catch(()=>{})}}
finally{
 if(app){try{for(const r of(await invoke('agent.list')).agents){if(r.liveness!=='exited')await invoke('agent.stop',{sessionId:r.sessionId});const deadline=Date.now()+15000;while((await invoke('agent.list')).agents.find(x=>x.sessionId===r.sessionId)?.liveness!=='exited'){assert(Date.now()<deadline,'Agent stop timed out');await delay(100)}await invoke('agent.dismiss',{sessionId:r.sessionId})}for(const s of(await invoke('terminal.list')).sessions)await invoke('terminal.close',{sessionId:s.id})}catch(error){report.cleanupError=String(error);process.exitCode=1}try{report.appShutdown=await closeOwnedSmokeApp(app)}catch(error){report.shutdownError=String(error);process.exitCode=1}}
 try{report.idleDaemonStopped=await cleanupOwnedSmokeDaemon(profile)}catch(error){report.daemonCleanupError=String(error);report.idleDaemonStopped=false;process.exitCode=1}
 try{report.sourceAfter=sourceIdentity();report.sourceUnchanged=report.sourceBefore.contentHash===report.sourceAfter.contentHash}catch(error){report.sourceIdentityError=String(error);process.exitCode=1}
 try{report.artifactAfter=artifactIdentity(executable,resources);report.artifactUnchanged=JSON.stringify(report.artifactBefore)===JSON.stringify(report.artifactAfter)}catch(error){report.artifactIdentityError=String(error);process.exitCode=1}
 report.verified=workflowPassed&&!report.error&&!report.cleanupError&&!report.shutdownError&&!report.daemonCleanupError&&!report.sourceIdentityError&&!report.artifactIdentityError&&report.idleDaemonStopped&&report.sourceUnchanged&&report.artifactUnchanged&&cleanSmokeAppShutdown(report.restartShutdown??{})&&cleanSmokeAppShutdown(report.appShutdown??{})
 if(!report.verified)process.exitCode=1
 writeFileSync(join(evidence,'result.json'),JSON.stringify(report,null,2)+'\n')
}
