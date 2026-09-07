import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import type { ProjectLanguageDefinition, ProjectLanguageDiagnostic, ProjectLanguageDocument, ProjectLanguageStatus } from '@shared/project-language-tools'

type Scope = { checkoutPath:string; indexKey:string }
type Response = { type?:string; request_seq?:number; success?:boolean; body?:unknown; message?:string }
type Server = { process:ChildProcessWithoutNullStreams; generation:number; version:string; seq:number; pending:Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>; buffer:Buffer; documents:Map<string,{version:number;content:string}>; failed:string|null }
const MAX_CONTENT=2*1024*1024
const position=(value:unknown)=>{const item=value as {line?:unknown;offset?:unknown};if(!Number.isSafeInteger(item?.line)||!Number.isSafeInteger(item?.offset))throw new Error('Invalid language position');return {line:Number(item.line),column:Number(item.offset)}}

export class ProjectLanguageTools {
  private paused=new Set<string>();private servers=new Map<string,Server>();private starting=new Map<string,Promise<Server>>();private generation=0;private closed=false
  constructor(private resolveScope:(path:string)=>Promise<Scope>){}
  private document(input:ProjectLanguageDocument,scope:Scope){if(!input||typeof input.path!=='string'||!input.path||input.path.length>4096||input.path.includes('\0')||typeof input.content!=='string'||Buffer.byteLength(input.content)>MAX_CONTENT||!Number.isSafeInteger(input.version)||input.version<1)throw new Error('Invalid language document');const path=resolve(scope.checkoutPath,input.path);if(relative(scope.checkoutPath,path).startsWith('..'+sep)||relative(scope.checkoutPath,path)==='..')throw new Error('Language document is outside this checkout');return path}
  private async start(scope:Scope):Promise<Server>{
    if(this.closed)throw new Error('Language service is closed')
    if(this.paused.has(scope.indexKey))throw new Error('Project language tools are paused. Resume them in Project tools.')
    const existing=this.servers.get(scope.indexKey);if(existing&&!existing.failed)return existing
    const starting=this.starting.get(scope.indexKey);if(starting)return starting
    const operation=this.launch(scope);this.starting.set(scope.indexKey,operation)
    try{return await operation}finally{this.starting.delete(scope.indexKey)}
  }
  private async launch(scope:Scope):Promise<Server>{
    let packageJson:string,serverPath:string
    try{const require=createRequire(resolve(scope.checkoutPath,'package.json'));packageJson=require.resolve('typescript/package.json');serverPath=resolve(dirname(packageJson),'lib/tsserver.js')}catch{throw new Error('Project TypeScript is unavailable. Install TypeScript in this checkout to enable project diagnostics.')}
    let pkgPath:string,scriptPath:string,root:string
    try{[pkgPath,scriptPath,root]=await Promise.all([realpath(packageJson),realpath(serverPath),realpath(scope.checkoutPath)])}catch{throw new Error('Project TypeScript is unavailable. Install TypeScript in this checkout to enable project diagnostics.')}
    if(relative(root,pkgPath).startsWith('..'+sep)||relative(root,scriptPath).startsWith('..'+sep))throw new Error('Project TypeScript must resolve inside this checkout')
    const pkg=JSON.parse(await readFile(pkgPath,'utf8'));if(typeof pkg.version!=='string')throw new Error('Invalid project TypeScript package')
    if(this.closed||this.paused.has(scope.indexKey))throw new Error('Project language start was cancelled')
    const child=spawn(process.execPath,[scriptPath,'--useInferredProjectPerProjectRoot','--disableAutomaticTypingAcquisition'],{cwd:root,env:{PATH:process.env.PATH??'',...(process.env.HOME?{HOME:process.env.HOME}:{}),ELECTRON_RUN_AS_NODE:'1'},stdio:['pipe','pipe','pipe']})
    const server:Server={process:child,generation:++this.generation,version:pkg.version,seq:0,pending:new Map(),buffer:Buffer.alloc(0),documents:new Map(),failed:null};this.servers.set(scope.indexKey,server)
    const fail=(message:string)=>{if(server.failed)return;server.failed=message;for(const item of server.pending.values()){clearTimeout(item.timer);item.reject(new Error(message))}server.pending.clear()}
    child.on('error',()=>fail('TypeScript service could not start'));child.on('close',()=>fail('TypeScript service exited'));child.stderr.resume()
    child.stdout.on('data',(chunk:Buffer)=>{server.buffer=Buffer.concat([server.buffer,chunk]);if(server.buffer.length>MAX_CONTENT){fail('TypeScript response exceeded limit');void this.stop(scope.indexKey);return}for(;;){const header=server.buffer.indexOf('\r\n\r\n');if(header<0)return;const match=/Content-Length: (\d+)/i.exec(server.buffer.subarray(0,header).toString());if(!match){fail('Malformed TypeScript response');return}const length=Number(match[1]),end=header+4+length;if(!Number.isSafeInteger(length)||length<0||length>MAX_CONTENT){fail('Invalid TypeScript response length');return}if(server.buffer.length<end)return;const body=server.buffer.subarray(header+4,end).toString();server.buffer=server.buffer.subarray(end);try{const response=JSON.parse(body) as Response;if(response.type==='response'&&response.request_seq){const pending=server.pending.get(response.request_seq);if(pending){server.pending.delete(response.request_seq);clearTimeout(pending.timer);response.success?pending.resolve(response.body):pending.reject(new Error(response.message??'TypeScript request failed'))}}}catch{fail('Malformed TypeScript response');return}}})
    return server
  }
  private request(server:Server,command:string,args:Record<string,unknown>):Promise<unknown>{if(server.failed)return Promise.reject(new Error(server.failed));if(server.pending.size>=32)return Promise.reject(new Error('Too many language requests'));const seq=++server.seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{server.pending.delete(seq);reject(new Error('TypeScript request timed out'))},10000);server.pending.set(seq,{resolve,reject,timer});server.process.stdin.write(JSON.stringify({seq,type:'request',command,arguments:args})+'\n')})}
  private async sync(input:ProjectLanguageDocument){const scope=await this.resolveScope(input.workspacePath),path=this.document(input,scope),server=await this.start(scope),seen=server.documents.get(path);if(seen&&input.version<seen.version)throw new Error('Stale language document version');if(seen&&input.version===seen.version&&input.content!==seen.content)throw new Error('Language document content changed without a new version');if(!seen)await this.request(server,'open',{file:path,fileContent:input.content,projectRootPath:scope.checkoutPath});else if(seen.version!==input.version){const lines=seen.content.split('\n'),end={line:lines.length,offset:(lines.at(-1)?.length??0)+1};await this.request(server,'updateOpen',{changedFiles:[{fileName:path,textChanges:[{start:{line:1,offset:1},end,newText:input.content}]}]})}server.documents.set(path,{version:input.version,content:input.content});return {scope,path,server}}
  private status(server:Server):ProjectLanguageStatus{return {state:server.failed?'failed':'ready',generation:server.generation,version:server.version,pid:server.process.pid,documents:server.documents.size,detail:server.failed??`TypeScript ${server.version} · project configuration`}}
  async open(input:ProjectLanguageDocument){return this.status((await this.sync(input)).server)}
  async change(input:ProjectLanguageDocument){return this.open(input)}
  async closeDocument(workspacePath:string,path:string){const scope=await this.resolveScope(workspacePath),server=this.servers.get(scope.indexKey);if(!server)return;const file=this.document({workspacePath,path,version:1,content:''},scope);if(server.documents.delete(file))await this.request(server,'close',{file})}
  async diagnostics(input:ProjectLanguageDocument){const {path,server}=await this.sync(input);const body=await this.request(server,'semanticDiagnosticsSync',{file:path,includeLinePosition:true});const diagnostics=(Array.isArray(body)?body:[]).map((item:any):ProjectLanguageDiagnostic=>({start:position(item.startLocation),end:position(item.endLocation),severity:item.category==='error'?'error':item.category==='warning'?'warning':'info',code:Number(item.code),message:String(item.message??'TypeScript diagnostic').slice(0,4096)}));return {generation:server.generation,version:input.version,diagnostics}}
  async definition(input:ProjectLanguageDocument,line:number,column:number){if(!Number.isSafeInteger(line)||line<1||!Number.isSafeInteger(column)||column<1)throw new Error('Invalid definition position');const {scope,path,server}=await this.sync(input),body=await this.request(server,'definitionAndBoundSpan',{file:path,line,offset:column}),root=await realpath(scope.checkoutPath);const entries=Array.isArray((body as any)?.definitions)?(body as any).definitions:[];const definitions:ProjectLanguageDefinition[]=[];for(const item of entries){const file=resolve(String(item.file)),rel=relative(root,file);if(rel.startsWith('..'+sep)||rel==='..')continue;definitions.push({path:rel,start:position(item.start),end:position(item.end)})}return {generation:server.generation,version:input.version,definitions}}
  async references(input:ProjectLanguageDocument,line:number,column:number){if(!Number.isSafeInteger(line)||line<1||!Number.isSafeInteger(column)||column<1)throw new Error('Invalid reference position');const {scope,path,server}=await this.sync(input),body=await this.request(server,'references',{file:path,line,offset:column}),root=await realpath(scope.checkoutPath);const entries=Array.isArray((body as any)?.refs)?(body as any).refs:[];const references:ProjectLanguageDefinition[]=[];for(const item of entries){const file=resolve(String(item.file)),rel=relative(root,file);if(rel.startsWith('..'+sep)||rel==='..')continue;references.push({path:rel,start:position(item.start),end:position(item.end)})}return {generation:server.generation,version:input.version,references}}
  async inspect(workspacePath:string):Promise<ProjectLanguageStatus>{const scope=await this.resolveScope(workspacePath);const server=this.servers.get(scope.indexKey);if(server)return this.status(server);return {state:this.paused.has(scope.indexKey)?'paused':this.starting.has(scope.indexKey)?'starting':'stopped',generation:this.generation,version:null,detail:this.paused.has(scope.indexKey)?'Project language work paused; existing files remain open.':'No active project language owner. Start uses TypeScript installed in this checkout.'}}
  async stopProject(workspacePath:string){const scope=await this.resolveScope(workspacePath);this.paused.add(scope.indexKey);await this.starting.get(scope.indexKey)?.catch(()=>{});await this.stop(scope.indexKey);return this.inspect(workspacePath)}
  async restart(workspacePath:string){const scope=await this.resolveScope(workspacePath);await this.stopProject(workspacePath);this.paused.delete(scope.indexKey);const server=await this.start(scope);await this.request(server,'configure',{});return this.status(server)}
  private async stop(key:string){
    const server=this.servers.get(key);if(!server)return
    server.failed='Project language service stopped'
    for(const pending of server.pending.values()){clearTimeout(pending.timer);pending.reject(new Error(server.failed))}server.pending.clear()
    if(server.process.exitCode===null&&server.process.signalCode===null)await new Promise<void>((resolve,reject)=>{
      const term=setTimeout(()=>server.process.kill('SIGTERM'),500),kill=setTimeout(()=>server.process.kill('SIGKILL'),1500)
      const timeout=setTimeout(()=>{cleanup();reject(new Error('Language process exit is unverifiable'))},3000)
      const done=()=>{cleanup();resolve()},cleanup=()=>{clearTimeout(term);clearTimeout(kill);clearTimeout(timeout);server.process.off('close',done)}
      server.process.once('close',done);server.process.stdin.end()
    })
    if(this.servers.get(key)===server)this.servers.delete(key)
  }
  async close(){this.closed=true;await Promise.allSettled([...this.starting.values()]);await Promise.all([...this.servers.keys()].map(key=>this.stop(key)))}
}
