import { lstat } from 'node:fs/promises'
import type { DiffReviewRunState } from '@shared/diff-review'
import { stripVTControlCharacters } from 'node:util'
import { WorktreeFiles } from './worktree-files'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { isObject } from '@shared/command-catalog'
import { runProcess } from '@shared/child-process/run-process'
import { sanitizedProcessEnv } from '@shared/child-process/process-environment'
import { AgentRegistry } from './agents/registry'
import { shellCommand } from './agents/provider-hooks'
import { hashVerificationArtifact } from './diff-review'
import type { VerificationSetup, VerificationRunOptions, VerificationOutput, VerificationSource, VerificationEvidence, VerificationEntry, VerificationArtifact } from '@shared/operational-runs'
import { parseVerificationOutputPaths, parseParallelRunInput, parseScheduledRunInput, type OperationalRunsApi, type OperationalTarget, type ParallelRunInput, type ScheduledRunInput } from '@shared/operational-runs'
import { ScheduledRunScheduler, ScheduledRunStore } from './automations'
import { ParallelRunOrchestrator, ParallelRunStore } from './orchestration'
import type { DaemonClient } from './daemon-client'

/** Open verified checkout text in the existing editor; other artifacts keep their platform opener. */
export async function openVerificationArtifact(path: string, workspacePath: string, sha256: string, openEditor: (workspacePath: string, relPath: string) => Promise<unknown>, openExternal: (path: string) => Promise<string>): Promise<void> {
  const relPath = relative(workspacePath, path)
  if (relPath && relPath !== '..' && !relPath.startsWith(`..${sep}`) && !isAbsolute(relPath)) {
    const file = await new WorktreeFiles().readFile(workspacePath, relPath.split(sep).join('/'))
    if (!file.binary && !file.truncated) {
      if (file.revision !== `sha256:${sha256}`) throw new Error('Artifact changed before opening in the editor')
      await openEditor(workspacePath, file.path)
      return
    }
  }
  const error = await openExternal(path)
  if (error) throw new Error(error)
}

export class OperationalRunService implements OperationalRunsApi {
  private readonly scheduler: ScheduledRunScheduler
  private readonly parallel: ParallelRunOrchestrator
  private readonly parallelStore: ParallelRunStore
  private readonly completing = new Map<string,Promise<void>>()

  constructor(userDataDir: string, private readonly terminals: DaemonClient, private readonly resolveWorkspace: (path: string) => Promise<string>, private readonly verification?: {source:(path:string)=>Promise<VerificationSource>; artifactRoots:(path:string)=>Promise<string[]>; openArtifact?:(path:string,workspacePath:string,sha256:string)=>Promise<void>}) {
    const launch = async ({ target, command }: { target: OperationalTarget; command: string }): Promise<string> => {
      const workspacePath = await this.localWorkspace(target)
      return (await terminals.openJob(workspacePath, command)).id
    }
    const inspect = (sessionId: string) => terminals.jobResult(sessionId)
    const release = (sessionId: string) => terminals.close(sessionId)
    const stop = (sessionId: string) => terminals.close(sessionId)
    this.scheduler = new ScheduledRunScheduler(new ScheduledRunStore(userDataDir), launch, inspect, release, stop)
    this.parallelStore = new ParallelRunStore(userDataDir)
    this.parallel = new ParallelRunOrchestrator(this.parallelStore, async request => {
      const root=await this.localWorkspace(request.target)
      const setup = this.parallelStore.get(request.runId)?.tasks.find(task => task.id === request.taskId)?.verificationSetup
      const outputs: VerificationOutput[] = []
      for (const relative of setup?.outputs ?? []) {
        const path = join(root, relative)
        const before = await this.observeOutput(path,root)
        outputs.push({path,before:before?{sha256:before.sha256,bytes:before.bytes}:null,state:'pending'})
      }
      const evidence:VerificationEvidence={origin:setup?.origin ?? {kind:'unattributed'},outputs,before:null,after:null,startedAt:new Date().toISOString(),environment:{platform:process.platform,arch:process.arch,hostNode:process.versions.node,hostElectron:process.versions.electron},toolVersions:{},artifacts:[]}
      try {evidence.before=await this.capture(root)} catch(error) {evidence.problem=String(error).slice(0,2048)}
      for (const name of ['node',await this.packageManager(root).catch(()=>null)]) {
        if(!name)continue
        const program=new AgentRegistry().findExecutable(name)
        if(!program)continue
        try {const version=(await runProcess({program,args:['--version'],cwd:root,env:sanitizedProcessEnv(process.env,{COREPACK_ENABLE_NETWORK:'0',COREPACK_ENABLE_PROJECT_SPEC:'0'}),timeoutMs:5000,maxOutputBytes:256})).stdout.trim();if(/^v?\d[\w.+-]{0,100}$/.test(version))evidence.toolVersions[name]=version}catch{/* Version unavailable is not zero. */}
      }
      const current=this.parallelStore.get(request.runId),task=current?.tasks.find(task=>task.id===request.taskId)
      if(!current||!task||task.status!=='launching'||current.status==='cancelling')throw new Error('Run cancelled or removed before verification launch')
      task.verification=evidence;this.parallelStore.upsert(current)
      return launch(request)
    }, stop, async sessionId => {
      const result=await inspect(sessionId)
      if(result.exited)await this.captureCompletion(sessionId)
      return result
    }, release)

  }

