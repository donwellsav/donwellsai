import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import type { ProjectLanguageDefinition, ProjectLanguageDiagnostic, ProjectLanguageDocument, ProjectLanguageStatus } from '@shared/project-language-tools'

type Scope = { checkoutPath:string; indexKey:string }
type Response = { type?:string; request_seq?:number; success?:boolean; body?:unknown; message?:string; id?:number; method?:string; result?:unknown; error?:{message?:string} }
type Server = { lsp:boolean; diagnostics:Map<string,ProjectLanguageDiagnostic[]>; process:ChildProcessWithoutNullStreams; generation:number; version:string; seq:number; pending:Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>; buffer:Buffer; documents:Map<string,{version:number;content:string}>; failed:string|null }
const MAX_CONTENT=2*1024*1024
const position=(value:unknown)=>{const item=value as {line?:unknown;offset?:unknown};if(!Number.isSafeInteger(item?.line)||!Number.isSafeInteger(item?.offset))throw new Error('Invalid language position');return {line:Number(item.line),column:Number(item.offset)}}

export class ProjectLanguageTools {
  private paused=new Set<string>();private servers=new Map<string,Server>();private starting=new Map<string,Promise<Server>>();private generation=0;private closed=false
  constructor(private resolveScope:(path:string)=>Promise<Scope>){}
  private document(input:ProjectLanguageDocument,scope:Scope){if(!input||typeof input.path!=='string'||!input.path||input.path.length>4096||input.path.includes('\0')||typeof input.content!=='string'||Buffer.byteLength(input.content)>MAX_CONTENT||!Number.isSafeInteger(input.version)||input.version<1)throw new Error('Invalid language document');const path=resolve(scope.checkoutPath,input.path);if(relative(scope.checkoutPath,path).startsWith('..'+sep)||relative(scope.checkoutPath,path)==='..')throw new Error('Language document is outside this checkout');return path}
  private async start(scope:Scope):Promise<Server>{
    if(this.closed)throw new Error('Language service is closed')
    if(this.paused.has(scope.indexKey))throw new Error('Project language tools are paused. Resume them in Project tools.')
    const starting=this.starting.get(scope.indexKey);if(starting)return starting
    const existing=this.servers.get(scope.indexKey);if(existing&&!existing.failed)return existing
    if(existing)await this.stop(scope.indexKey)
    const operation=this.launch(scope);this.starting.set(scope.indexKey,operation)
    try{return await operation}finally{this.starting.delete(scope.indexKey)}
  }
  private async launch(scope:Scope):Promise<Server>{
    let packageJson:string
    try { packageJson=createRequire(resolve(scope.checkoutPath,'package.json')).resolve('typescript/package.json') }
    catch { throw new Error('Project TypeScript is not installed in this checkout') }
    const root=await realpath(scope.checkoutPath),pkgPath=await realpath(packageJson)
    const pkg=JSON.parse(await readFile(pkgPath,'utf8'))
    if(typeof pkg.version!=='string')throw new Error('Invalid project TypeScript package')
    let lsp=false,scriptPath:string
    try { scriptPath=await realpath(resolve(dirname(pkgPath),'lib/tsserver.js')) }
    catch(error) {
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error
      lsp=true
      try { scriptPath=await realpath(resolve(dirname(pkgPath),'lib/tsc.js')) }
      catch { throw new Error(`Installed TypeScript ${pkg.version} has no available project language server`) }
      if(!/^([7-9]|[1-9]\d+)\./.test(pkg.version))throw new Error(`Installed TypeScript ${pkg.version} has no available project tsserver`)
    }
    for(const path of [pkgPath,scriptPath])if(relative(root,path)==='..'||relative(root,path).startsWith('..'+sep))throw new Error('Project TypeScript must resolve inside this checkout')
    if(this.closed||this.paused.has(scope.indexKey))throw new Error('Project language start was cancelled')
    const child=spawn(process.execPath,[scriptPath,...(lsp?['--lsp','--stdio']:['--useInferredProjectPerProjectRoot','--disableAutomaticTypingAcquisition'])],{cwd:root,env:{PATH:process.env.PATH??'',...(process.env.HOME?{HOME:process.env.HOME}:{}),ELECTRON_RUN_AS_NODE:'1'},stdio:['pipe','pipe','pipe']})
    const server:Server={lsp,diagnostics:new Map(),process:child,generation:++this.generation,version:pkg.version,seq:0,pending:new Map(),buffer:Buffer.alloc(0),documents:new Map(),failed:null};this.servers.set(scope.indexKey,server)
    const fail=(message:string)=>{if(server.failed)return;server.failed=message;for(const item of server.pending.values()){clearTimeout(item.timer);item.reject(new Error(message))}server.pending.clear()}
    child.stdin.on('error',()=>fail('TypeScript input closed'));child.on('error',()=>fail('TypeScript service could not start'));child.on('close',()=>fail('TypeScript service exited'));child.stderr.resume()
    child.stdout.on('data',(chunk:Buffer)=>{
      if(server.failed)return
      server.buffer=Buffer.concat([server.buffer,chunk])
      for(;;){
        const header=server.buffer.indexOf('\r\n\r\n')
        if(header<0){if(server.buffer.length>8192)fail('TypeScript response header exceeded limit');return}
        const match=/^Content-Length: (\d+)$/im.exec(server.buffer.subarray(0,header).toString())
        if(!match||header>8192){fail('Malformed TypeScript response');return}
        const length=Number(match[1]),end=header+4+length
        if(!Number.isSafeInteger(length)||length<0||length>MAX_CONTENT){fail('Invalid TypeScript response length');return}
        if(server.buffer.length<end)return
        const body=server.buffer.subarray(header+4,end).toString();server.buffer=server.buffer.subarray(end)
        try{
          const response=JSON.parse(body) as Response
          if(!response||typeof response!=='object')throw new Error('Invalid response')
          if(server.lsp&&response.method){
            // The client advertises no server-request features; reject unknown requests rather than hanging the server.
            if(response.id!==undefined)this.send(server,{jsonrpc:'2.0',id:response.id,error:{code:-32601,message:'Unsupported client request'}})
            continue
          }
          const id=server.lsp?response.id:response.type==='response'?response.request_seq:undefined
          if(id!==undefined){const pending=server.pending.get(id);if(pending){server.pending.delete(id);clearTimeout(pending.timer);if(server.lsp?!response.error:response.success)pending.resolve(server.lsp?response.result:response.body);else pending.reject(new Error(response.error?.message??response.message??'TypeScript request failed'))}}
        }catch{fail('Malformed TypeScript response');return}
      }
    })
    if(lsp)try{
      const result=await this.request(server,'initialize',{processId:process.pid,rootUri:pathToFileURL(root).href,capabilities:{general:{positionEncodings:['utf-16']},textDocument:{diagnostic:{}}}}) as {capabilities?:{positionEncoding?:string}}
      if(result?.capabilities?.positionEncoding&&result.capabilities.positionEncoding!=='utf-16')throw new Error('TypeScript server requires unsupported position encoding')
      this.notify(server,'initialized',{})
    }catch(error){await this.stop(scope.indexKey);throw error}
    return server
  }
  private send(server:Server,message:Record<string,unknown>){
    const body=JSON.stringify(message)
    server.process.stdin.write(server.lsp?`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`:body+'\n')
  }
  private notify(server:Server,method:string,params:Record<string,unknown>){if(server.failed)throw new Error(server.failed);this.send(server,{jsonrpc:'2.0',method,params})}
  private request(server:Server,command:string,args:Record<string,unknown>):Promise<unknown>{
    if(server.failed)return Promise.reject(new Error(server.failed))
    if(server.pending.size>=32)return Promise.reject(new Error('Too many language requests'))
    const seq=++server.seq
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{server.pending.delete(seq);reject(new Error('TypeScript request timed out'))},10000)
      server.pending.set(seq,{resolve,reject,timer})
      this.send(server,server.lsp?{jsonrpc:'2.0',id:seq,method:command,params:args}:{seq,type:'request',command,arguments:args})
    })
  }
  private async sync(input:ProjectLanguageDocument){
    const resolved=await this.resolveScope(input.workspacePath),scope={...resolved,checkoutPath:await realpath(resolved.checkoutPath)},path=this.document(input,scope),server=await this.start(scope),seen=server.documents.get(path)
    if(seen&&input.version<seen.version)throw new Error('Stale language document version')
    if(seen&&input.version===seen.version&&input.content!==seen.content)throw new Error('Language document content changed without a new version')
    if(server.lsp){
      const uri=pathToFileURL(path).href
      if(!seen)this.notify(server,'textDocument/didOpen',{textDocument:{uri,languageId:/\.[cm]?tsx?$/.test(path)?'typescript':'javascript',version:input.version,text:input.content}})
      else if(seen.version!==input.version)this.notify(server,'textDocument/didChange',{textDocument:{uri,version:input.version},contentChanges:[{text:input.content}]})
    }else if(!seen)await this.request(server,'open',{file:path,fileContent:input.content,projectRootPath:scope.checkoutPath})
    else if(seen.version!==input.version){const lines=seen.content.split('\n'),end={line:lines.length,offset:(lines.at(-1)?.length??0)+1};await this.request(server,'updateOpen',{changedFiles:[{fileName:path,textChanges:[{start:{line:1,offset:1},end,newText:input.content}]}]})}
    server.documents.set(path,{version:input.version,content:input.content});return {scope,path,server}
  }
  private status(server:Server):ProjectLanguageStatus{return {state:server.failed?'failed':'ready',generation:server.generation,version:server.version,pid:server.process.pid,documents:server.documents.size,detail:server.failed??`TypeScript ${server.version} · project configuration`}}
  async open(input:ProjectLanguageDocument){return this.status((await this.sync(input)).server)}
  async change(input:ProjectLanguageDocument){return this.open(input)}
  async closeDocument(workspacePath:string,path:string){
    const scope=await this.resolveScope(workspacePath),server=this.servers.get(scope.indexKey);if(!server)return
    const file=this.document({workspacePath,path,version:1,content:''},{...scope,checkoutPath:await realpath(scope.checkoutPath)})
    if(server.documents.delete(file)){server.diagnostics.delete(file);if(server.lsp)this.notify(server,'textDocument/didClose',{textDocument:{uri:pathToFileURL(file).href}});else await this.request(server,'close',{file})}
  }
  async diagnostics(input:ProjectLanguageDocument){
    const {path,server}=await this.sync(input)
    const body=await this.request(server,server.lsp?'textDocument/diagnostic':'semanticDiagnosticsSync',server.lsp?{textDocument:{uri:pathToFileURL(path).href}}:{file:path,includeLinePosition:true}) as any
    let diagnostics:ProjectLanguageDiagnostic[]
    if(server.lsp&&body?.kind==='unchanged'){
      const previous=server.diagnostics.get(path);if(!previous)throw new Error('TypeScript omitted initial diagnostics');diagnostics=previous
    }else diagnostics=(server.lsp?body?.items:body??[]).map((item:any):ProjectLanguageDiagnostic=>({
      start:server.lsp?this.lspPosition(item.range?.start):position(item.startLocation),end:server.lsp?this.lspPosition(item.range?.end):position(item.endLocation),
      severity:server.lsp?(item.severity===1?'error':item.severity===2?'warning':'info'):(item.category==='error'?'error':item.category==='warning'?'warning':'info'),code:Number(item.code),message:String(item.message??'TypeScript diagnostic').slice(0,4096)
    }))
    server.diagnostics.set(path,diagnostics)
    return {generation:server.generation,version:input.version,diagnostics}
  }
  private lspPosition(value:any){if(!Number.isSafeInteger(value?.line)||value.line<0||!Number.isSafeInteger(value?.character)||value.character<0)throw new Error('Invalid language position');return {line:value.line+1,column:value.character+1}}
  private async locations(input:ProjectLanguageDocument,line:number,column:number,references:boolean){
    if(!Number.isSafeInteger(line)||line<1||!Number.isSafeInteger(column)||column<1)throw new Error('Invalid language position')
    const {scope,path,server}=await this.sync(input)
    const body=await this.request(server,server.lsp?(references?'textDocument/references':'textDocument/definition'):(references?'references':'definitionAndBoundSpan'),server.lsp?{textDocument:{uri:pathToFileURL(path).href},position:{line:line-1,character:column-1},...(references?{context:{includeDeclaration:true}}:{})}:{file:path,line,offset:column}) as any
    const entries=server.lsp?(Array.isArray(body)?body:body?[body]:[]):references?body?.refs:body?.definitions
    const root=await realpath(scope.checkoutPath),locations:ProjectLanguageDefinition[]=[]
    for(const item of entries??[]){
      const target=server.lsp?fileURLToPath(item.targetUri??item.uri):resolve(String(item.file))
      const file=await realpath(target).catch(async()=>server.documents.has(target)?resolve(await realpath(dirname(target)),relative(dirname(target),target)):null);if(!file)continue
      const rel=relative(root,file);if(rel==='..'||rel.startsWith('..'+sep))continue
      const range=item.targetSelectionRange??item.range
      locations.push({path:rel,start:server.lsp?this.lspPosition(range?.start):position(item.start),end:server.lsp?this.lspPosition(range?.end):position(item.end)})
    }
    return {generation:server.generation,version:input.version,locations}
  }
  async definition(input:ProjectLanguageDocument,line:number,column:number){const {locations,...result}=await this.locations(input,line,column,false);return {...result,definitions:locations}}
  async references(input:ProjectLanguageDocument,line:number,column:number){const {locations,...result}=await this.locations(input,line,column,true);return {...result,references:locations}}
  async inspect(workspacePath:string):Promise<ProjectLanguageStatus>{const scope=await this.resolveScope(workspacePath);const server=this.servers.get(scope.indexKey);if(server)return this.status(server);return {state:this.paused.has(scope.indexKey)?'paused':this.starting.has(scope.indexKey)?'starting':'stopped',generation:this.generation,version:null,detail:this.paused.has(scope.indexKey)?'Project language work paused; existing files remain open.':'No active project language owner. Start uses TypeScript installed in this checkout.'}}
  async stopProject(workspacePath:string){const scope=await this.resolveScope(workspacePath);this.paused.add(scope.indexKey);await this.starting.get(scope.indexKey)?.catch(()=>{});await this.stop(scope.indexKey);return this.inspect(workspacePath)}
  async restart(workspacePath:string){const scope=await this.resolveScope(workspacePath);await this.stopProject(workspacePath);this.paused.delete(scope.indexKey);const server=await this.start(scope);if(!server.lsp)await this.request(server,'configure',{});return this.status(server)}
  private async stop(key:string){
    const server=this.servers.get(key);if(!server)return
    if(server.lsp&&!server.failed) {
      try { await this.request(server,'shutdown',{});this.notify(server,'exit',{}) } catch {}
    }
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
