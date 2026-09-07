import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, symlinkSync, renameSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { OperationalRunService, openVerificationArtifact } from '../src/main/operational-run-service'
import { GitWorktrees } from '../src/main/git'
import { Store } from '../src/main/store'
import { runProcess } from '../src/shared/child-process/run-process'
import { DiffReviewService } from '../src/main/diff-review'
import { createDiffReviewSnapshot, createDiffReviewAnchor } from '../src/shared/diff-review'
import { shellCommand } from '../src/main/agents/provider-hooks'
import type { DaemonClient } from '../src/main/daemon-client'

const cleanup:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const close of cleanup.splice(0))await close()})
async function fixture() {
 const root=realpathSync(mkdtempSync(join(tmpdir(),'donwells-evidence-17-'))),repo=join(root,'repo'),cache=join(root,'browser'),profile=join(root,'profile');for(const p of [repo,cache,profile])mkdirSync(p)
 const gitCommand=(...args:string[])=>execFileSync('git',args,{cwd:repo,stdio:'ignore'})
 gitCommand('init','-b','main');gitCommand('config','user.email','fixture@example.test');gitCommand('config','user.name','Fixture')
 writeFileSync(join(repo,'package.json'),JSON.stringify({scripts:{verify:'node -e "console.log(\'VERIFIED_17\')"'}}));writeFileSync(join(repo,'source.txt'),'before');writeFileSync(join(repo,'.gitignore'),'dist/\n');gitCommand('add','.');gitCommand('commit','-m','fixture')
 const git=new GitWorktrees(new Store(join(root,'store')));await git.addRepo(repo)
 let registered=true,unknown=false
 const jobs=new Map<string,{controller:AbortController;done:Promise<void>;exited:boolean;exitCode?:number;output:string}>()
 const opened:string[]=[]
 let service:OperationalRunService
 const terminals={
  authenticateAgent:async(credential:{token:string})=>{if(!['native-test','acp-test'].includes(credential.token))throw new Error('Invalid credential');return {id:'agent-run',sessionId:'agent-session',workspacePath:repo,liveness:'live',mode:credential.token==='acp-test'?'acp':'native'}},
  openJob:async(cwd:string,command:string)=>{
   const id=randomUUID(),controller=new AbortController(),job={controller,done:Promise.resolve(),exited:false,exitCode:undefined as number|undefined,output:''};jobs.set(id,job)
   job.done=runProcess({program:'/bin/sh',args:['-c',command],cwd,detached:true,timeoutMs:15000,signal:controller.signal,maxOutputBytes:2048}).then(result=>{job.output=result.stdout;job.exitCode=unknown?undefined:result.code??undefined},error=>{job.output=String(error);job.exitCode=undefined}).then(async()=>{job.exited=true;await service.onDaemonEvent('exit',id,job.output,job.exitCode)})
   return {id}
  },
  jobResult:async(id:string)=>{const job=jobs.get(id)!;return {exited:job.exited,exitCode:job.exitCode,output:job.output}},
  close:async(id:string)=>{const job=jobs.get(id);if(!job||job.exited)return;job.controller.abort();await job.done}
 }
 service=new OperationalRunService(profile,terminals as unknown as DaemonClient,async path=>{if(!registered||path!==repo||realpathSync(path)!==repo)throw new Error('Workspace unavailable');return repo},{source:path=>git.handoffSource(path),artifactRoots:async()=>[repo,cache],openArtifact:async(path,workspacePath,sha256)=>{expect(workspacePath).toBe(repo);expect(sha256).toMatch(/^[a-f0-9]{64}$/);opened.push(path)}})
 cleanup.push(async()=>{service.stop();for(const job of jobs.values())if(!job.exited)job.controller.abort();await Promise.all([...jobs.values()].map(job=>job.done));rmSync(root,{recursive:true,force:true})})
 const finish=async()=>{for(const job of jobs.values())await job.done}
 const start=(code:string)=>service.parallelRunStart({name:'Fixture verification',command:shellCommand([process.execPath,'-e',code],process.platform),targets:[{kind:'local',root:repo,label:'fixture'}],concurrency:1})
 return {repo,root,cache,service,finish,start,opened,unregister:()=>{registered=false},unknown:()=>{unknown=true}}
}
it('binds passing commands to dirty/untracked inputs and independently rechecks scoped artifact bytes',async()=>{
 const f=await fixture();writeFileSync(join(f.repo,'source.txt'),'dirty');writeFileSync(join(f.repo,'new.ts'),'new');writeFileSync(join(f.repo,'pnpm-lock.yaml'),'lock')
 expect(await f.service.verificationScripts(f.repo)).toEqual(['verify'])
 const run=await f.service.verificationRun(f.repo,'verify');await f.finish()
 const entry=(await f.service.verificationList(f.repo))[0]!
 expect(entry.task.status,JSON.stringify(entry.task)).toBe('succeeded');expect(entry.task.exitCode).toBe(0);expect(entry.sourceState).toBe('current')
 expect(entry.task.verification?.before?.changedFiles).toEqual(expect.arrayContaining(['source.txt','new.ts','pnpm-lock.yaml']))
 expect(entry.task.verification?.toolVersions.node).toMatch(/^v?\d/)
 mkdirSync(join(f.repo,'dist'));const artifact=join(f.repo,'dist','build.txt');writeFileSync(artifact,'build output')
 await f.service.verificationAttach(f.repo,run.id,entry.task.id,artifact)
 const trace=join(f.cache,'trace.trace');writeFileSync(trace,'native trace reference');await f.service.verificationAttach(f.repo,run.id,entry.task.id,trace)
 expect((await f.service.verificationList(f.repo,true))[0]?.artifacts.map(a=>a.state)).toEqual(['unchanged','unchanged'])
 const foreign=join(f.root,'foreign');writeFileSync(foreign,'foreign');await expect(f.service.verificationAttach(f.repo,run.id,entry.task.id,foreign)).rejects.toThrow('outside')
 const link=join(f.repo,'dist','escape');symlinkSync(foreign,link);await expect(f.service.verificationAttach(f.repo,run.id,entry.task.id,link)).rejects.toThrow()
 writeFileSync(artifact,'changed');rmSync(trace)
 expect((await f.service.verificationList(f.repo,true))[0]?.artifacts.map(a=>a.state)).toEqual(['changed','missing'])
 writeFileSync(join(f.repo,'new.ts'),'changed untracked source');expect((await f.service.verificationList(f.repo))[0]?.sourceState).toBe('stale')
 await expect(f.service.verificationRun(f.repo,'missing')).rejects.toThrow('existing package script')
})
it('separates command success from changed-during-run source and unknown exit status',async()=>{
 const f=await fixture();await f.start("require('fs').writeFileSync('source.txt','changed during run')");await f.finish()
 const changed=(await f.service.verificationList(f.repo))[0]!;expect(changed.task.status,JSON.stringify(changed.task)).toBe('succeeded');expect(changed.sourceState).toBe('changed-during-run')
 f.unknown();await f.start('console.log("unknown exit fixture")');await f.finish()
 const unknown=(await f.service.verificationList(f.repo))[0]!;expect(unknown.task.status).not.toBe('succeeded');expect(unknown.task.exitCode).toBeUndefined()
})
it('captures cancellation after termination and rejects a moved or deregistered workspace',async()=>{
 const f=await fixture(),run=await f.start('setTimeout(()=>{},10000)');await f.service.parallelRunCancel(run.id);await f.finish()
 const entry=(await f.service.verificationList(f.repo))[0]!;expect(entry.task.status).toBe('cancelled');expect(entry.task.verification?.after).not.toBeNull()
 f.unregister();await expect(f.service.verificationList(f.repo)).rejects.toThrow('unavailable');await expect(f.service.parallelRunRetry(run.id,[entry.task.id])).rejects.toThrow('unavailable')
})

