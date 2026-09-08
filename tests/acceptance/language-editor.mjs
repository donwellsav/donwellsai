import assert from 'node:assert/strict'
import {cpSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,realpathSync} from 'node:fs'
import {join,resolve,dirname} from 'node:path'
import {pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'
import {createRequire} from 'node:module'
import {execFileSync} from 'node:child_process'
import {cleanupOwnedSmokeDaemon,closeOwnedSmokeApp,delay} from '../helpers/smoke-processes.mjs'
import {sourceIdentity,hash} from './workspace-baseline.mjs'
const {values}=parseArgs({options:{app:{type:'string'},root:{type:'string'},playwright:{type:'string'},evidence:{type:'string'},typescript:{type:'string'}}})
assert(values.root&&values.playwright&&values.evidence,'--root --playwright --evidence required; run after build')
const root=realpathSync(values.root), evidence=resolve(values.evidence)
mkdirSync(evidence,{recursive:true})
const typescript=values.typescript?realpathSync(values.typescript):null
const typescriptVersion=typescript?JSON.parse(readFileSync(join(typescript,'package.json'),'utf8')).version:null
if(typescript)assert(typeof typescriptVersion==='string','--typescript must point to an installed TypeScript package')
const profile=mkdtempSync('/tmp/donwells25-language-live-')
const projects=['a','b'].map(name=>{const path=join(profile,name);mkdirSync(path);return realpathSync(path)})
const installed=values.app?{app:realpathSync(values.app),resources:resolve(dirname(realpathSync(values.app)),'../Resources')}:null
if(installed)assert(installed.app.endsWith('.app/Contents/MacOS/donwells'),'--app must be a packaged donwells executable')
const executable=installed?.app??join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const {_electron}=await import(pathToFileURL(resolve(values.playwright)))
const {callRuntime}=await import(pathToFileURL(join(installed?.resources??root,'dist-cli/cli/rpc-client.js')))
const invoke=async(method,params={})=>{const reply=await callRuntime(method,params,profile,30000);assert(reply.ok,reply.error);return reply.result}
for(const project of projects){
 if(typescript){mkdirSync(join(project,'node_modules'));cpSync(typescript,join(project,'node_modules/typescript'),{recursive:true,dereference:true});if(Number(typescriptVersion.split('.')[0])>=7){const name='@typescript/typescript-'+process.platform+'-'+process.arch;const source=dirname(createRequire(join(typescript,'package.json')).resolve(name+'/package.json'));cpSync(source,join(project,'node_modules',name),{recursive:true,dereference:true})}}
 writeFileSync(join(project,'.gitignore'),'node_modules/\n')
 writeFileSync(join(project,'nullable.ts'),'export const optional: string = null;\n')
 writeFileSync(join(project,'globals.ts'),project===projects[0]?'const shared: string = 42;\n':'const shared: number = 1;\n')
 writeFileSync(join(project,'defs.ts'),'export function greet(name: string) { return name; }\n')
 writeFileSync(join(project,'main.ts'),"import { greet } from './defs';\ngreet(123);\n")
 writeFileSync(join(project,'tsconfig.json'),JSON.stringify({compilerOptions:{strict:project===projects[0],noEmit:true},include:['*.ts']}))
 const tsc=join(typescript?project:root,'node_modules/typescript/bin/tsc');assert(!tsc.includes("'"))
 writeFileSync(join(project,'package.json'),JSON.stringify({scripts:{typecheck:`node '${tsc}' --noEmit`}}))
 for(const args of [['init','-b','main'],['config','user.name','Fixture'],['config','user.email','fixture@example.test'],['add','.'],['commit','-m','Language fixture']])execFileSync('git',args,{cwd:project,stdio:'ignore'})
}
const report={profile,source:sourceIdentity(),buildMainSha256:hash(readFileSync(join(root,'out/main/index.js'))),packaged:!!installed,...(installed?{artifactSha256:hash(readFileSync(join(installed.resources,'app.asar')))}:{}),typescriptSource:typescript,checks:[],errors:[]}
let app,page
const open=async(project,file)=>{
 await page.evaluate(async({project,file})=>{const store=window.__store.getState();store.setActiveWorktree(project);await store.openPreview(project,file)}, {project,file})
 await page.waitForFunction(({project,file})=>window.monaco.editor.getEditors().some(e=>e.getModel()?.uri.fsPath===project+'/'+file),{project,file})
}
const markers=()=>page.evaluate(()=>window.monaco.editor.getModelMarkers({}).map(m=>({path:m.resource.fsPath,code:m.code,message:m.message,source:m.source})))
const waitRun=async id=>{const deadline=Date.now()+45000;while(Date.now()<deadline){const reply=await callRuntime('verification.list',{workspacePath:projects[0]},profile,Math.max(1,deadline-Date.now()));assert(reply.ok,reply.error);const row=reply.result.find(r=>r.runId===id);if(row&&['succeeded','failed','cancelled'].includes(row.task.status)&&row.task.verification?.finishedAt)return row;await delay(Math.min(100,Math.max(0,deadline-Date.now())))}throw Error('Typecheck did not finish within45s')}
try{
 const env={...process.env,DONWELLS_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;delete env.DONWELLS_SMOKE
 app=await _electron.launch({executablePath:executable,args:installed?[]:[root],env});page=await app.firstWindow()
 page.on('pageerror',error=>report.errors.push(error.message))
 await page.waitForFunction(()=>!!window.__store)
 await invoke('settings.set',{theme:'dark',editorAutoSaveMode:'manual'})
 for(const project of projects){await invoke('repo.add',{dir:project});await page.evaluate(()=>window.__store.getState().refresh());await open(project,'globals.ts')}
 await page.waitForFunction(project=>window.monaco.editor.getModelMarkers({}).some(m=>m.resource.fsPath===project+'/globals.ts'&&m.code==='2322'),projects[0])
 if(typescript){report.languageOwners=await page.evaluate(async projects=>Promise.all(projects.map(p=>window.donwells.projectLanguageStatus(p))),projects);assert(report.languageOwners.every(owner=>owner.state==='ready'&&owner.version===typescriptVersion));assert.notEqual(report.languageOwners[0].pid,report.languageOwners[1].pid);await page.waitForFunction(project=>window.monaco.editor.getModelMarkers({}).some(m=>m.resource.fsPath===project+'/globals.ts'&&m.source==='TypeScript · project'),projects[0])}
 report.isolatedMarkers=await markers();assert(!report.isolatedMarkers.some(m=>m.path.startsWith(projects[1])))
 assert(!report.isolatedMarkers.some(m=>m.code==='2451'))
 report.checks.push('same global identifier in two checkouts is isolated')
 if(typescript){
  for(const project of projects)await open(project,'nullable.ts')
  await page.waitForFunction(project=>window.monaco.editor.getModelMarkers({}).some(m=>m.resource.fsPath===project+'/nullable.ts'&&m.code==='2322'&&m.source==='TypeScript · project'),projects[0])
  const diagnostics=await page.evaluate(project=>window.donwells.projectLanguageDiagnostics({workspacePath:project,path:'nullable.ts',version:1,content:'export const optional: string = null;\n'}),projects[1]);assert.equal(diagnostics.diagnostics.length,0)
  report.checks.push(`project-local TypeScript ${typescriptVersion} uses incompatible strict-null tsconfigs in two isolated processes`)
 }else await open(projects[0],'defs.ts')
 await open(projects[0],'main.ts')
 if(typescript)assert(await page.evaluate(project=>!window.monaco.editor.getModels().some(model=>model.uri.fsPath===project+'/defs.ts'),projects[0]),'definition target must be unopened')
 await page.waitForFunction(project=>window.monaco.editor.getModelMarkers({}).some(m=>m.resource.fsPath===project+'/main.ts'&&m.code==='2345'),projects[0])
 await page.evaluate(({project,native})=>{const e=window.monaco.editor.getEditors().find(e=>e.getModel()?.uri.fsPath===project+'/main.ts');e.focus();e.setPosition({lineNumber:2,column:2});return e.getAction(native?'donwells.projectDefinition':'editor.action.revealDefinition').run()},{project:projects[0],native:!!typescript})
 await page.waitForFunction(project=>window.__store.getState().activePane[project]==='preview:defs.ts',projects[0])
 report.checks.push(typescript?'project language definition action opens an unopened file':'native TypeScript definition action opens target through workspace navigation')
 if(typescript){
  for(let attempt=0;attempt<4;attempt++){await page.evaluate(project=>{const e=window.monaco.editor.getEditors().find(e=>e.getModel()?.uri.fsPath===project+'/defs.ts');e.setPosition({lineNumber:1,column:18});return e.getAction('donwells.projectReferences').run()},projects[0]);if(await page.evaluate(project=>window.__store.getState().activePane[project]==='preview:main.ts',projects[0]))break}
  await page.waitForFunction(project=>window.__store.getState().activePane[project]==='preview:main.ts',projects[0])
  report.references=await page.evaluate(async project=>{return window.donwells.projectLanguageReferences({workspacePath:project,path:'defs.ts',version:1,content:'export function greet(name: string) { return name; }\n'},1,18)},projects[0])
  assert(report.references.references.some(ref=>ref.path==='main.ts'))
  report.checks.push('project references editor action navigates to main.ts; actual server receipt identifies caller')
 }
 await open(projects[0],'main.ts')
 await page.evaluate(project=>{const e=window.monaco.editor.getEditors().find(e=>e.getModel()?.uri.fsPath===project+'/main.ts');e.executeEdits('acceptance',[{range:e.getModel().getFullModelRange(),text:"import { greet } from './defs';\ngreet('world');\n"}]);e.focus()},projects[0])
 await page.keyboard.press('Meta+s')
 for(let i=0;i<100&&readFileSync(join(projects[0],'main.ts'),'utf8').includes('123');i++)await delay(100)
 assert(!readFileSync(join(projects[0],'main.ts'),'utf8').includes('123'))
 await open(projects[0],'globals.ts')
 await page.evaluate(project=>{const e=window.monaco.editor.getEditors().find(e=>e.getModel()?.uri.fsPath===project+'/globals.ts');window.__languageOriginalModel=e.getModel();e.executeEdits('acceptance',[{range:e.getModel().getFullModelRange(),text:'const shared: string = "fixed";\n'}]);e.pushUndoStop()},projects[0])
 await page.waitForFunction(project=>!window.monaco.editor.getModelMarkers({}).some(m=>m.resource.fsPath===project+'/globals.ts'),projects[0])
 const previousLanguage=typescript?await page.evaluate(project=>window.donwells.projectLanguageStatus(project),projects[0]):null
 const worker=page.workers().find(w=>w.url().includes('typescript-worker'));assert(worker,'Actual isolated TypeScript worker missing')
 await worker.evaluate(()=>self.close())
 await page.evaluate(project=>window.monaco.editor.getEditors().find(e=>e.getModel()?.uri.fsPath===project+'/globals.ts').getAction('donwells.restartLanguageTools').run(),projects[0])
 if(typescript){const restarted=await page.evaluate(project=>window.donwells.projectLanguageStatus(project),projects[0]);assert(restarted.generation>previousLanguage.generation);assert.notEqual(restarted.pid,previousLanguage.pid);assert(readFileSync(join(projects[0],'globals.ts'),'utf8').includes('42'));await page.waitForFunction(project=>!window.monaco.editor.getModelMarkers({}).some(m=>m.resource.fsPath===project+'/globals.ts'),projects[0]);report.checks.push('explicit language-server restart preserves unsaved text without writing disk')}
 await page.evaluate(project=>{const e=window.monaco.editor.getEditors().find(e=>e.getModel()?.uri.fsPath===project+'/globals.ts');assertSame();function assertSame(){if(e.getModel()!==window.__languageOriginalModel)throw Error('Model replaced')}return e.getModel().undo()},projects[0])
 await page.waitForFunction(project=>window.monaco.editor.getModelMarkers({}).some(m=>m.resource.fsPath===project+'/globals.ts'&&m.code==='2322'),projects[0])
 report.checks.push('worker termination and restart preserve model and undo; diagnostics return')
 await page.evaluate(project=>{window.__originalWorkerFactory=window.MonacoEnvironment.getWorker;window.MonacoEnvironment.getWorker=(id,label)=>{if(label==='typescript')throw Error('acceptance missing worker');return window.__originalWorkerFactory(id,label)};return window.monaco.editor.getEditors().find(e=>e.getModel()?.uri.fsPath===project+'/globals.ts').getAction('donwells.restartLanguageTools').run()},projects[0])
 await page.waitForFunction(()=>window.__store.getState().error?.includes('acceptance missing worker'))
 report.missingWorkerError=await page.evaluate(()=>window.__store.getState().error)
 await page.evaluate(project=>{window.MonacoEnvironment.getWorker=window.__originalWorkerFactory;window.__store.getState().setError(null);return window.monaco.editor.getEditors().find(e=>e.getModel()?.uri.fsPath===project+'/globals.ts').getAction('donwells.restartLanguageTools').run()},projects[0])
 await page.waitForFunction(project=>window.monaco.editor.getModelMarkers({}).some(m=>m.resource.fsPath===project+'/globals.ts'&&m.code==='2322'),projects[0])
 report.checks.push('missing worker reports a recoverable error and restart restores checks')
 report.failedTypecheck=await waitRun((await invoke('verification.run',{workspacePath:projects[0],script:'typecheck'})).id)
 assert.equal(report.failedTypecheck.task.status,'failed')
 await page.evaluate(project=>{const e=window.monaco.editor.getEditors().find(e=>e.getModel()?.uri.fsPath===project+'/globals.ts');e.executeEdits('acceptance',[{range:e.getModel().getFullModelRange(),text:'const shared: string = "fixed";\n'}]);e.focus()},projects[0])
 await page.keyboard.press('Meta+s')
 for(let i=0;i<100&&readFileSync(join(projects[0],'globals.ts'),'utf8').includes('42');i++)await delay(100)
 assert.equal(readFileSync(join(projects[0],'globals.ts'),'utf8'),'const shared: string = "fixed";\n')
 if(typescript){
  await open(projects[0],'nullable.ts')
  await page.evaluate(project=>{const e=window.monaco.editor.getEditors().find(e=>e.getModel()?.uri.fsPath===project+'/nullable.ts');e.executeEdits('acceptance',[{range:e.getModel().getFullModelRange(),text:'export const optional: string = "fixed";\n'}]);e.focus()},projects[0])
  await page.keyboard.press('Meta+s')
  for(let i=0;i<100&&readFileSync(join(projects[0],'nullable.ts'),'utf8').includes('= null');i++)await delay(100)
  assert.equal(readFileSync(join(projects[0],'nullable.ts'),'utf8'),'export const optional: string = "fixed";\n')
 }
 report.passedTypecheck=await waitRun((await invoke('verification.run',{workspacePath:projects[0],script:'typecheck'})).id)
 assert.equal(report.passedTypecheck.task.status,'succeeded')
 report.checks.push('native project TypeScript command fails then passes after editor save')
 await page.screenshot({path:join(evidence,'editor.png')})
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1100,720))
 await page.getByRole('button',{name:'New project',exact:true}).click()
 const dialog=page.getByRole('dialog')
 await dialog.getByLabel('Project name',{exact:true}).fill('workflow-example')
 await dialog.getByLabel('Location',{exact:true}).fill(profile)
 await dialog.getByRole('checkbox',{name:/App workflow/}).check()
 await dialog.getByText('Review the three files before creation',{exact:true}).click()
 await dialog.locator('summary').filter({hasText:'.agents/skills/app-workflow/SKILL.md'}).click()
 await dialog.getByRole('button',{name:'Create project',exact:true}).scrollIntoViewIfNeeded()
 assert(await dialog.getByRole('button',{name:'Create project',exact:true}).isVisible())
 await page.screenshot({path:join(evidence,'workflow-review.png')})
 await dialog.getByRole('button',{name:'Create project',exact:true}).click()
 await dialog.waitFor({state:'hidden'})
 const workflow=join(profile,'workflow-example')
 assert(readFileSync(join(workflow,'SPEC.md'),'utf8').includes('Workflow version: 1.0.0'))
 assert(readFileSync(join(workflow,'TASKS.md'),'utf8').includes('actual outcomes'))
 assert(readFileSync(join(workflow,'.agents/skills/app-workflow/SKILL.md'),'utf8').includes('grants no tool access'))
 report.checks.push('reviewed workflow contents and created exact versioned files in a 1100x720 window')
 assert(report.errors.every(error=>error.startsWith('acceptance missing worker')),JSON.stringify(report.errors))
 report.verified=true
}catch(error){report.error=error.stack;process.exitCode=1;if(page)await page.screenshot({path:join(evidence,'failure.png')}).catch(()=>{})}
finally{
 if(app){try{for(const session of(await invoke('terminal.list')).sessions)await invoke('terminal.close',{sessionId:session.id})}catch(error){report.cleanupError=String(error)}report.appShutdown=await closeOwnedSmokeApp(app)}
 report.daemonStopped=await cleanupOwnedSmokeDaemon(profile)
 writeFileSync(join(evidence,'result.json'),JSON.stringify(report,null,2)+'\n')
 console.log(JSON.stringify({verified:report.verified,error:report.error,checks:report.checks,errors:report.errors,daemonStopped:report.daemonStopped},null,2))
}