  private async localWorkspace(target: OperationalTarget): Promise<string> {
    if (target.kind !== 'local') throw new Error('Remote operational execution is unavailable; this run was not launched locally')
    return this.resolveWorkspace(target.root)
  }

  async resume(): Promise<void> {
    await Promise.all([this.scheduler.resume(), this.parallel.resume()])
    this.scheduler.prime()
    this.scheduler.start()
  }

  stop(): void {
    this.scheduler.stop()
  }

  async onDaemonEvent(kind: 'data' | 'exit', sessionId: string, data: string, exitCode?: number): Promise<void> {
    await Promise.all([
      this.scheduler.onDaemonEvent(kind, sessionId, data, exitCode),
      this.parallel.onDaemonEvent(kind, sessionId, data, exitCode)
    ])
  }

  async scheduledRunsList() { return this.scheduler.list() }
  async scheduledRunHistory(id: string) { return this.scheduler.history(id) }

  async scheduledRunSave(value: ScheduledRunInput) {
    const input = parseScheduledRunInput(value)
    const root = await this.localWorkspace(input.target)
    return this.scheduler.save({ ...input, target: { ...input.target, root } })
  }

  async scheduledRunSetEnabled(id: string, enabled: boolean) {
    if (enabled) {
      const definition = this.scheduler.list().find((entry) => entry.id === id)
      if (!definition) throw new Error('Scheduled run does not exist')
      await this.localWorkspace(definition.target)
    }
    return this.scheduler.setEnabled(id, enabled)
  }

  async scheduledRunDuplicate(id: string) { return this.scheduler.duplicate(id) }
  async scheduledRunDelete(id: string) { this.scheduler.remove(id) }
  async scheduledRunRunNow(id: string) { return this.scheduler.runNow(id) }
  async scheduledRunCancel(executionId: string) { return this.scheduler.cancel(executionId) }
  async parallelRunsList() { return this.parallel.list() }

