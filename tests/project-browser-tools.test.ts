import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserToolDefinition } from '../src/main/project-browser-tools'
import { ProjectTools, resolveProjectToolScope } from '../src/main/project-tools'
const packagePath=process.env.DONWELLS_BROWSER_TOOL_PACKAGE
const browser=process.env.DONWELLS_BROWSER_TOOL_EXECUTABLE
const options={packagePath:packagePath??'/unconfigured',browser:browser??'/unconfigured',cache:'/unused',program:process.execPath,target:()=>({id:1,url:'http://127.0.0.1:1234/'})}
it('restricts parameters and refuses targets without local preview identity',()=>{
 const definition=createBrowserToolDefinition({...options,target:()=>({id:1,url:'https://example.com/'})})
 expect(()=>definition.operations.navigate!.targets({} as never)).toThrow('local project preview')
 expect(()=>definition.operations.click!.parameters.revision!(0)).toThrow('snapshot revision')
 expect(()=>definition.operations.type!.parameters.text!('x'.repeat(4097))).toThrow('bounded text')
 expect(definition.operations.type!.parameters.text!('')).toBe('')
 expect(definition.operations.click!.readOnly).toBe(false)
 expect(definition.operations.traceStop!.readOnly).toBe(false)
 expect(Object.keys(definition.operations.navigate!.parameters)).toEqual([])
})
it.skipIf(!packagePath||!browser)('uses a single native context, expires refs, records evidence and fences changed preview identity',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'browser-tools-15-'))), project=join(root,'project');await mkdir(project)
 let waiting:()=>void=()=>{};const slow=new Promise<void>(resolve=>{waiting=resolve})
 const server=createServer((_req,res)=>{if(_req.url==='/slow'){waiting();return}res.setHeader('Content-Type','text/html');res.end('<title>Scoped browser canary</title><label>Name<input></label><button onclick="document.querySelector(\'p\').textContent=document.querySelector(\'input\').value">Save</button><p>Ready</p><button onclick="location.href=\'/slow\'">Wait</button><script>console.error("CONSOLE_PROOF_15")</script>')})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('No server')
 let target={id:15,url:`http://127.0.0.1:${address.port}/`}
 let targetReads=0
 const definition=createBrowserToolDefinition({...options,cache:join(root,'cache'),target:()=>++targetReads===1?{...target,url:target.url+'before-setup'}:target})
 const tools=new ProjectTools(async path=>{if(path!==project)throw new Error('foreign');return {path,projectPath:path}},[definition],30000)
 const call=async(operation:string,args:Record<string,unknown>={})=>{const result=await tools.call(project,'browser-testing',operation,args) as {isError?:boolean;content:Array<{text:string}>;structuredContent:{id:string;revision:number;previewOrigin:string;currentUrl:string|null;artifacts:unknown[]}};expect(result.isError,JSON.stringify(result)).not.toBe(true);return result}
 try{
  const opened=await call('navigate'), text=opened.content.map(p=>p.text).join('\n'), input=/textbox "Name"[^\n]*?\[ref=([^\]]+)\]/.exec(text)?.[1];expect(input,text).toBeTruthy();expect(text).not.toContain('before-setup');expect(opened.structuredContent).toMatchObject({previewOrigin:new URL(target.url).origin,currentUrl:target.url})
  const typed=await call('type',{target:input,revision:opened.structuredContent.revision,text:'SAVED_15'})
  expect(typed.structuredContent.id).toBe(opened.structuredContent.id)
  const beforeClear=await call('snapshot'), clearRef=/textbox "Name"[^\n]*?\[ref=([^\]]+)\]/.exec(beforeClear.content.map(p=>p.text).join('\n'))?.[1]
  expect(clearRef,JSON.stringify(beforeClear)).toBeTruthy()
  await call('type',{target:clearRef,revision:beforeClear.structuredContent.revision,text:''})
  const afterClear=await call('snapshot'), clearText=afterClear.content.map(p=>p.text).join('\n'), refillRef=/textbox "Name"[^\n]*?\[ref=([^\]]+)\]/.exec(clearText)?.[1]
  expect(clearText).not.toContain('SAVED_15');expect(refillRef).toBeTruthy()
  await call('type',{target:refillRef,revision:afterClear.structuredContent.revision,text:'SAVED_15'})
  await expect(call('type',{target:input,revision:opened.structuredContent.revision,text:'stale'})).rejects.toThrow('Stale browser element')
  const overlap=await Promise.allSettled([call('snapshot'),call('snapshot')]);expect(overlap.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(overlap.some(result=>result.status==='rejected'&&String(result.reason).includes('in progress'))).toBe(true)
  const snapshot=await call('snapshot'), page=snapshot.content.map(p=>p.text).join('\n'), button=/button "Save" \[ref=([^\]]+)\]/.exec(page)?.[1];expect(button,page).toBeTruthy()
  await call('traceStart')
  const clicked=await call('click',{target:button,revision:snapshot.structuredContent.revision});expect(JSON.stringify(clicked)).toContain('SAVED_15')
  expect(JSON.stringify(await call('console'))).toContain('CONSOLE_PROOF_15')
  expect(JSON.stringify(await call('network'))).toContain(target.url)
  const shot=await call('screenshot');expect(shot.structuredContent.artifacts.length,JSON.stringify(shot)).toBeGreaterThan(0)
  const trace=await call('traceStop');expect(trace.structuredContent.artifacts.length,JSON.stringify(trace)).toBeGreaterThan(0)
  await expect(call('navigate',{url:'http://other/'})).rejects.toThrow('not permitted')
  const beforeStop=await call('snapshot'), waitRef=/button "Wait" \[ref=([^\]]+)\]/.exec(beforeStop.content.map(p=>p.text).join('\n'))?.[1];expect(waitRef).toBeTruthy()
  const interrupted=call('click',{target:waitRef,revision:beforeStop.structuredContent.revision}).then(()=>({code:'unexpected-success'}),error=>({code:error.code}))
  await slow;await tools.stop(project,'browser-testing');expect(await interrupted).toEqual({code:'TOOL_OUTCOME_UNCERTAIN'})
  await call('navigate')
  target={...target,id:16}
  await expect(call('snapshot')).rejects.toThrow('target changed')
 }finally{await tools.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
},60000)
