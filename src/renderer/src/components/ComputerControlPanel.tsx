import { useEffect, useId, useRef, useState } from 'react'
import { isObject } from '@shared/command-catalog'

export function ComputerControlPanel({workspacePath}:{workspacePath:string}) {
 const id=useId(),owner=useRef(crypto.randomUUID()),sequence=useRef(0)
 const [available,setAvailable]=useState(false),[busy,setBusy]=useState(false),[output,setOutput]=useState('Check permissions before selecting an app window.'),[windows,setWindows]=useState<Record<string,unknown>[]>([]),[selected,setSelected]=useState(''),[foreground,setForeground]=useState(false),[image,setImage]=useState('')
 useEffect(()=>{let live=true;void window.donwells.projectToolsList(workspacePath).then(services=>{if(live){setAvailable(services.some(service=>service.id==='computer-control'));if(!services.some(service=>service.id==='computer-control'))setOutput('Computer control is unavailable. Configure the admitted external Cua Driver in tool setup.')}}).catch(error=>{if(live)setOutput(String(error))});return()=>{live=false;sequence.current++}},[workspacePath])
 const run=async(operation:string)=>{
  const generation=++sequence.current;setBusy(true)
  try{
   const target=windows.find(window=>String(window.window_id)===selected)
   if(operation==='attach'&&!target)throw new Error('Choose an app window first')
   const result=operation==='stop'?await window.donwells.projectToolStop(workspacePath,'computer-control'):await window.donwells.projectToolCall(workspacePath,'computer-control',operation,operation==='attach'?{owner:owner.current,pid:target!.pid,window:target!.window_id,foreground}:{})
   if(generation!==sequence.current)return
   setImage('')
   if(operation==='stop'){setOutput('Controller stopped and released.');return}
   if(!isObject(result))throw new Error('Invalid computer-control response')
   if(isObject(result.structuredContent)&&Array.isArray(result.structuredContent.windows)){setWindows(result.structuredContent.windows.filter(isObject));setOutput(`${result.structuredContent.windows.length} windows available. Choose the exact app and window above.`);return}
   if(Array.isArray(result.content)){
    setOutput(result.content.filter(part=>isObject(part)&&part.type==='text').map(part=>part.text).join('\n\n'))
    const shot=result.content.find(part=>isObject(part)&&part.type==='image'&&part.mimeType==='image/png')
    if(isObject(shot)&&typeof shot.data==='string')setImage(`data:image/png;base64,${shot.data}`)
   }
  }catch(error){if(generation===sequence.current)setOutput(String(error))}finally{if(generation===sequence.current)setBusy(false)}
 }
 return <section className="project-graph" style={{padding:12,overflow:'auto'}} aria-label="Native computer control">
  <p>Control one selected app window. Background delivery is preferred. Release stops the owned controller before another can take over.</p>
  <div style={{display:'flex',flexWrap:'wrap',gap:6}}><button className="btn btn-sm" disabled={!available||busy} onClick={()=>void run('permissions')}>Check permissions</button><button className="btn btn-sm" disabled={!available||busy} onClick={()=>void run('windows')}>List app windows</button></div>
  <label htmlFor={id}>App window</label><select className="settings-select" style={{width:'100%',maxWidth:'100%'}} id={id} value={selected} onChange={event=>setSelected(event.target.value)} disabled={busy}><option value="">Choose a window</option>{windows.map(window=><option key={String(window.window_id)} value={String(window.window_id)}>{String(window.app_name)} · {String(window.title)} · PID {String(window.pid)} / {String(window.window_id)}</option>)}</select>
  <label><input type="checkbox" checked={foreground} onChange={event=>setForeground(event.target.checked)} disabled={busy}/> Allow foreground input for this attachment</label>
  <div style={{display:'flex',flexWrap:'wrap',gap:6}}>{Object.entries({attach:'Attach selected window',status:'Show controller',observe:'Inspect',screenshot:'Screenshot'}).map(([operation,label])=><button className="btn btn-sm" key={operation} disabled={!available||busy||(operation==='attach'&&!selected)} onClick={()=>void run(operation)}>{label}</button>)}<button className="btn btn-sm" disabled={!available} onClick={()=>void run('stop')}>Stop and release</button></div>
  <pre className="project-search-document" style={{fontSize:11,margin:0}} aria-live="polite">{output}</pre>
  {image&&<img src={image} alt="Current attached app window" style={{maxWidth:'100%',height:'auto'}}/>}
 </section>
}
