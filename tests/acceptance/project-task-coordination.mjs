import assert from 'node:assert/strict'
import {mkdirSync,readFileSync,writeFileSync,realpathSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'
import {hash,sourceIdentity,validateOptions} from './workspace-baseline.mjs'
import {cleanupOwnedSmokeDaemon,delay} from '../helpers/smoke-processes.mjs'
const {values}=parseArgs({options:{app:{type:'string'},profile:{type:'string'},evidence:{type:'string'},playwright:{type:'string'},backlog:{type:'string'}}})
const {app:executable,resources,profile,evidence}=validateOptions(values)
mkdirSync(profile);mkdirSync(evidence);mkdirSync(join(profile,'fixture'));const project=realpathSync(join(profile,'fixture'))
const git=(cwd,...args)=>execFileSync('git',args,{cwd,stdio:'ignore'})
const native=(...args)=>execFileSync(resolve(values.backlog),args,{cwd:project,env:{...process.env,BACKLOG_CWD:project},encoding:'utf8'})
git(project,'init','-b','main');git(project,'config','user.email','fixture@example.test');git(project,'config','user.name','Fixture')
writeFileSync(join(project,'shared.txt'),'base\n')
native('init','Fixture','--defaults','--integration-mode','none','--check-branches','false','--include-remote','false','--auto-open-browser','false');native('task','create','Repair shared editor','--plain');git(project,'add','.');git(project,'commit','-m','Fixture')
const {_electron}=await import(pathToFileURL(resolve(values.playwright)))
const {callRuntime}=await import(pathToFileURL(join(resources,'dist-cli/cli/rpc-client.js')))
const invoke=async(method,params={})=>{const result=await callRuntime(method,params,profile,45000);assert(result.ok,result.error);return result.result}
const env={...process.env,DONWELLS_USER_DATA:profile,DONWELLS_BACKLOG_BINARY:resolve(values.backlog)};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;delete env.DONWELLS_SMOKE
const report={source:sourceIdentity(),packageExecutable:executable,artifactSha256:hash(readFileSync(join(resources,'app.asar'))),project,nativeBinarySha256:hash(readFileSync(values.backlog))}
let app,page
const open=async()=>{app=await _electron.launch({executablePath:executable,env});page=await app.firstWindow();await page.getByRole('navigation',{name:'Workspace tools'}).waitFor()}
const waitOutput=async(sessionId,pattern)=>{for(let i=0;i<100;i++){const output=await page.evaluate(async id=>(await window.donwells.attachTerminal(id)).scrollback,sessionId);if(pattern.test(output))return output;await delay(100)}throw new Error('Native terminal output missing: '+pattern)}
try {
 await open();await invoke('settings.set',{theme:'dark'});const repo=await invoke('repo.add',{dir:project});await page.getByRole('button',{name:/Main checkout/}).click()
 report.beforeOptIn=await invoke('project.tasks',{workspacePath:project});assert.equal(report.beforeOptIn.authority,null);assert.equal(report.beforeOptIn.tasks.length,0)
 await page.getByRole('button',{name:'Agent sessions',exact:true}).click();await page.locator('summary').filter({hasText:'Task and file scope'}).click();await page.locator('summary').filter({hasText:'Project tasks and native tools'}).click();await page.getByLabel("Use Backlog.md as this project's task authority").check()
 for(let i=0;i<100;i++){report.nativeTasks=await invoke('project.tasks',{workspacePath:project});if(report.nativeTasks.tasks.length)break;await delay(100)}
 assert.equal(report.nativeTasks.tasks[0].id,'TASK-1')
 native('task','edit','TASK-1','--status','In Progress','--plain');assert.equal((await invoke('project.tasks',{workspacePath:project})).tasks[0].status,'In Progress')
 const task={intent:'Repair shared editor',files:['shared.txt'],externalId:'TASK-1'}
 const first=await invoke('agent.start',{workspacePath:project,launch:{executable:'/bin/cat',args:[]},task});report.first=first.run;assert.deepEqual(first.run.task,task)
 await page.getByLabel('Task intent',{exact:true}).fill('Second editor change');await page.getByLabel('Intended files or directories').fill('shared.txt');await page.getByText('1 session(s) may overlap.',{exact:true}).waitFor();await page.screenshot({path:join(evidence,'shared-intent.png')})
 await page.getByRole('button',{name:'Close runs',exact:true}).click()
 const repoId=repo.repo?.id??(await invoke('repo.list')).repos.find(item=>item.repo.path===project).repo.id
 const created=await invoke('worktree.create',{repoId,name:'isolated-editor',branch:'main'});const peer=created.worktrees.find(tree=>!tree.isMain);assert(peer)
 const second=await invoke('agent.start',{workspacePath:peer.path,launch:{executable:'/bin/cat',args:[]},task:{intent:'Isolated editor change',files:['shared.txt']}});report.second=second.run;assert.notEqual(first.run.workspacePath,second.run.workspacePath)
 await app.close();await open();const retained=(await invoke('agent.list')).agents;assert.deepEqual(retained.find(run=>run.sessionId===first.run.sessionId).task,task);report.retainedAcrossAppRestart=true
 await page.getByRole('button',{name:/Main checkout/}).click();await page.getByRole('button',{name:'Agent sessions',exact:true}).click();await page.getByLabel('Agent checkout').selectOption(peer.path);assert.equal(await page.getByText('1 session(s) may overlap.',{exact:true}).count(),1);await page.screenshot({path:join(evidence,'isolated-intent.png')});await page.getByRole('button',{name:'Close runs',exact:true}).click()
 writeFileSync(join(peer.path,'shared.txt'),'peer change\n');git(peer.path,'add','shared.txt');git(peer.path,'commit','-m','Peer edit');writeFileSync(join(project,'shared.txt'),'main change\n');git(project,'add','shared.txt');git(project,'commit','-m','Main edit');assert.throws(()=>git(project,'merge',peer.branch))
 const conflict=readFileSync(join(project,'shared.txt'));await invoke('ui.diff.open',{worktreePath:project,relPath:'shared.txt'});assert((await invoke('git.status',{worktreePath:project})).entries.some(entry=>entry.conflict));await page.screenshot({path:join(evidence,'conflict-review.png')});assert.deepEqual(readFileSync(join(project,'shared.txt')),conflict);report.conflictPreservedSha256=hash(conflict)
 await invoke('ui.sidebar',{side:'right',open:true,tab:'git'});const previous=new Set((await invoke('terminal.list')).sessions.map(session=>session.id));await page.getByRole('button',{name:'Lazygit',exact:true}).click();let lazy;for(let i=0;i<100;i++){lazy=(await invoke('terminal.list')).sessions.find(session=>!previous.has(session.id));if(lazy)break;await delay(100)}assert(lazy);await invoke('ui.sidebar',{side:'right',open:false});await page.getByRole('button',{name:'Layout',exact:true}).click();await page.getByRole('button',{name:'Focus',exact:true}).click();report.lazygitOutput=await waitOutput(lazy.id,/Files/);if(report.lazygitOutput.includes('get started')){await page.locator(`[data-pane-key="term:${lazy.id}"] .xterm-helper-textarea`).focus();await page.keyboard.press('Enter')}await delay(500);report.lazygitOutput=await page.evaluate(async id=>(await window.donwells.attachTerminal(id)).scrollback,lazy.id);await page.screenshot({path:join(evidence,'lazygit.png')})
 await page.getByRole('button',{name:'Agent sessions',exact:true}).click();await page.locator('summary').filter({hasText:'Task and file scope'}).click();await page.locator('summary').filter({hasText:'Project tasks and native tools'}).click()
 const oldBoards=new Set((await invoke('terminal.list')).sessions.map(session=>session.id));await page.getByRole('button',{name:'Open Backlog board',exact:true}).click();let board;for(let i=0;i<100;i++){board=(await invoke('terminal.list')).sessions.find(session=>!oldBoards.has(session.id));if(board)break;await delay(100)}assert(board);report.backlogOutput=await waitOutput(board.id,/TASK-1|Repair shared editor/);await page.screenshot({path:join(evidence,'backlog-board.png')})
 assert.deepEqual(readFileSync(join(project,'shared.txt')),conflict);report.verified=true
} catch(error){report.error=error.stack;process.exitCode=1;if(page)await page.screenshot({path:join(evidence,'failure.png')}).catch(()=>{})}
finally {
 if(app){try{for(const run of(await invoke('agent.list')).agents){if(run.liveness!=='exited')await invoke('agent.stop',{sessionId:run.sessionId});for(let i=0;i<100;i++){if((await invoke('agent.list')).agents.find(item=>item.sessionId===run.sessionId)?.liveness==='exited')break;await delay(50)}await invoke('agent.dismiss',{sessionId:run.sessionId})}for(const session of(await invoke('terminal.list')).sessions)await invoke('terminal.close',{sessionId:session.id})}catch(error){report.cleanupError=String(error);process.exitCode=1}await app.close().catch(()=>{})}
 for(const key of ['lazygitOutput','backlogOutput'])if(report[key]){const text=report[key];writeFileSync(join(evidence,key+'.txt'),text);report[key]={sha256:hash(Buffer.from(text)),bytes:Buffer.byteLength(text)}}
 report.idleDaemonStopped=await cleanupOwnedSmokeDaemon(profile);writeFileSync(join(evidence,'result.json'),JSON.stringify(report,null,2)+'\n')
}