it('refuses launch after the registered checkout has moved',async()=>{
 const f=await fixture();renameSync(f.repo,f.repo+'-moved')
 await expect(f.service.verificationRun(f.repo,'verify')).rejects.toThrow()
 await expect(f.service.verificationList(f.repo)).rejects.toThrow()
})

it('bounds concurrent attachments while allowing a reference to be refreshed',async()=>{
 const f=await fixture();const run=await f.start('console.log("ok")');await f.finish();mkdirSync(join(f.repo,'dist'))
 const paths=Array.from({length:17},(_,i)=>join(f.repo,'dist',String(i)))
 paths.forEach(path=>writeFileSync(path,'artifact'))
 const results=await Promise.allSettled(paths.map(path=>f.service.verificationAttach(f.repo,run.id,run.tasks[0]!.id,path)))
 expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(16)
 expect(results.filter(result=>result.status==='rejected')).toHaveLength(1)
 const entry=(await f.service.verificationList(f.repo))[0]!
 await expect(f.service.verificationAttach(f.repo,run.id,run.tasks[0]!.id,entry.artifacts[0]!.path)).resolves.toBeDefined()
})

it('opens only the recorded bytes at the action boundary and retains exact run source references', async()=>{
 const f=await fixture(),run=await f.start('console.log("artifact producer test")');await f.finish()
 const taskId=run.tasks[0]!.id,artifact=join(f.repo,'artifact.txt');writeFileSync(artifact,'reviewed bytes')
 await f.service.verificationAttach(f.repo,run.id,taskId,artifact)
 await f.service.verificationOpen(f.repo,run.id,taskId,artifact);expect(f.opened).toEqual([artifact])
 writeFileSync(artifact,'changed bytes')
 await expect(f.service.verificationOpen(f.repo,run.id,taskId,artifact)).rejects.toThrow('changed')
 expect(f.opened).toHaveLength(1)
 const references=await f.service.verificationReviewRuns(f.repo)
 expect(references[run.id+':'+taskId]).toMatchObject({status:'succeeded',exitCode:0,sourceState:'stale'})
 await expect(f.service.verificationOpen(f.repo,run.id,'foreign-task',artifact)).rejects.toThrow('does not belong')
})