  async parallelRunStart(value: ParallelRunInput, options?: VerificationRunOptions) {
    const input = parseParallelRunInput(value)
    const targets = await Promise.all(input.targets.map(async (target) => ({ ...target, root: await this.localWorkspace(target) })))
    if (options && (typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key=>!['outputs','credential'].includes(key)))) throw new Error('Invalid run options')
    const setup: VerificationSetup = { outputs: parseVerificationOutputPaths(options?.outputs ?? []), origin: {kind:'unattributed'} }
    if (options?.credential) {
      const identity = await this.terminals.authenticateAgent(options.credential)
      const root = await this.resolveWorkspace(identity.workspacePath)
      if (targets.some(target => target.kind !== 'local' || target.root !== root)) throw new Error('Agent credential belongs to another checkout')
      setup.origin = {kind:'agent',runId:identity.id,sessionId:identity.sessionId,mode:identity.mode ?? 'native'}
    }
    return this.parallel.start({ ...input, targets }, setup)
  }

  async parallelRunRetry(id: string, taskIds: string[]) {
    const run = this.parallel.list().find((entry) => entry.id === id)
    if (!run) throw new Error('Parallel run does not exist')
    if (!Array.isArray(taskIds) || taskIds.some((taskId) => typeof taskId !== 'string')) throw new Error('Task IDs must be a string list')
    await Promise.all(run.tasks.filter((task) => taskIds.includes(task.id)).map((task) => this.localWorkspace(task.target)))
    return this.parallel.retry(id, taskIds)
  }

  async parallelRunCancel(id: string) {
    try { await this.parallel.cancel(id) } finally {
      // Capture after cancellation persists its final task state.
      for (const task of this.parallelStore.get(id)?.tasks ?? []) {
        if (task.sessionId && task.status === 'cancelled') await this.captureCompletion(task.sessionId)
      }
    }
    return this.parallelStore.get(id)!
  }
  async parallelRunDelete(id: string) { this.parallel.remove(id) }
  private async capture(path:string):Promise<VerificationSource> {
    const root=await this.resolveWorkspace(path)
    if(root!==path||!this.verification)throw new Error('Source capture unavailable for this workspace')
    const source=await this.verification.source(root)
    if(await this.resolveWorkspace(path)!==root)throw new Error('Workspace changed during source capture')
    return source
  }

  private async observeOutput(path:string,root:string) {
    try {await lstat(path)} catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error}
    return hashVerificationArtifact(path,[root])
  }

  private captureCompletion(sessionId:string):Promise<void> {
    const active=this.completing.get(sessionId);if(active)return active
    const pending=(async()=>{
      const run=this.parallelStore.list().find(run=>run.tasks.some(task=>task.sessionId===sessionId))
      const task=run?.tasks.find(task=>task.sessionId===sessionId)
      if(!run||!task?.verification||task.verification.finishedAt)return
      let after:VerificationSource|null=null,problem:string|undefined
      try {after=await this.capture(task.target.root)} catch(error) {problem=String(error).slice(0,2048)}
      const outputs:VerificationOutput[]=[],observed:VerificationArtifact[]=[]
      for (const declared of task.verification.outputs ?? []) {
        try {
          const actual=await this.observeOutput(declared.path,task.target.root)
          if(!actual){outputs.push({...declared,state:'missing'});continue}
          const state=!declared.before?'created':declared.before.sha256===actual.sha256?'unchanged':'changed'
          outputs.push({...declared,state})
          if(state!=='unchanged')observed.push({...actual,attachedAt:new Date().toISOString(),sourceFingerprint:task.verification.before?.contentFingerprint??null,relationship:'observed-during-run'})
        } catch(error) {outputs.push({...declared,state:(error as NodeJS.ErrnoException).code==='ENOENT'?'missing':'unavailable',problem:String(error).slice(0,2048)})}
      }
      const current=this.parallelStore.get(run.id),fresh=current?.tasks.find(item=>item.id===task.id)
      if(!current||!fresh?.verification)return
      fresh.verification={...fresh.verification,after,outputs,artifacts:[...fresh.verification.artifacts.filter(item=>!observed.some(value=>value.path===item.path)),...observed],finishedAt:new Date().toISOString(),problem:problem??fresh.verification.problem}
      this.parallelStore.upsert(current)
    })().finally(()=>this.completing.delete(sessionId))
    this.completing.set(sessionId,pending);return pending
  }

  private async packageInfo(path:string):Promise<Record<string,unknown>> {
    const file=await new WorktreeFiles().readFile(path,'package.json')
    if(file.binary||file.truncated||!file.revision||Buffer.byteLength(file.content)>1024*1024)throw new Error('Package manifest is not complete stable text')
    const content=file.content
    const pkg=JSON.parse(content)
    if(!isObject(pkg))throw new Error('Invalid package manifest')
    return pkg
  }
  private async packageManager(path:string):Promise<string> {
    const pkg=await this.packageInfo(path),name=typeof pkg.packageManager==='string'?pkg.packageManager.split('@')[0]:'npm'
    if(!name||!['npm','pnpm','yarn','bun'].includes(name))throw new Error('Package manager is not supported')
    return name
  }
  async verificationScripts(workspacePath:string):Promise<string[]> {
    const root=await this.resolveWorkspace(workspacePath),pkg=await this.packageInfo(root)
    if(await this.resolveWorkspace(workspacePath)!==root)throw new Error('Workspace changed while reading scripts')
    return isObject(pkg.scripts)?Object.keys(pkg.scripts).filter(name=>name.length>0&&name.length<=128&&!/[\u0000-\u001f]/.test(name)&&typeof (pkg.scripts as Record<string,unknown>)[name]==='string'):[]
  }
  async verificationRun(workspacePath:string,script:string,options?:VerificationRunOptions) {
    const root=await this.resolveWorkspace(workspacePath)
    if(!(await this.verificationScripts(root)).includes(script))throw new Error('Choose an existing package script')
    const manager=await this.packageManager(root),program=new AgentRegistry().findExecutable(manager)
    if(!program)throw new Error('Package manager is unavailable: '+manager)
    return this.parallelRunStart({name:'Verify '+script,command:shellCommand([program,'run',script],process.platform),targets:[{kind:'local',root,label:basename(root)}],concurrency:1},options)
  }
  async verificationList(workspacePath:string,verifyArtifacts=false):Promise<VerificationEntry[]> {
    const root=await this.resolveWorkspace(workspacePath),current=await this.capture(root).catch(()=>null)
    const result:VerificationEntry[]=[],roots=await this.verification?.artifactRoots(root)??[root]
    for(const run of this.parallelStore.list())for(const task of run.tasks){
      if(task.target.kind!=='local'||task.target.root!==root||result.length>=20)continue
      const evidence=task.verification
      const sourceState:VerificationEntry['sourceState']=!evidence?.before||!evidence.after||!current?'unverified':evidence.before.contentFingerprint!==evidence.after.contentFingerprint?'changed-during-run':current.contentFingerprint!==evidence.after.contentFingerprint?'stale':'current'
      const artifacts=await Promise.all((evidence?.artifacts??[]).map(async artifact=>{if(!verifyArtifacts)return {...artifact,state:'unchecked' as const};try{const actual=await hashVerificationArtifact(artifact.path,roots);return {...artifact,state:actual.sha256===artifact.sha256?'unchanged' as const:'changed' as const}}catch{return {...artifact,state:'missing' as const}}}))
      result.push({runId:run.id,task:{...task,output:task.output===undefined?undefined:stripVTControlCharacters(task.output)},sourceState:['queued','launching','running','cancelling'].includes(task.status)?'running':sourceState,artifacts})
    }
    if(await this.resolveWorkspace(workspacePath)!==root)throw new Error('Workspace changed while reading verification')
    return result
  }
  async verificationReviewRuns(workspacePath: string): Promise<Record<string, DiffReviewRunState>> {
    const root = await this.resolveWorkspace(workspacePath), current = await this.capture(root).catch(() => null)
    const states: Record<string, DiffReviewRunState> = {}
    for (const run of this.parallelStore.list()) for (const task of run.tasks) {
      if (task.target.kind !== 'local' || task.target.root !== root) continue
      const evidence = task.verification
      const sourceState: VerificationEntry['sourceState'] = ['queued','launching','running','cancelling'].includes(task.status) ? 'running' : !evidence?.before || !evidence.after || !current ? 'unverified' : evidence.before.contentFingerprint !== evidence.after.contentFingerprint ? 'changed-during-run' : current.contentFingerprint !== evidence.after.contentFingerprint ? 'stale' : 'current'
      states[run.id + ':' + task.id] = { status: task.status, sourceState, exitCode: task.exitCode, sourceFingerprint: evidence?.before?.contentFingerprint ?? null }
    }
    if (await this.resolveWorkspace(workspacePath) !== root) throw new Error('Workspace changed while reading run references')
    return states
  }
  async verificationOpen(workspacePath: string, runId: string, taskId: string, path: string): Promise<void> {
    const root = await this.resolveWorkspace(workspacePath), run = this.parallelStore.get(runId), task = run?.tasks.find(task => task.id === taskId)
    if (!task?.verification || task.target.kind !== 'local' || task.target.root !== root) throw new Error('Artifact run does not belong to this workspace')
    const recorded = task.verification.artifacts.find(artifact => artifact.path === path)
    if (!recorded) throw new Error('Artifact is not attached to this run')
    const actual = await hashVerificationArtifact(path, await this.verification?.artifactRoots(root) ?? [root])
    if (actual.sha256 !== recorded.sha256 || actual.bytes !== recorded.bytes) throw new Error('Artifact changed since attachment; review and attach its new bytes before opening')
    if (await this.resolveWorkspace(workspacePath) !== root || !this.parallelStore.get(runId)?.tasks.find(item => item.id === taskId)?.verification?.artifacts.some(item => item.path === path && item.sha256 === actual.sha256)) throw new Error('Artifact reference changed during opening')
    if (!this.verification?.openArtifact) throw new Error('Artifact opener is unavailable')
    await this.verification.openArtifact(actual.path, root, actual.sha256)
  }
  async verificationAttach(workspacePath:string,runId:string,taskId:string,path:string):Promise<VerificationArtifact> {
    const root=await this.resolveWorkspace(workspacePath),run=this.parallelStore.get(runId),task=run?.tasks.find(task=>task.id===taskId)
    if(!task?.verification||task.target.kind!=='local'||task.target.root!==root)throw new Error('Verification run does not belong to this workspace')
    const actual=await hashVerificationArtifact(path,await this.verification?.artifactRoots(root)??[root]),source=await this.capture(root).catch(()=>null)
    if(await this.resolveWorkspace(workspacePath)!==root)throw new Error('Workspace changed during artifact attachment')
    const current=this.parallelStore.get(runId),fresh=current?.tasks.find(task=>task.id===taskId)
    if(!current||!fresh?.verification)throw new Error('Verification run was removed')
    const retained=fresh.verification.artifacts.filter(item=>item.path!==actual.path)
    if(retained.filter(item=>item.relationship==='attached-reference').length>=16)throw new Error('Artifact limit reached')
    const artifact:VerificationArtifact={...actual,attachedAt:new Date().toISOString(),sourceFingerprint:source?.contentFingerprint??null,relationship:'attached-reference'}
    fresh.verification.artifacts=[...retained,artifact]
    this.parallelStore.upsert(current);return artifact
  }

}
