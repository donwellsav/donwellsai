import { useEffect, useId, useRef, useState } from 'react'
import { useAppStore } from '../store'
import { isObject } from '@shared/command-catalog'
import type { VerificationEntry } from '@shared/operational-runs'
import { ModalDialog } from './ModalDialog'

type BrowserContext = { id:string; previewOrigin:string; previewUrl:string; currentUrl:string|null; revision:number; outcome:string; artifacts:Array<{path:string;sha256:string}> }

export function BrowserTestingPanel({ workspacePath, onClose }: {workspacePath:string;onClose:()=>void}) {
  const request=useRef(0), id=useId()
  const [available,setAvailable]=useState(false), [busy,setBusy]=useState(false), [output,setOutput]=useState('Checking browser testing availability…')
  const [context,setContext]=useState<BrowserContext|null>(null), [target,setTarget]=useState(''), [text,setText]=useState('')
  const [runs,setRuns]=useState<VerificationEntry[]>([]), [runTask,setRunTask]=useState(''), [message,setMessage]=useState('')
  useEffect(()=>{let live=true;void window.donwells.projectToolsList(workspacePath).then(services=>{if(!live)return;const service=services.find(service=>service.id==='browser-testing');setAvailable(!!service);setOutput(service?`${service.status} · ${service.version??'Playwright MCP'}${service.detail?' · '+service.detail:''}`:'Browser testing needs Playwright MCP and its browser. Set them up to inspect your project preview.')}).catch(error=>{if(live)setOutput(String(error))});return()=>{live=false;request.current++}},[workspacePath])
  const refreshRuns=async(sequence:number)=>{const values=await window.donwells.verificationList(workspacePath,false);if(sequence!==request.current)return;setRuns(values);setRunTask(current=>values.some(entry=>entry.task.id===current)?current:values.find(entry=>entry.sourceState!=='running')?.task.id??'')}
  const run=async(operation:string,args:Record<string,unknown>={})=>{
    const sequence=++request.current;setBusy(true);setMessage('');setTarget('')
    try {
      const result=operation==='stop'?await window.donwells.projectToolStop(workspacePath,'browser-testing'):await window.donwells.projectToolCall(workspacePath,'browser-testing',operation,args)
      if(sequence!==request.current)return
      if(result===undefined){setContext(null);setOutput('Managed testing browser stopped. Human preview retained.');return}
      if(!isObject(result)||!Array.isArray(result.content))throw new Error('Browser testing returned an invalid response')
      const next=isObject(result.structuredContent)?result.structuredContent:null
      if(next&&typeof next.id==='string'&&typeof next.previewOrigin==='string'&&typeof next.previewUrl==='string'&&Number.isSafeInteger(next.revision)&&Array.isArray(next.artifacts)){
        setContext(next as BrowserContext)
        if(next.artifacts.length)await refreshRuns(sequence)
      }
      if(sequence!==request.current)return
      setOutput(result.content.slice(1).filter(part=>isObject(part)&&typeof part.text==='string').map(part=>part.text).join('\n\n'))
    } catch(error){if(sequence===request.current)setOutput(String(error))}finally{if(sequence===request.current)setBusy(false)}
  }
  const attach=async(path:string)=>{
    const selected=runs.find(entry=>entry.task.id===runTask);if(!selected)return
    const sequence=++request.current;setBusy(true);setMessage('')
    try{const artifact=await window.donwells.verificationAttach(workspacePath,selected.runId,selected.task.id,path);if(sequence!==request.current)return;setMessage(`${artifact.path} attached as a reference; its producer is not inferred.`);await refreshRuns(sequence)}catch(error){if(sequence===request.current)setMessage(String(error))}finally{if(sequence===request.current)setBusy(false)}
  }
  const observedElements = [...new Map(output.split('\n').flatMap(line => { const ref = /\[ref=([^\]]+)\]/.exec(line); return ref ? [[ref[1]!, line.replace(/\[ref=[^\]]+\]/g, '').trim()] as const] : [] })).entries()]
  if (!available) return <ModalDialog labelledBy={id} onClose={onClose}><h2 id={id} className="modal-title">Browser testing setup</h2><p role="status">{output || 'Checking browser testing…'}</p><div className="modal-footer"><button className="btn btn-secondary" onClick={onClose}>Close</button><button className="btn btn-primary" onClick={()=>{onClose();useAppStore.getState().openSettings('project')}}>Set up tools</button></div></ModalDialog>
  return <ModalDialog className="modal browser-testing-dialog" labelledBy={id} onClose={onClose}>
    <h2 id={id} className="modal-title">Browser testing</h2>
    {!context && <p>Open your project preview in a separate testing browser.</p>}
    {context&&<p role="status">{context.currentUrl ?? context.previewUrl}{context.outcome !== 'observed' && ` · ${context.outcome}`}</p>}
    <div style={{display:'flex',flexWrap:'wrap',gap:6}}>{Object.entries(context ? {snapshot:'Inspect',screenshot:'Screenshot'} : {navigate:'Open preview in testing context'}).map(([operation,label])=><button className="btn btn-secondary btn-sm" key={operation} type="button" disabled={!available||busy} onClick={()=>void run(operation)}>{label}</button>)}<button className="btn btn-secondary btn-sm" type="button" disabled={!available} onClick={()=>void run('stop')}>{busy?'Cancel and stop testing browser':'Stop testing browser'}</button></div>
    {context && observedElements.length > 0 && <fieldset disabled={busy}><legend>Act on the latest inspected element</legend><label>Observed element<select className="input" value={target} onChange={event=>setTarget(event.target.value)}><option value="">Choose an inspected element</option>{observedElements.map(([ref, label]) => <option key={ref} value={ref}>{label}</option>)}</select></label><label>Text<input className="input" value={text} onChange={event=>setText(event.target.value)} /></label><button className="btn btn-secondary btn-sm" type="button" disabled={!target} onClick={()=>void run('click',{target,revision:context!.revision})}>Click</button><button className="btn btn-secondary btn-sm" type="button" disabled={!target} onClick={()=>void run('type',{target,text,revision:context!.revision})}>Type</button></fieldset>}
    {context && <details><summary>Browser diagnostics</summary><p>Context {context.id.slice(0,8)} · origin {context.previewOrigin} · observation {context.revision}</p>
      <div style={{display:'flex',flexWrap:'wrap',gap:6}}>{Object.entries({navigate:'Reopen preview',console:'Console errors',network:'Network',layout:'Layout measurements',traceStart:'Start trace',traceStop:'Save trace'}).map(([operation,label])=><button className="btn btn-secondary btn-sm" key={operation} type="button" disabled={busy} onClick={()=>void run(operation)}>{label}</button>)}</div>
    </details>}
    <pre style={{fontSize:12,margin:0}} className="project-search-document" aria-live="polite">{output}</pre>
    {context?.artifacts.length? <details><summary>Generated artifacts ({context.artifacts.length})</summary><p>Attach a generated file to an existing verification run. Attachment records a checked reference; it does not claim the run produced it.</p>{runs.length?<label>Verification run<select className="input" value={runTask} onChange={event=>setRunTask(event.target.value)}>{runs.filter(entry=>entry.sourceState!=='running').map(entry=><option key={entry.task.id} value={entry.task.id}>{entry.task.command} · {entry.task.status}</option>)}</select></label>:<p>Run a project verification command before attaching browser evidence.</p>}{context.artifacts.map(artifact=><div key={artifact.path}><code>{artifact.path}</code><br/><button className="btn btn-secondary btn-sm" type="button" onClick={() => void window.donwells.projectBrowserArtifactReveal(workspacePath, artifact.path, artifact.sha256).catch(cause => setMessage(String(cause)))}>Reveal file</button> <button className="btn btn-secondary btn-sm" type="button" disabled={busy||!runTask} onClick={()=>void attach(artifact.path)}>Attach reference</button></div>)}{message&&<p role="status">{message}</p>}</details>:null}
    <div className="modal-footer"><button className="btn btn-secondary" type="button" onClick={onClose}>Close</button></div>
  </ModalDialog>
}
