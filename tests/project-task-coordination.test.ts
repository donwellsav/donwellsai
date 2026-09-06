import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/main/store'
import { GitWorktrees } from '../src/main/git'
import { AgentRegistry } from '../src/main/agents/registry'
import { ProjectTaskCoordination } from '../src/main/project-task-coordination'
import { AgentRuntime } from '../src/main/agent-runtime'
import { parseAgentTaskIntent, overlappingAgentIntents, type RunningAgent } from '../src/shared/agent-runtime'
import { WorktreeFiles } from '../src/main/worktree-files'
import type { DaemonClient } from '../src/main/daemon-client'
const roots:string[]=[]
afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})))
async function fixture() {
 const root=realpathSync(mkdtempSync(join(tmpdir(),'donwells-tasks18-')));roots.push(root)
 const repo=join(root,'repo');mkdirSync(repo)
 const command=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,stdio:'ignore'})
 command(repo,'init','-b','main');command(repo,'config','user.email','fixture@example.test');command(repo,'config','user.name','Fixture');writeFileSync(join(repo,'shared.txt'),'base\n');command(repo,'add','.');command(repo,'commit','-m','Base')
 const store=new Store(join(root,'profile')),git=new GitWorktrees(store);await git.addRepo(repo)
 const launches:Array<{cwd:string;command:string}>=[]
 const terminals={openJob:async(cwd:string,command:string)=>{launches.push({cwd,command});return {id:'job'}}} as unknown as DaemonClient
 return {root,repo,store,git,command,terminals,launches}
}
it('validates advisory paths and identifies shared, nested and uncertain sessions',()=>{
 const task=parseAgentTaskIntent({intent:'Fix editor',files:['src/editor.ts','src/editor.ts'],externalId:'TASK-1'})
 expect(task.files).toEqual(['src/editor.ts'])
 for(const files of [['../escape'],['/absolute'],['src/../escape'],['src\\escape']])expect(()=>parseAgentTaskIntent({intent:'x',files})).toThrow()
 const run=(workspacePath:string,files:string[],liveness='live')=>({workspacePath,liveness,task:{intent:'peer',files}} as RunningAgent)
 const a=run('/repo',['src']),b=run('/repo/src',['editor.ts'],'unverifiable'),c=run('/other',['src']),d=run('/repo',['src'],'exited')
 expect(overlappingAgentIntents([a,b,c,d],'/repo',['src/editor.ts'])).toEqual([a,b])
 expect(overlappingAgentIntents([a,b],'/repo',['tests'])).toEqual([])
})
it('keeps optional absence explicit and persists only authority choice',async()=>{
 const f=await fixture(),service=new ProjectTaskCoordination(f.store,f.terminals,'',new AgentRegistry({env:{PATH:''}}))
 const initial=await service.inspect(f.repo);expect(initial.authority).toBeNull();expect(initial.tools.every(tool=>!tool.available)).toBe(true)
 await service.setAuthority(f.repo,true);expect((await service.inspect(f.repo)).problem).toMatch(/Initialize/)
 expect(new Store(join(f.root,'profile')).listRepos()[0]?.taskAuthority).toBe('backlog.md')
 await expect(service.openTool(f.repo,'lazygit')).rejects.toThrow('not configured');expect(f.launches).toEqual([])
 await service.setAuthority(f.repo,false);expect((await service.inspect(f.repo)).authority).toBeNull()
 await expect(service.requireTask(f.repo,'TASK-1')).rejects.toThrow('not the selected')
})
it('preserves competing edits and conflict markers through review, without deleting worktrees',async()=>{
 const f=await fixture();const summary=await f.git.createWorktree(f.repo,{name:'peer',branch:'main'});const peer=summary.worktrees.find(tree=>!tree.isMain)!
 writeFileSync(join(peer.path,'shared.txt'),'peer change\n');f.command(peer.path,'add','.');f.command(peer.path,'commit','-m','Peer')
 writeFileSync(join(f.repo,'shared.txt'),'main change\n');f.command(f.repo,'add','.');f.command(f.repo,'commit','-m','Main')
 expect(()=>f.command(f.repo,'merge',peer.branch)).toThrow()
 const before=readFileSync(join(f.repo,'shared.txt'),'utf8');expect(before).toContain('peer change');expect(before).toContain('main change')
 const status=await f.git.status(f.repo);expect(status.entries.some(entry=>entry.conflict)).toBe(true)
 await f.git.handoffSource(f.repo);expect(readFileSync(join(f.repo,'shared.txt'),'utf8')).toBe(before)
 f.command(f.repo,'merge','--abort');expect(readFileSync(join(peer.path,'shared.txt'),'utf8')).toBe('peer change\n')
})
it('retains intent through the native launch contract and refuses an invalid external reference',async()=>{
 const f=await fixture(),calls:unknown[][]=[];const task={intent:'Fix shared file',files:['shared.txt'],externalId:'TASK-1'}
 const runtime=new AgentRuntime({startAgent:async(...args)=>{calls.push(args);return {run:{sessionId:'session',task:args[6]} as RunningAgent,session:{id:'session'} as never}},listAgents:async()=>[],interruptAgent:async()=>{throw 0},stopAgent:async()=>{throw 0},dismissAgent:async()=>{}},{registeredWorkspaces:()=>[{path:f.repo,host:{kind:'local'}}],requireTask:async(_path,id)=>{if(id!=='TASK-1')throw new Error('Missing native task')}})
 expect((await runtime.start(f.repo,'cat',task)).run.task).toEqual(task);expect(calls[0]?.[6]).toEqual(task)
 await expect(runtime.start(f.repo,'cat',{...task,externalId:'TASK-2'})).rejects.toThrow('Missing native task');expect(calls).toHaveLength(1)
 rmSync(f.repo,{recursive:true});await expect(runtime.start(f.repo,'cat',task)).rejects.toThrow('existing local directory')
})
it('uses existing confined file operations for OpenSpec proposal artifacts and preserves existing content',async()=>{
 const f=await fixture(),files=new WorktreeFiles()
 for(const path of ['openspec','openspec/changes','openspec/changes/editor-fix'])await files.createWorkspaceEntry(f.repo,{path,kind:'dir'})
 const path='openspec/changes/editor-fix/proposal.md',content='# Proposal: Preserve competing editor saves\n\n## Intent\nKeep both versions when two sessions edit a file.\n\n## Scope\nDetect stale saves in the editor.\n\n## Approach\nCompare the file revision before replacing bytes.\n'
 await files.createWorkspaceEntry(f.repo,{path,kind:'file',content});expect((await files.readFile(f.repo,path)).content).toBe(content)
 await expect(files.createWorkspaceEntry(f.repo,{path,kind:'file',content:'overwrite'})).rejects.toThrow();expect((await files.readFile(f.repo,path)).content).toBe(content)
})

it.skipIf(!process.env.DONWELLS_BACKLOG_BINARY)('rechecks the project-selected native executable instead of retaining a launch-time path', async () => {
 const f=await fixture();let selected:string|undefined=process.env.DONWELLS_BACKLOG_BINARY
 const paths:string[]=[]
 const service=new ProjectTaskCoordination(f.store,f.terminals,async path=>{paths.push(path);return selected},new AgentRegistry({env:{PATH:''}}))
 expect((await service.inspect(f.repo)).tools.find(tool=>tool.id==='backlog')?.available).toBe(true)
 selected=undefined
 expect((await service.inspect(f.repo)).tools.find(tool=>tool.id==='backlog')?.available).toBe(false)
 expect(paths).toEqual([f.repo,f.repo]);expect(f.launches).toEqual([])
})
