import { expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createComputerToolDefinition } from '../src/main/project-computer-tools'
import { ProjectTools } from '../src/main/project-tools'
import type { ProjectToolScope } from '../src/shared/project-tools'

const scopes = ['a','b'].map(indexKey => ({indexKey,projectKey:indexKey,checkoutPath:'/tmp/'+indexKey,projectPath:'/tmp/'+indexKey}))
it('fences target ownership, stale frames and desktop input until confirmed termination', async () => {
 const definition=createComputerToolDefinition('/unused'), scope=scopes[0]!, other=scopes[1]!
 let moved=false, denied=false, hold: (()=>void)|undefined
 const native=async(tool?:string,args:Record<string,unknown>={})=>{
  if(tool==='check_permissions')return {structuredContent:{accessibility:!denied,screen_recording:true}}
  if(tool==='list_windows')return {structuredContent:{windows:[1,2].map(window_id=>({pid:10,window_id,bounds:{x:moved?1:0,y:0,width:400,height:200}}))}}
  if(tool==='get_window_state')return {structuredContent:{pid:10,window_id:args.window_id,elements:[{element_token:'s1:0'}]},content:[]}
  if(tool==='type_text')return new Promise<unknown>(resolve=>{hold=()=>resolve({content:[],structuredContent:{effect:'unverifiable'}})})
  return {content:[],structuredContent:{effect:'unverifiable'}}
 }
 const call=(name:string,scope:ProjectToolScope,args:Record<string,unknown>={})=>definition.operations[name]!.run!(scope,native,args)
 denied=true;await expect(call('attach',scope,{owner:'one',pid:10,window:1})).rejects.toThrow('permissions');denied=false
 const a=await call('attach',scope,{owner:'one',pid:10,window:1}) as any
 await expect(call('attach',other,{owner:'two',pid:10,window:1})).rejects.toThrow('already has a controller')
 const b=await call('attach',other,{owner:'two',pid:10,window:2}) as any
 const action={owner:'one',generation:a.structuredContent.attachment.generation,revision:a.structuredContent.attachment.revision,element:'s1:0',text:'hello'}
 await expect(call('click',scope,{...action,owner:'two'})).rejects.toThrow('does not own')
 moved=true;await expect(call('click',scope,action)).rejects.toThrow('moved');moved=false
 await expect(call('click',scope,action)).rejects.toThrow('Stale')
 const fresh=await call('observe',scope) as any
 const pending=call('type',scope,{...action,revision:fresh.structuredContent.attachment.revision})
 await new Promise(resolve=>setTimeout(resolve,0))
 await expect(call('type',other,{...action,owner:'two',generation:b.structuredContent.attachment.generation,revision:b.structuredContent.attachment.revision})).rejects.toThrow('Desktop input')
 hold!();await pending
 // An interrupted native dispatch must hold the lease until the service's verified-stop hook.
 const uncertain=()=>Promise.reject(new Error('transport interrupted'))
 const observed=await call('observe',scope) as any
 const interrupted=async(tool?:string,args?:Record<string,unknown>)=>tool==='type_text'?uncertain():native(tool,args)
 await expect(definition.operations.type!.run!(scope,interrupted,{...action,revision:observed.structuredContent.attachment.revision})).rejects.toThrow('interrupted')
 await expect(call('type',other,{...action,owner:'two',generation:b.structuredContent.attachment.generation,revision:b.structuredContent.attachment.revision})).rejects.toThrow('Desktop input')
 const afterUncertain=await call('observe',scope) as any
 await expect(call('type',scope,{...action,revision:afterUncertain.structuredContent.attachment.revision})).rejects.toThrow('uncertain')
 definition.stopped!(scope)
 const resumed=call('type',other,{...action,owner:'two',generation:b.structuredContent.attachment.generation,revision:b.structuredContent.attachment.revision});await new Promise(resolve=>setTimeout(resolve,0));hold!();await resumed
 definition.stopped!(other)
 await expect(call('click',scope,action)).rejects.toThrow('attach')
})

const binary=process.env.DONWELLS_COMPUTER_TOOL_BINARY
it.skipIf(!binary)('controls only an explicitly attached native fixture through the admitted direct MCP process',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'donwells-control16-'))),project=join(root,'project'),receipt=join(root,'actions.json'),fixture=join(root,'fixture');await mkdir(project)
 execFileSync('swiftc',[resolve('tests/fixtures/native-control.swift'),'-o',fixture])
 const target=spawn(fixture,[receipt],{stdio:'ignore'})
 const tools=new ProjectTools(async path=>({path,projectPath:path}),[createComputerToolDefinition(binary!)],20000)
 const call=(op:string,args:Record<string,unknown>={})=>tools.call(project,'computer-control',op,args) as Promise<any>
 try{
  await new Promise(resolve=>setTimeout(resolve,1000))
  const permissions=await call('permissions');expect(permissions.structuredContent.accessibility).toBe(true)
  const listed=await call('windows'),window=listed.structuredContent.windows.find((window:any)=>window.pid===target.pid&&window.title==='Donwells Control Fixture A');expect(window,JSON.stringify(listed)).toBeTruthy()
  const attached=await call('attach',{owner:'fixture',pid:target.pid,window:window.window_id,foreground:false})
  const button=attached.structuredContent.elements.find((element:any)=>element.label==='Record A');expect(button).toBeTruthy()
  const action={owner:'fixture',generation:attached.structuredContent.attachment.generation,revision:attached.structuredContent.attachment.revision,element:button.element_token}
  const clicked=await call('click',action);expect(clicked.isError,JSON.stringify(clicked)).not.toBe(true)
  await new Promise(resolve=>setTimeout(resolve,200));expect(JSON.parse(await readFile(receipt,'utf8'))[0].target).toBe('A')
  await expect(call('click',action)).rejects.toThrow('Stale')
  const shot=await call('screenshot');expect(shot.content.some((part:any)=>part.type==='image'),JSON.stringify(shot).slice(0,600)).toBe(true)
  target.kill();await new Promise<void>(resolve=>target.once('exit',()=>resolve()))
  await expect(call('observe')).rejects.toThrow('closed')
  await tools.stop(project,'computer-control')
 }finally{await tools.close();if(target.exitCode===null)target.kill()}
},60000)