it('captures only declared new or changed output bytes and authenticates both native and ACP origins', async()=>{
 const f=await fixture();mkdirSync(join(f.repo,'dist'));writeFileSync(join(f.repo,'dist','unchanged.txt'),'unchanged')
 for(const mode of ['native','acp']) {
  const command=shellCommand([process.execPath,'-e',`require('fs').writeFileSync('dist/result.txt', '${mode}')`],process.platform)
  const run=await f.service.parallelRunStart({name:'Observed output',command,targets:[{kind:'local',root:f.repo,label:'fixture'}],concurrency:1},{outputs:['dist/result.txt','dist/unchanged.txt','dist/missing.txt'],credential:{runId:'agent-run',sessionId:'agent-session',token:mode+'-test'}})
  await f.finish();const entry=(await f.service.verificationList(f.repo)).find(value=>value.runId===run.id)!
  expect(entry.task.verification?.origin).toEqual({kind:'agent',runId:'agent-run',sessionId:'agent-session',mode})
  expect(entry.task.verification?.outputs?.map(output=>output.state)).toEqual([mode==='native'?'created':'changed','unchanged','missing'])
  expect(entry.artifacts).toHaveLength(1);expect(entry.artifacts[0].relationship).toBe('observed-during-run')
  expect(JSON.stringify(entry)).not.toContain(mode+'-test')
  await f.service.verificationOpen(f.repo,run.id,entry.task.id,join(f.repo,'dist/result.txt'))
  const review=new DiffReviewService(join(f.root,'review'),{resolveWorkspace:async path=>path,runs:path=>f.service.verificationReviewRuns(path)})
  const snapshot=await createDiffReviewSnapshot({path:'source.txt',contents:'before'},{path:'source.txt',contents:'before'})
  const note=await review.create({workspacePath:f.repo,filePath:'source.txt',comparison:'working',snapshot,anchor:createDiffReviewAnchor('after',1,1,'before'),body:'Observed output reviewed',runLink:{runId:run.id,taskId:entry.task.id}})
  expect(note.runLink?.sourceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
 }
 const before=(await f.service.parallelRunsList()).length
 await expect(f.service.parallelRunStart({name:'Wrong agent',command:'true',targets:[{kind:'local',root:f.repo,label:'fixture'}],concurrency:1},{credential:{runId:'agent-run',sessionId:'agent-session',token:'forged'}})).rejects.toThrow('Invalid credential')
 await expect(f.service.parallelRunStart({name:'Bad output',command:'true',targets:[{kind:'local',root:f.repo,label:'fixture'}],concurrency:1},{outputs:['../foreign']})).rejects.toThrow('checkout-relative')
 expect((await f.service.parallelRunsList()).length).toBe(before)
})


it('opens verified checkout text in the editor, keeps external and binary openers, and rejects a changed-text race', async () => {
 const f=await fixture(),text=join(f.repo,'result.txt'),binary=join(f.repo,'result.bin'),external=join(f.cache,'browser.txt')
 const content='VERIFIED_TEXT\n',sha=createHash('sha256').update(content).digest('hex')
 writeFileSync(text,content);writeFileSync(binary,Buffer.from([0,1,2]));writeFileSync(external,content)
 const editors:string[]=[],externalPaths:string[]=[]
 const editor=async(root:string,path:string)=>{expect(root).toBe(f.repo);editors.push(path)}
 const native=async(path:string)=>{externalPaths.push(path);return ''}
 await openVerificationArtifact(text,f.repo,sha,editor,native)
 expect(editors).toEqual(['result.txt']);expect(externalPaths).toEqual([])
 await openVerificationArtifact(binary,f.repo,sha,editor,native)
 await openVerificationArtifact(external,f.repo,sha,editor,native)
 expect(externalPaths).toEqual([binary,external])
 writeFileSync(text,'Changed after the owner hashed its recorded attachment\n')
 await expect(openVerificationArtifact(text,f.repo,sha,editor,native)).rejects.toThrow('Artifact changed')
 expect(editors).toEqual(['result.txt']);expect(externalPaths).toEqual([binary,external])
})
