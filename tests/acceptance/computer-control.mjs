import assert from 'node:assert/strict'
import {execFileSync,spawn} from 'node:child_process'
import {mkdirSync,readFileSync,writeFileSync,realpathSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'
import {hash,sourceIdentity,validateOptions} from './workspace-baseline.mjs'
import {cleanupOwnedSmokeDaemon,delay} from '../helpers/smoke-processes.mjs'
const {values}=parseArgs({options:{app:{type:'string'},profile:{type:'string'},evidence:{type:'string'},playwright:{type:'string'},driver:{type:'string'}}})
assert(values.driver&&values.playwright)
const {app:executable,resources,profile,evidence}=validateOptions(values);mkdirSync(profile);mkdirSync(evidence);mkdirSync(join(profile,'project'))
const project=realpathSync(join(profile,'project')),fixture=join(profile,'native-fixture'),receipt=join(evidence,'native-actions.json')
execFileSync('swiftc',[resolve('tests/fixtures/native-control.swift'),'-o',fixture])
const {_electron}=await import(pathToFileURL(resolve(values.playwright)))
const {callRuntime}=await import(pathToFileURL(join(resources,'dist-cli/cli/rpc-client.js')))
const invoke=async(method,params={})=>{const r=await callRuntime(method,params,profile,45000);if(!r.ok)throw new Error(r.error);return r.result}
const call=(operation,args={})=>invoke('tool.call',{workspacePath:project,id:'computer-control',operation,arguments:args})
const stop=()=>invoke('tool.stop',{workspacePath:project,id:'computer-control'})
const report={source:sourceIdentity(),artifactSha256:hash(readFileSync(join(resources,'app.asar'))),driverSha256:hash(readFileSync(values.driver)),requests:[]}
let app,page,target,sentinel
const observe=async(screenshot=false)=>{const r=await call(screenshot?'screenshot':'observe');if(screenshot){const image=r.content.find(part=>part.type==='image');assert(image);writeFileSync(join(evidence,'attached-window.png'),Buffer.from(image.data,'base64'))}return r}
const act=(operation,snapshot,args)=>call(operation,{owner:'fixture',generation:snapshot.structuredContent.attachment.generation,revision:snapshot.structuredContent.attachment.revision,...args})
try{
 const env={...process.env,DONWELLS_USER_DATA:profile,DONWELLS_COMPUTER_TOOL_BINARY:resolve(values.driver)};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL
 app=await _electron.launch({executablePath:executable,env});page=await app.firstWindow();await page.getByRole('navigation',{name:'Workspace tools'}).waitFor()
 await invoke('settings.set',{theme:'dark'});await invoke('repo.add',{dir:project});await page.getByTitle(project,{exact:true}).and(page.getByRole('button')).click();await page.getByRole('button',{name:'Computer control',exact:true}).click()
 await page.getByRole('button',{name:'Check permissions',exact:true}).click();await page.getByText(/Accessibility: granted/).waitFor();report.packagedPermissions=await call('permissions')
 await page.getByRole('button',{name:'List app windows',exact:true}).click();await page.waitForFunction(()=>document.querySelector('select')?.options.length>1)
 await page.screenshot({path:join(evidence,'computer-panel.png')})
 const electronPid=await app.evaluate(async({BrowserWindow})=>{
  const w=new BrowserWindow({width:640,height:420,title:'Donwells Electron Control Fixture',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}})
  await w.loadURL('data:text/html,'+encodeURIComponent('<title>Donwells Electron Control Fixture</title><style>body{padding:30px}input,button{font-size:20px;padding:10px}</style><h1>Control fixture</h1><label>Name<input id="name" aria-label="Fixture name" oninput="document.querySelector(\'#events\').textContent=String(Number(document.querySelector(\'#events\').textContent)+1)"></label><button onclick="document.querySelector(\'#saved\').textContent=\'Saved \'+document.querySelector(\'#name\').value">Save fixture</button><p id="saved">Ready</p><p id="events">0</p>'))
  return process.pid
 })
 target=spawn(fixture,[receipt],{stdio:'ignore'});await delay(700)
 let windows=(await call('windows')).structuredContent.windows
 const native=windows.find(w=>w.pid===target.pid&&w.title==='Donwells Control Fixture A'),electron=windows.find(w=>w.pid===electronPid&&w.title==='Donwells Electron Control Fixture');assert(native&&electron)
 report.targets={native,electron}
 sentinel=spawn(fixture,[join(profile,'sentinel.json')],{stdio:'ignore'});await delay(700)
 let state=await call('attach',{owner:'fixture',pid:native.pid,window:native.window_id,foreground:false})
 let button=state.structuredContent.elements.find(e=>e.label==='Record A');assert(button)
 await act('click',state,{element:button.element_token});await delay(200)
 const actions=JSON.parse(readFileSync(receipt,'utf8'));assert.equal(actions[0].target,'A');assert.equal(actions[0].frontmostPid,String(sentinel.pid));report.nativeBackground=actions
 await assert.rejects(()=>act('click',state,{element:button.element_token}),/Stale/)
 await stop()
 state=await call('attach',{owner:'fixture',pid:electron.pid,window:electron.window_id,foreground:false})
 const field=state.structuredContent.elements.find(e=>e.label==='Fixture name');assert(field,JSON.stringify(state).slice(0,2000))
 report.axType=await act('type',state,{element:field.element_token,text:'AX_PROBE_16'}).catch(error=>({refused:String(error)}))
 if(report.axType.refused){await stop();await call('attach',{owner:'fixture',pid:electron.pid,window:electron.window_id,foreground:false})}
 const dom=()=>app.evaluate(async({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Donwells Electron Control Fixture');return w.webContents.executeJavaScript('({value:document.querySelector("#name").value,events:Number(document.querySelector("#events").textContent),saved:document.querySelector("#saved").textContent,rect:document.querySelector("#name").getBoundingClientRect().toJSON(),innerHeight,outerHeight})')})
 report.axDom=await dom()
 state=await observe(true)
 const image=state.content.find(part=>part.type==='image'),png=Buffer.from(image.data,'base64'),bounds=(await call('windows')).structuredContent.windows.find(w=>w.window_id===electron.window_id).bounds,observed=await dom(),scale=png.readUInt32BE(16)/bounds.width
 const x=(observed.rect.x+observed.rect.width/2)*scale,y=(observed.rect.y+observed.rect.height/2+bounds.height-observed.innerHeight)*scale
 report.backgroundPixelType=await act('pixelType',state,{x,y,text:'PIXEL_PROOF_16'}).catch(error=>({refused:String(error)}))
 if(report.backgroundPixelType.refused){report.beforeForeground=await dom();assert.equal(report.beforeForeground.value,report.axDom.value);await stop();await call('attach',{owner:'fixture',pid:electron.pid,window:electron.window_id,foreground:true});state=await observe(true);report.foregroundExplicit=true;report.pixelType=await act('pixelType',state,{x,y,text:'PIXEL_PROOF_16'})}else report.pixelType=report.backgroundPixelType
 await delay(150)
 report.pixelDom=await dom();assert(report.pixelDom.events>report.axDom.events);assert(report.pixelDom.value.includes('PIXEL_PROOF_16'))
 state=await observe();button=state.structuredContent.elements.find(e=>e.label==='Save fixture');assert(button)
 report.electronClick=await act('click',state,{element:button.element_token});report.savedDom=await dom();assert(report.savedDom.saved.includes('PIXEL_PROOF_16'))
 state=await observe(true)
 const beforeLong=await dom(), longAction=act('pixelType',state,{x,y,text:'Z'.repeat(200)}).then(value=>({value}),error=>({error:String(error)}))
 let sawInput=false
 for(let i=0;i<100;i++){const current=await dom();if(current.events>beforeLong.events){sawInput=true;break}await delay(20)}
 assert(sawInput,'Long native action did not begin input')
 await stop();report.interrupted=await longAction;assert(report.interrupted.error?.includes('uncertain'),JSON.stringify(report.interrupted))
 const stoppedValue=await dom();await delay(500);assert.deepEqual(await dom(),stoppedValue);report.noInputReplayAfterStop=true
 await call('attach',{owner:'fixture',pid:electron.pid,window:electron.window_id,foreground:true});state=await observe(true)
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Donwells Electron Control Fixture');const [x,y]=w.getPosition();w.setPosition(x+20,y+20)})
 for(let i=0;i<30;i++){const current=(await call('windows')).structuredContent.windows.find(w=>w.window_id===electron.window_id);if(current.bounds.x!==bounds.x||current.bounds.y!==bounds.y){report.movedBounds=current.bounds;break}await delay(100)}
 assert(report.movedBounds,'WindowServer did not report the fixture move')
 await assert.rejects(()=>act('pixelClick',state,{x,y}),/moved|resized/);report.staleCoordinatesRefused=true
 await stop()
 state=await call('attach',{owner:'fixture',pid:native.pid,window:native.window_id,foreground:false})
 button=state.structuredContent.elements.find(e=>e.label==='Recorded A');assert(button);await act('click',state,{element:button.element_token});await delay(150)
 report.afterElectronFocus=JSON.parse(readFileSync(receipt,'utf8')).at(-1)
 target.kill();await new Promise(resolve=>target.once('exit',resolve));await assert.rejects(()=>observe(),/closed/);report.closedTargetRefused=true
 await stop();await page.getByRole('button',{name:'Show controller',exact:true}).click();await page.getByText('No window attached',{exact:true}).waitFor()
 await page.getByRole('button',{name:'List app windows',exact:true}).click()
 await page.waitForFunction(id=>[...document.querySelectorAll('select option')].some(option=>option.value===String(id)),electron.window_id)
 await page.getByLabel('App window',{exact:true}).selectOption(String(electron.window_id))
 await page.getByRole('button',{name:'Attach selected window',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('[aria-label="Native computer control"] pre')?.textContent.includes('Donwells Electron Control Fixture'))
 await page.getByRole('button',{name:'Screenshot',exact:true}).click();await page.getByAltText('Current attached app window').waitFor()
 await page.screenshot({path:join(evidence,'attached-control-panel.png')})
 await page.getByRole('button',{name:'Stop and release',exact:true}).click();await page.getByText('Controller stopped and released.',{exact:true}).waitFor()
 await page.getByRole('button',{name:'Move panel into workspace',exact:true}).click();await page.locator('[data-pane-kind="computer"]').waitFor();report.movableModule=true
 report.verified=true
}catch(error){report.error=String(error);throw error}
finally{
 try{if(app){await stop().catch(()=>{});try{for(const terminal of (await invoke('terminal.list')).sessions)await invoke('terminal.close',{sessionId:terminal.id})}finally{await app.close()}}}finally{
  for(const child of [sentinel,target])if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve))}
  report.idleDaemonStopped=await cleanupOwnedSmokeDaemon(profile);writeFileSync(join(evidence,'result.json'),JSON.stringify(report,null,2)+'\n')
 }
}
