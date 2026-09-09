// Real source-built Electron check. Supply an installed Playwright module; owns a disposable profile only.
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createServer} from 'node:http'
import {parseArgs} from 'node:util'
import {pathToFileURL} from 'node:url'
import {createRequire} from 'node:module'
import {cleanupOwnedSmokeDaemon,closeOwnedSmokeApp,delay} from '../helpers/smoke-processes.mjs'
const {values}=parseArgs({options:{playwright:{type:'string'},evidence:{type:'string'},app:{type:'string'}}})
assert(values.playwright&&values.evidence,'Supply --playwright and --evidence; build the source app first')
const {_electron}=await import(pathToFileURL(resolve(values.playwright)).href)
const profile=mkdtempSync(join(tmpdir(),'donwells-partition-profile-'));const first=join(profile,'first'),second=join(profile,'second');mkdirSync(first);mkdirSync(second)
const server=createServer((_q,r)=>{r.setHeader('Content-Type','text/html');r.end('<title>Checkout preview</title><input id="draft"><p>Storage boundary</p>')});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`
const env={...process.env,DONWELLS_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL
const report={profile,checks:[],limitations:['Disposable local previews; does not cover all browser features.'],artifact:values.app ?? 'source build'};let app,page
try{
 app=await _electron.launch({executablePath:values.app ? resolve(values.app) : createRequire(import.meta.url)('electron'),args:values.app ? [] : [resolve('.')],env});page=await app.firstWindow();page.setDefaultTimeout(10000);await page.waitForFunction(()=>window.__store?.getState().loading===false)
 await app.evaluate(async({session},origin)=>{await session.fromPartition('persist:donwells-browser').cookies.set({url:origin,name:'legacy',value:'preserved'})},origin)
 for(const path of[first,second])await page.evaluate(path=>window.__store.getState().addRepo(path),path)
 const a=realpathSync(first),b=realpathSync(second)
 const open=async(path,url)=>{await page.evaluate(async({path,url})=>{const s=window.__store.getState();s.setActiveWorktree(path);await s.openBrowser(path,url)},{path,url});await page.waitForTimeout(150)}
 const view=async(url,script)=>app.evaluate(async({BrowserWindow},{url,script})=>{const child=BrowserWindow.getAllWindows()[0].contentView.children.find(v=>'webContents'in v&&v.webContents.getURL()===url);if(!child)throw new Error('Preview absent: '+url);return {id:child.webContents.id,value:await child.webContents.executeJavaScript(script)}},{url,script})
 await open(a,origin+'/a');assert.equal((await view(origin+'/a','document.cookie')).value,'');const firstView=await view(origin+'/a',`localStorage.setItem('checkout','A');document.cookie='owner=A';document.querySelector('#draft').value='unsaved A';true`)
 await open(b,origin+'/b');assert.equal((await view(origin+'/b',`JSON.stringify([localStorage.getItem('checkout'),document.cookie])`)).value,'[null,""]');await view(origin+'/b',`localStorage.setItem('checkout','B');true`)
 await page.evaluate(path=>window.__store.getState().setActiveWorktree(path),a);const retained=await view(origin+'/a',`JSON.stringify([localStorage.getItem('checkout'),document.cookie,document.querySelector('#draft').value])`);assert.equal(retained.id,firstView.id);assert.equal(retained.value,'["A","owner=A","unsaved A"]');report.checks.push('Same-origin previews have distinct cookies/localStorage','Switch/hide retains original guest and unsaved page value')
 await assert.rejects(()=>page.evaluate(()=>window.donwells.browserSiteDataClear('/unregistered/privacy-check')),/registered|workspace|exist|directory/i)
 await page.evaluate(path=>window.donwells.browserSiteDataClear(path),a)
 assert.equal((await view(origin+'/a',`JSON.stringify([localStorage.getItem('checkout'),document.cookie])`)).value,'[null,""]')
 assert.equal((await view(origin+'/b',`localStorage.getItem('checkout')`)).value,'B')
 report.checks.push('Site-data clear removes actual cookies and localStorage only for selected checkout','Unregistered clear target rejected')
 const legacy=await app.evaluate(async({session},origin)=>session.fromPartition('persist:donwells-browser').cookies.get({url:origin}),origin);assert.equal(legacy.find(c=>c.name==='legacy')?.value,'preserved');report.checks.push('Legacy shared cookie preserved without copying into checkouts')
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1000,700));await delay(200);report.window=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));report.passed=true
}finally{
 if(app){await page.evaluate(async()=>{for(const t of Object.values(window.__store.getState().terminals))await window.donwells.closeTerminal(t.session.id)}).catch(()=>{});report.appCleanup=await closeOwnedSmokeApp(app)}
 report.daemonCleanup=await cleanupOwnedSmokeDaemon(profile);await new Promise(r=>server.close(r));writeFileSync(resolve(values.evidence),JSON.stringify(report,null,2)+'\n')
}
console.log(JSON.stringify(report))
