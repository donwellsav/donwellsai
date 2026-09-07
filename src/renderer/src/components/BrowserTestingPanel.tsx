import { useEffect, useId, useRef, useState } from 'react'
import { isObject } from '@shared/command-catalog'
import type { VerificationEntry } from '@shared/operational-runs'
import { ModalDialog } from './ModalDialog'

type BrowserContext = { id:string; previewOrigin:string; previewUrl:string; currentUrl:string|null; revision:number; outcome:string; artifacts:Array<{path:string;sha256:string}> }

export function BrowserTestingPanel({ workspacePath, onClose }: {workspacePath:string;onClose:()=>void}) {
  const request=useRef(0), id=useId()
  const [available,setAvailable]=useState(false), [busy,setBusy]=useState(false), [output,setOutput]=useState('Checking browser testing availability…')
  const [context,setContext]=useState<BrowserContext|null>(null), [target,setTarget]=useState(''), [text,setText]=useState('')
  const [runs,setRuns]=useState<VerificationEntry[]>([]), [runTask,setRunTask]=useState(''), [message,setMessage]=useState('')
  useEffect(()=>{let live=true;void window.donwells.projectToolsList(workspacePath).then(services=>{if(!live)return;const service=services.find(service=>service.id==='browser-testing');setAvailable(!!service);setOutput(service?`${service.status} · ${service.version??'Playwright MCP'}${service.detail?' · '+service.detail:''}`:'Browser testing is unavailable. Configure the admitted Playwright MCP package and browser executable in tool setup.')}).catch(error=>{if(live)setOutput(String(error))});return()=>{live=false}},[workspacePath])
  const refreshRuns=async()=>{const values=await window.donwells.verificationList(workspacePath,false);setRuns(values);setRunTask(current=>values.some(entry=>entry.task.id===current)?current:values.find(entry=>entry.sourceState!=='running')?.task.id??'')}
  const run=async(operation:string,args:Record<string,unknown>={})=>{
    const sequence=++request.current;setBusy(true);setMessage('')
    try {
      const result=operation==='stop'?await window.donwells.projectToolStop(workspacePath,'browser-testing'):await window.donwells.projectToolCall(workspacePath,'browser-testing',operation,args)
      if(sequence!==request.current)return
      if(result===undefined){setContext(null);setOutput('Managed testing browser stopped. Human preview retained.');return}
      if(!isObject(result)||!Array.isArray(result.content))throw new Error('Browser testing returned an invalid response')
      const next=isObject(result.structuredContent)?result.structuredContent:null
      if(next&&typeof next.id==='string'&&typeof next.previewOrigin==='string'&&typeof next.previewUrl==='string'&&Number.isSafeInteger(next.revision)&&Array.isArray(next.artifacts)){
        setContext(next as BrowserContext)
        if(next.artifacts.length)await refreshRuns()
      }
      setOutput(result.content.slice(1).filter(part=>isObject(part)&&typeof part.text==='string').map(part=>part.text).join('\n\n'))
    } catch(error){if(sequence===request.current)setOutput(String(error))}finally{if(sequence===request.current)setBusy(false)}
  }
  const attach=async(path:string)=>{
    const selected=runs.find(entry=>entry.task.id===runTask);if(!selected)return
    setBusy(true);setMessage('')
    try{const artifact=await window.donwells.verificationAttach(workspacePath,selected.runId,selected.task.id,path);setMessage(`${artifact.path} attached as a reference; its producer is not inferred.`);await refreshRuns()}catch(error){setMessage(String(error))}finally{setBusy(false)}
  }
  return <ModalDialog className="modal browser-testing-dialog" labelledBy={id} onClose={onClose}>
    <h2 id={id} className="modal-title">Browser testing</h2>
    <p>One isolated testing context for this project, separate from the human preview. Native agents share this context through their browser_test tools.</p>
    {context&&<p role="status">Managed context {context.id.slice(0,8)} · preview origin {context.previewOrigin} · current page {context.currentUrl??'not observed'} · observation revision {context.revision} · {context.outcome}</p>}
    <div style={{display:'flex',flexWrap:'wrap',gap:6}}>{Object.entries({navigate:'Open preview in testing context',snapshot:'Inspect',screenshot:'Screenshot',console:'Console errors',network:'Network',layout:'Layout measurements',traceStart:'Start trace',traceStop:'Save trace'}).map(([operation,label])=><button className="btn btn-secondary btn-sm" key={operation} type="button" disabled={!available||busy} onClick={()=>void run(operation)}>{label}</button>)}<button className="btn btn-secondary btn-sm" type="button" disabled={!available} onClick={()=>void run('stop')}>{busy?'Cancel and stop testing browser':'Stop testing browser'}</button></div>
    <fieldset disabled={!context||busy}><legend>Act on the latest inspected element</legend><label>Element reference<input className="input" value={target} onChange={event=>setTarget(event.target.value)} placeholder="e.g. e12" /></label><label>Text<input className="input" value={text} onChange={event=>setText(event.target.value)} /></label><button className="btn btn-secondary btn-sm" type="button" disabled={!target} onClick={()=>void run('click',{target,revision:context!.revision})}>Click</button><button className="btn btn-secondary btn-sm" type="button" disabled={!target} onClick={()=>void run('type',{target,text,revision:context!.revision})}>Type</button></fieldset>
    <pre style={{fontSize:12,margin:0}} className="project-search-document" aria-live="polite">{output}</pre>
    {context?.artifacts.length? <details><summary>Generated artifacts ({context.artifacts.length})</summary><p>Attach a generated file to an existing verification run. Attachment records a checked reference; it does not claim the run produced it.</p>{runs.length?<label>Verification run<select className="input" value={runTask} onChange={event=>setRunTask(event.target.value)}>{runs.filter(entry=>entry.sourceState!=='running').map(entry=><option key={entry.task.id} value={entry.task.id}>{entry.task.command} · {entry.task.status}</option>)}</select></label>:<p>Run a project verification command before attaching browser evidence.</p>}{context.artifacts.map(artifact=><div key={artifact.path}><code>{artifact.path}</code><br/><code>{artifact.sha256}</code> <button className="btn btn-secondary btn-sm" type="button" disabled={busy||!runTask} onClick={()=>void attach(artifact.path)}>Attach reference</button></div>)}{message&&<p role="status">{message}</p>}</details>:null}
    <button className="btn btn-secondary btn-sm" type="button" onClick={onClose}>Close browser testing</button>
  </ModalDialog>
}
