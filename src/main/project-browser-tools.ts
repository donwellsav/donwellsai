import { createHash, randomUUID } from 'node:crypto'
import { readFile, mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join, isAbsolute, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { isObject } from '@shared/command-catalog'
import type { ProjectToolDefinition } from './project-tools'
import type { ProjectToolScope } from '@shared/project-tools'

type Options = { packagePath: string; browser: string; cache: string; program: string; target: (path: string) => {id:number;url:string} }
type Binding = { id: string; previewId: number; url: string; revision: number; busy: boolean; refs: Set<string>; directory: string }
const text = (value: unknown) => { if(typeof value !== 'string' || !value || value.length > 4096) throw new Error('Expected bounded text'); return value }
const revision = (value: unknown) => { if(!Number.isSafeInteger(value) || Number(value)<1) throw new Error('A current snapshot revision is required'); return value }
const digest = async (file:string) => { const hash=createHash('sha256');for await(const chunk of createReadStream(file)) hash.update(chunk);return hash.digest('hex') }

/** One admitted managed context per checkout, reusing ProjectTools transport and process ownership. */
export function createBrowserToolDefinition(options: Options): ProjectToolDefinition {
  const bindings = new Map<string,Binding>()
  const current = (scope:ProjectToolScope) => {
    const target=options.target(scope.checkoutPath), url=new URL(target.url)
    if(!['http:','https:'].includes(url.protocol) || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('Browser testing currently requires an identified local project preview')
    return target
  }
  const binding = (scope:ProjectToolScope) => {
    const item=bindings.get(scope.indexKey), target=current(scope)
    if(!item || item.previewId!==target.id || item.url!==target.url) throw new Error('Preview target changed. Stop browser testing, then start a fresh context.')
    return item
  }
  const run = (operation:string) => async(scope:ProjectToolScope, request:()=>Promise<unknown>, args:Record<string,unknown>) => {
    const item=binding(scope)
    if(item.busy) throw new Error('This browser context already has an operation in progress')
    if(operation==='click'||operation==='type') {
      if(args.revision!==item.revision || !item.refs.has(String(args.target))) throw new Error('Stale browser element. Take a fresh snapshot before acting.')
      delete args.revision
    }
    item.busy=true
    // Consume references before input; an uncertain click never becomes retryable by retaining old references.
    if(['navigate','click','type','snapshot'].includes(operation)) {item.refs.clear();item.revision++}
    try {
      const result=await request()
      if(binding(scope)!==item) throw new Error('Browser target changed during operation; inspect before retrying')
      if(!isObject(result) || !Array.isArray(result.content)) throw new Error('Malformed browser result')
      const parts=result.content.filter(part=>isObject(part)&&part.type==='text').map(part=>String(part.text))
      const native=parts.join('\n')
      const pageUrl=/^- Page URL: (.+)$/m.exec(native)?.[1]
      if(pageUrl && new URL(pageUrl).origin!==new URL(item.url).origin) throw new Error('Managed browser left the selected preview origin. Stop and inspect this context.')
      const artifacts: Array<{path:string;sha256:string}> = []
      for(const match of native.matchAll(/\]\(([^)]+)\)/g)) {
        const candidate=match[1]!
        if(/^\w+:\/\//.test(candidate)) continue
        const candidates=isAbsolute(candidate)?[candidate]:[resolve(item.directory,candidate),resolve(scope.checkoutPath,candidate)]
        const path=(await Promise.all(candidates.map(path=>realpath(path).catch(()=>null)))).find(path=>path?.startsWith(item.directory+'/'))
        if(!path || !path.startsWith(item.directory+'/')) continue
        const file=await stat(path)
        if(!file.isFile() || file.size>32*1024*1024) continue
        artifacts.push({path,sha256:await digest(path)})
        if(/\.(yml|yaml|md|txt)$/.test(path) && file.size<256*1024) parts.push(await readFile(path,'utf8'))
      }
      if(['navigate','snapshot','click','type'].includes(operation) && !result.isError) for(const match of parts.join('\n').matchAll(/\[ref=([^\]]+)\]/g)) item.refs.add(match[1]!)
      const context={id:item.id,workspacePath:scope.checkoutPath,previewId:item.previewId,previewUrl:item.url,mode:'managed isolated browser',outcome:result.isError && ['navigate','click','type','traceStart','traceStop'].includes(operation)?'uncertain; inspect before retrying':'observed',revision:item.revision,artifacts,untrusted:true}
      return {...result,structuredContent:context,content:[{type:'text',text:JSON.stringify(context)},...parts.map(text=>({type:'text',text}))]}
    } catch(error) { item.refs.clear();throw error } finally {item.busy=false}
  }
  return {
    id:'browser-testing',version:'1.63.0-alpha-2026-08-31',scope:'checkout',
    prepare:async(scope,signal)=>{
      const selected=current(scope)
      if(!isAbsolute(options.packagePath)||!isAbsolute(options.browser)||!isAbsolute(options.cache)) throw new Error('Browser testing requires absolute admitted tool paths')
      const pkg=JSON.parse(await readFile(join(options.packagePath,'package.json'),'utf8'))
      const require=createRequire(join(options.packagePath,'package.json'))
      const core=require.resolve('playwright-core/lib/coreBundle')
      if(pkg.version!=='0.0.80'||await digest(join(options.packagePath,'cli.js'))!=='70dab09ab9a5bc1943fb78e2655f00af7349f9931073833919f19c5d7d786ad6'||await digest(core)!=='7aa0bf8b6b69d32065912e3d8f7e3c18c62de4d668f770a8e039811d3cf9c6a0'||await digest(options.browser)!=='a596b1cfc6353e987fcec8d71a23a28cd6a9e7a6b4e20b908e4c4fcffe51158e') throw new Error('Browser testing artifact does not match the admitted distribution')
      signal.throwIfAborted()
      let directory=join(options.cache,scope.indexKey,randomUUID());await mkdir(directory,{recursive:true,mode:0o700});directory=await realpath(directory)
      await writeFile(join(directory,'config.json'),JSON.stringify({browser:{browserName:'chromium',isolated:true,launchOptions:{headless:true,executablePath:options.browser},contextOptions:{viewport:{width:1280,height:800}}},capabilities:['core','devtools'],outputDir:directory,imageResponses:'omit',snapshot:{mode:'full',boxes:true},network:{allowedOrigins:[new URL(selected.url).origin]},timeouts:{action:5000,navigation:15000}}),{mode:0o600})
      if(current(scope).id!==selected.id||current(scope).url!==selected.url) throw new Error('Preview changed during browser setup')
      bindings.set(scope.indexKey,{id:randomUUID(),previewId:selected.id,url:selected.url,revision:0,busy:false,refs:new Set(),directory})
    },
    launch:scope=>({program:options.program,args:[join(options.packagePath,'cli.js'),'--config',join(binding(scope).directory,'config.json')],env:{ELECTRON_RUN_AS_NODE:'1'}}),
    operations:{
      navigate:{tool:'browser_navigate',readOnly:false,parameters:{},targets:scope=>({url:current(scope).url}),run:run('navigate')},
      snapshot:{tool:'browser_snapshot',readOnly:true,parameters:{},targets:()=>({}),run:run('snapshot')},
      click:{tool:'browser_click',readOnly:false,parameters:{target:text,revision},targets:()=>({}),run:run('click')},
      type:{tool:'browser_type',readOnly:false,parameters:{target:text,text:value=>value===''?'':text(value),revision},targets:()=>({}),run:run('type')},
      screenshot:{tool:'browser_take_screenshot',readOnly:true,parameters:{},targets:scope=>({filename:join(binding(scope).directory,'preview.png'),type:'png',scale:'css'}),run:run('screenshot')},
      console:{tool:'browser_console_messages',readOnly:true,parameters:{},targets:()=>({level:'error'}),run:run('console')},
      layout:{tool:'browser_evaluate',readOnly:true,parameters:{},targets:()=>({function:'() => ({url:location.href,viewport:{width:innerWidth,height:innerHeight},document:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},horizontalOverflow:document.documentElement.scrollWidth>innerWidth})'}),run:run('layout')},
      network:{tool:'browser_network_requests',readOnly:true,parameters:{},targets:()=>({static:true}),run:run('network')},
      traceStart:{tool:'browser_start_tracing',readOnly:false,parameters:{},targets:()=>({}),run:run('traceStart')},
      traceStop:{tool:'browser_stop_tracing',readOnly:false,parameters:{},targets:()=>({}),run:run('traceStop')}
    }
  }
}
