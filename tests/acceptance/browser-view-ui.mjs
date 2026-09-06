import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { parseArgs } from 'node:util'
import { hash, sourceIdentity, validateOptions } from './workspace-baseline.mjs'
import { cleanupOwnedSmokeDaemon, delay } from '../helpers/smoke-processes.mjs'
const {values}=parseArgs({options:{app:{type:'string'},profile:{type:'string'},evidence:{type:'string'},playwright:{type:'string'}}})
const {app:executable,resources,profile,evidence}=validateOptions(values)
mkdirSync(profile);mkdirSync(evidence)
mkdirSync(join(profile,'first'));mkdirSync(join(profile,'second'));const first=realpathSync(join(profile,'first')),second=realpathSync(join(profile,'second'))
const { _electron }=await import(pathToFileURL(resolve(values.playwright)))
const {callRuntime}=await import(pathToFileURL(join(resources,'dist-cli/cli/rpc-client.js')))
const invoke=async(method,params={})=>{const r=await callRuntime(method,params,profile,45000);assert(r.ok,r.error);return r.result}
const server=createServer((request,response)=>{
 if(request.url==='/download'){response.writeHead(200,{'content-type':'application/octet-stream','content-disposition':'attachment; filename=preview-proof.txt'});response.end('download proof');return}
 if(request.url==='/fail'){request.socket.destroy();return}
 response.writeHead(200,{'content-type':'text/html'});response.end(`<title>${request.url}</title><h1>Native preview ${request.url}</h1><input aria-label="Page input"><p>findcanary findcanary</p><a href="/two">Second page</a><button onclick="window.open('/popup')">Popup</button>`)
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`
const report={source:sourceIdentity(),artifactSha256:hash(readFileSync(join(resources,'app.asar')))}
let app,page
const views=async()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].contentView.children.filter(v=>'webContents'in v&&v.webContents!==BrowserWindow.getAllWindows()[0].webContents).map(v=>({id:v.webContents.id,url:v.webContents.getURL(),visible:v.getVisible(),bounds:v.getBounds()})))
try{
 const env={...process.env,DONWELLS_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;delete env.DONWELLS_SMOKE
 app=await _electron.launch({executablePath:executable,env});page=await app.firstWindow()
 await page.getByRole('navigation',{name:'Workspace tools'}).waitFor()
 await invoke('settings.set',{theme:'dark'});await invoke('repo.add',{dir:first});await invoke('repo.add',{dir:second})
 await page.getByTitle(first,{exact:true}).and(page.getByRole('button')).click()
 const a=await invoke('browser.open',{worktreePath:realpathSync(first),url:origin+'/one'});report.open=a
 await delay(400);assert.equal(await page.locator('webview').count(),0)
 let native=await views();report.nativeInitial=native;report.domInitial=await page.evaluate(()=>({slots:[...document.querySelectorAll('.browser-view')].map(e=>({rect:e.getBoundingClientRect().toJSON(),visibility:getComputedStyle(e).visibility})),overlays:[...document.querySelectorAll('[role="dialog"], [role="menu"], .browser-suggestions, .design-capture-panel, .flexlayout__outline_rect, .flexlayout__drag_rect')].map(e=>({class:e.className,rect:e.getBoundingClientRect().toJSON(),visibility:getComputedStyle(e).visibility}))}));assert.equal(native.length,1);assert(native[0].visible);const id=native[0].id
 report.mainOwned=true
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1100,720));await delay(250);const resized=(await views()).find(v=>v.id===id);assert(resized.bounds.x+resized.bounds.width<=1100&&resized.bounds.y+resized.bounds.height<=720);report.resizeClipped=true;await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1280,800));await delay(250)
 await invoke('browser.navigate',{key:realpathSync(first),url:origin+'/two'})
 assert.equal((await invoke('browser.back',{key:realpathSync(first)})).url,origin+'/one')
 assert.equal((await invoke('browser.forward',{key:realpathSync(first)})).url,origin+'/two')
 report.navigationHistory=true
 await invoke('browser.eval',{key:realpathSync(first),js:'document.querySelector("input").value="retained-value"'})
 await page.getByTitle(second,{exact:true}).and(page.getByRole('button')).click();await delay(250)
 assert(!(await views()).find(v=>v.id===id).visible)
 await invoke('browser.open',{worktreePath:realpathSync(second),url:origin+'/other'});await delay(250)
 await page.getByTitle(first,{exact:true}).and(page.getByRole('button')).click();await delay(300)
 assert((await views()).find(v=>v.id===id).visible)
 assert.equal((await invoke('browser.eval',{key:realpathSync(first),js:'document.querySelector("input").value'})).result,'retained-value')
 report.projectSwitchPreservesGuest=true
 await page.getByRole('button',{name:'Find in page',exact:true}).filter({visible:true}).click()
 await page.getByRole('textbox',{name:'Find text'}).filter({visible:true}).fill('findcanary')
 await page.getByText('1 of 2',{exact:true}).waitFor();report.find=true
 const find=await page.getByRole('search',{name:'Find in page'}).filter({visible:true}).boundingBox()
 native=await views();assert(native.find(v=>v.id===id).bounds.y>=find.y+find.height-2)
 await page.getByRole('button',{name:'Close find',exact:true}).filter({visible:true}).click()
 const windowBounds=await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.show();w.focus();return w.getBounds()});await delay(200);execFileSync('/usr/sbin/screencapture',['-x','-R'+[windowBounds.x,windowBounds.y,windowBounds.width,windowBounds.height].join(','),join(evidence,'native-preview.png')])
 const nativeShot=await app.evaluate(async({webContents},id)=>(await webContents.fromId(id).capturePage()).toDataURL(),id);writeFileSync(join(evidence,'native-page.png'),Buffer.from(nativeShot.split(',')[1],'base64'))
 if(process.env.DONWELLS_BROWSER_VISUAL_PAUSE==='1'){writeFileSync(join(evidence,'visual-ready'),'ready');await delay(20000)}
 await app.evaluate(({webContents},id)=>{const wc=webContents.fromId(id);wc.focus();wc.sendInputEvent({type:'keyDown',keyCode:'L',modifiers:['meta']});wc.sendInputEvent({type:'keyUp',keyCode:'L',modifiers:['meta']})},id)
 await page.waitForFunction(()=>document.activeElement?.classList.contains('browser-address-input'));report.nativeAddressShortcut=true
 await page.keyboard.press('Escape')
 await page.getByRole('button',{name:'Start Design Mode',exact:true}).filter({visible:true}).click()
 await delay(300)
 const bound=(await views()).find(v=>v.id===id).bounds
 await app.evaluate(({webContents},id)=>{const w=webContents.fromId(id);w.sendInputEvent({type:'mouseMove',x:70,y:22});w.sendInputEvent({type:'mouseDown',x:70,y:22,button:'left',clickCount:1});w.sendInputEvent({type:'mouseUp',x:70,y:22,button:'left',clickCount:1})},id)
 await page.getByRole('complementary',{name:'Design capture review'}).waitFor();await page.getByRole('img',{name:/Captured .* element preview/}).waitFor();report.designCapture=true;report.boundedDesignScreenshot=true
 await delay(500);assert(!(await views()).find(v=>v.id===id).visible)
 await page.getByRole('button',{name:'Clear capture',exact:true}).click();await delay(200)
 const permission=await invoke('browser.eval',{key:first,js:'new Promise(resolve=>navigator.geolocation.getCurrentPosition(()=>resolve("granted"),error=>resolve(error.code)))'});assert.equal(permission.result,1);report.permissionsDenied=true
 await app.evaluate(({webContents},id)=>{const wc=webContents.fromId(id);globalThis.downloadProof=new Promise(resolve=>wc.session.once('will-download',(_event,item)=>{item.cancel();resolve(item.getFilename())}));wc.downloadURL(wc.getURL().replace('/two','/download'))},id)
 assert.equal(await app.evaluate(async()=>await globalThis.downloadProof),'preview-proof.txt');report.downloadLifecycle=true
 await page.evaluate(()=>{globalThis.viewEvents=[];globalThis.stopViewEvents=window.donwells.onBrowserView(e=>globalThis.viewEvents.push(e))})
 await invoke('browser.reload',{key:first})
 const denied=await page.evaluate(async()=>{const e=globalThis.viewEvents.at(-1);globalThis.stopViewEvents();try{await window.donwells.browserView({key:e.key,instance:e.instance,op:'eval',js:'1'});return false}catch{return true}});assert(denied);report.privilegedRendererIntentDenied=true

 await page.evaluate(()=>{const dialog=document.createElement('dialog');dialog.id='view-overlap-check';dialog.role='dialog';dialog.style.cssText='position:fixed;inset:100px;z-index:9999;background:#16161d';document.body.append(dialog);dialog.showModal()})
 await delay(200);assert((await views()).every(v=>!v.visible));report.dialogOcclusion=true
 await page.evaluate(()=>document.getElementById('view-overlap-check').remove());await delay(200)
 assert((await views()).find(v=>v.id===id).visible)
 const privilege=await page.evaluate(async()=>{try{await window.donwells.browserView({key:'invalid',instance:'x',op:'eval',js:'1'});return true}catch{return false}});assert.equal(privilege,false);report.invalidIntentDenied=true
 await invoke('browser.eval',{key:realpathSync(first),js:'window.open("/popup");true'})
 assert.equal((await views()).length,2);report.popupsDenied=true
 await app.evaluate(({webContents},id)=>webContents.fromId(id).forcefullyCrashRenderer(),id)
 await page.getByText(/Browser process exited:/).waitFor();report.crashVisible=true
 await page.getByRole('button',{name:'Retry',exact:true}).filter({visible:true}).click()
 await delay(1500);assert.equal((await invoke('browser.snapshot',{key:realpathSync(first)})).snapshot.url,origin+'/two');report.crashRetry=true
 await page.getByRole('button',{name:'Close browser tab',exact:true}).filter({visible:true}).click();await delay(200)
 assert(!(await views()).find(v=>v.id===id).visible);report.closedTabHidden=true
}catch(error){report.error=error.stack;process.exitCode=1;if(page)await page.screenshot({path:join(evidence,'failure.png')}).catch(()=>{})}
finally{
 if(app){try{for(const s of(await invoke('terminal.list')).sessions)await invoke('terminal.close',{sessionId:s.id});await app.close()}catch(error){report.cleanupError=String(error);process.exitCode=1;await app.close().catch(()=>{})}}
 report.idleDaemonStopped=await cleanupOwnedSmokeDaemon(profile);await new Promise(resolve=>server.close(resolve));writeFileSync(join(evidence,'result.json'),JSON.stringify(report,null,2)+'\n')
}
