import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createRequire} from 'node:module'
import {fileURLToPath,pathToFileURL} from 'node:url'
const {_electron}=await import(process.env.DONWELLS_PLAYWRIGHT_MODULE?pathToFileURL(process.env.DONWELLS_PLAYWRIGHT_MODULE).href:'playwright')
import {closeOwnedSmokeApp,cleanupOwnedSmokeDaemon,delay} from '../helpers/smoke-processes.mjs'
const root=fileURLToPath(new URL('../..',import.meta.url))
const profile=realpathSync(mkdtempSync(join(tmpdir(),'donwells-overlap-'))),project=join(profile,'project')
mkdirSync(project);writeFileSync(join(project,'shared.txt'),'base\n')
const git=(...args)=>execFileSync('git',args,{cwd:project,encoding:'utf8'})
git('init','-q');git('config','user.name','Trial');git('config','user.email','trial@localhost');git('add','.');git('-c','user.name=Trial','-c','user.email=trial@localhost','commit','-qm','Base')
const env={...process.env,DONWELLS_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL
let app,page,session;const report={profile,checks:[]}
try {
 app=await _electron.launch({executablePath:createRequire(join(root,'package.json'))('electron'),args:[root],env});page=await app.firstWindow();page.setDefaultTimeout(12000)
 await page.waitForFunction(()=>window.__store?.getState().loading===false)
 await page.evaluate(async p=>{const s=window.__store.getState();await s.addRepo(p);s.setActiveWorktree(p);s.setSettings({theme:'dark'})},project)
 const started=await page.evaluate(p=>window.__store.getState().runAgent(p,{executable:'/bin/cat',args:[]},{intent:'First shared edit',files:['shared.txt']}),project)
 assert(started.ok,JSON.stringify(started));session=started.run?.sessionId
 const showOverlap=async()=>{
  await page.evaluate(()=>window.__store.getState().openRuns('agents'))
  await page.locator('summary').filter({hasText:'Task and file scope'}).click()
  await page.getByLabel('Task intent',{exact:true}).fill('Second shared edit')
  await page.getByLabel('Intended files or directories').fill('shared.txt')
  const section=page.getByRole('region',{name:'Overlapping session ownership'})
  await section.getByText('1 session(s) may overlap.',{exact:true}).waitFor();return section
 }
 let overlap=await showOverlap();await overlap.getByRole('button',{name:'Open owner terminal',exact:true}).click()
 await page.waitForFunction(()=>window.__store.getState().runsOpen===false);report.checks.push('Overlap routes directly to retained owner terminal')
 overlap=await showOverlap();await overlap.getByRole('button',{name:'Review checkout changes',exact:true}).click()
 await page.waitForFunction(p=>{const s=window.__store.getState();return s.activeWorktreePath===p&&s.rightSidebarTab==='git'&&s.rightSidebarOpen&&!s.runsOpen},project)
 report.checks.push('Overlap selects exact checkout and its changes view')
 overlap=await showOverlap();await overlap.getByRole('button',{name:'Review or save handoff',exact:true}).click()
 await page.waitForFunction(p=>{const s=window.__store.getState();return s.activeWorktreePath===p&&s.rightSidebarTab==='memory'&&s.rightSidebarOpen&&!s.runsOpen},project)
 report.checks.push('Overlap selects exact checkout and shared handoff view')
 assert.equal(readFileSync(join(project,'shared.txt'),'utf8'),'base\n');assert.equal(git('status','--porcelain').trim(),'')
 await page.screenshot({path:join(profile,'handoff-route.png')});
 const original=git('branch','--show-current').trim();git('checkout','-qb','peer');writeFileSync(join(project,'shared.txt'),'peer\n');git('commit','-am','Peer');git('checkout',original);writeFileSync(join(project,'shared.txt'),'main\n');git('commit','-am','Main');assert.throws(()=>git('merge','peer'));const conflicted=readFileSync(join(project,'shared.txt'),'utf8');assert(conflicted.includes('<<<<<<<'));
 await page.evaluate(p=>{const s=window.__store.getState();s.setActiveWorktree(p);s.setRightSidebarTab('git')},project);await page.getByRole('button',{name:'shared.txt',exact:true}).first().click();assert.equal(readFileSync(join(project,'shared.txt'),'utf8'),conflicted);
 await page.evaluate(async p=>{const f=await window.donwells.readFile(p,'shared.txt');await window.donwells.writeFile(p,'shared.txt','resolved main and peer\n',f.revision);window.__store.getState().setRightSidebarTab('git')},project);
 await page.getByRole('checkbox',{name:'Select shared.txt',exact:true}).first().check();await page.getByRole('button',{name:'Stage (1)',exact:true}).click();await page.getByRole('textbox',{name:'Commit message',exact:true}).fill('Resolve both edits deliberately');await page.getByRole('button',{name:'Commit 1',exact:true}).click();await page.getByText('Commit created.',{exact:true}).waitFor();assert.equal(git('status','--porcelain').trim(),'');assert.equal(git('show','-s','--format=%P','HEAD').trim().split(' ').length,2);report.checks.push('Conflicting native Git edits stay unchanged on review; explicit resolution, UI stage and commit produce a two-parent merge');report.passed=true
}catch(error){report.error=String(error);process.exitCode=1}
finally {
 if(app){await page.evaluate(async()=>{for(const run of Object.values(window.__store.getState().runningAgents)){await window.donwells.agentStop(run.sessionId);for(let i=0;i<100;i++){const t=(await window.donwells.attachTerminal(run.sessionId));if(t.session?.exited)break;await new Promise(r=>setTimeout(r,50))}await window.donwells.agentDismiss(run.sessionId)}for(const t of Object.values(window.__store.getState().terminals))await window.donwells.closeTerminal(t.session.id).catch(()=>{})}).catch(()=>{});report.appCleanup=await closeOwnedSmokeApp(app)}
 report.daemonCleanup=await cleanupOwnedSmokeDaemon(profile);writeFileSync(join(profile,'result.json'),JSON.stringify(report,null,2)+'\n')
}console.log(report)
