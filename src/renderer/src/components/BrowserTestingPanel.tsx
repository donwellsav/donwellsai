import { useEffect, useId, useRef, useState } from 'react'
import { isObject } from '@shared/command-catalog'
import { ModalDialog } from './ModalDialog'

export function BrowserTestingPanel({ workspacePath, onClose }: {workspacePath:string;onClose:()=>void}) {
  const request=useRef(0)
  const id=useId(), [available,setAvailable]=useState(false), [busy,setBusy]=useState(false), [output,setOutput]=useState('Checking browser testing availability…')
  useEffect(()=>{let live=true;void window.donwells.projectToolsList(workspacePath).then(services=>{if(!live)return;const service=services.find(service=>service.id==='browser-testing');setAvailable(!!service);setOutput(service?`${service.status} · ${service.version??'Playwright MCP'}${service.detail?' · '+service.detail:''}`:'Browser testing is unavailable. Configure the admitted Playwright MCP package and browser executable in tool setup.')}).catch(error=>{if(live)setOutput(String(error))});return()=>{live=false}},[workspacePath])
  const run=async(operation:string)=>{
    const sequence=++request.current
    setBusy(true)
    try {const result=operation==='stop'?await window.donwells.projectToolStop(workspacePath,'browser-testing'):await window.donwells.projectToolCall(workspacePath,'browser-testing',operation,{});if(sequence===request.current)setOutput(result===undefined?'Managed testing browser stopped. Human preview retained.':isObject(result)&&Array.isArray(result.content)?result.content.slice(1).filter(part=>isObject(part)&&typeof part.text==='string').map(part=>part.text).join('\n\n'):JSON.stringify(result,null,2))}catch(error){if(sequence===request.current)setOutput(String(error))}finally{if(sequence===request.current)setBusy(false)}
  }
  return <ModalDialog labelledBy={id} onClose={onClose}>
    <h2 id={id} className="modal-title">Browser testing</h2>
    <p>One isolated testing context for this project, separate from the human preview. Native agents share this context through their browser_test tools.</p>
    <div style={{display:'flex',flexWrap:'wrap',gap:6}}>{Object.entries({navigate:'Open preview in testing context',snapshot:'Inspect',screenshot:'Screenshot',console:'Console errors',network:'Network',layout:'Layout measurements',traceStart:'Start trace',traceStop:'Save trace'}).map(([operation,label])=><button className="btn btn-secondary btn-sm" key={operation} type="button" disabled={!available||busy} onClick={()=>void run(operation)}>{label}</button>)}<button className="btn btn-secondary btn-sm" type="button" disabled={!available} onClick={()=>void run('stop')}>Stop testing browser</button></div>
    <pre style={{fontSize:12,margin:0}} className="project-search-document" aria-live="polite">{output}</pre>
    <button className="btn btn-secondary btn-sm" type="button" onClick={onClose}>Close browser testing</button>
  </ModalDialog>
}
