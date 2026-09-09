import { useEffect, useId, useRef, useState } from 'react'
import { useAppStore } from '../store'
import { Icon } from './Icon'
import { isObject } from '@shared/command-catalog'

type Attachment = { app:string; title:string; pid:number; window:number; generation:number; revision:number; foregroundAllowed:boolean }
type Element = { element_token:string; label?:string; role?:string }

export function ComputerControlPanel({workspacePath}:{workspacePath:string}) {
 const id=useId(),owner=useRef(crypto.randomUUID()),sequence=useRef(0)
 const [available,setAvailable]=useState(false),[busy,setBusy]=useState(false),[output,setOutput]=useState('Check permissions before selecting an app window.'),[windows,setWindows]=useState<Record<string,unknown>[]>([]),[selected,setSelected]=useState(''),[foreground,setForeground]=useState(false),[image,setImage]=useState('')
 const [attachment,setAttachment]=useState<Attachment|null>(null),[elements,setElements]=useState<Element[]>([]),[element,setElement]=useState(''),[input,setInput]=useState(''),[keys,setKeys]=useState('Enter')
 const [checking,setChecking]=useState(true)
 const [actionKind,setActionKind]=useState('click'),[failed,setFailed]=useState(false)
 const [point,setPoint]=useState<{x:number;y:number}|null>(null)
 useEffect(()=>{let live=true;void window.donwells.projectToolsList(workspacePath).then(services=>{if(live){setAvailable(services.some(service=>service.id==='computer-control'));if(!services.some(service=>service.id==='computer-control'))setOutput('Computer control needs Cua Driver. Set it up to inspect and interact with app windows.')}}).catch(error=>{if(live)setOutput(String(error))}).finally(()=>{if(live)setChecking(false)});return()=>{live=false;sequence.current++}},[workspacePath])
 useEffect(() => {
  let live = true
  if (available) void run('permissions').then(ok => { if (live && ok) void run('windows') })
  return () => { live = false }
 }, [available, workspacePath])
 const run=async(operation:string)=>{
  const request=++sequence.current;setBusy(true);setFailed(false)
  try{
   const target=windows.find(window=>String(window.window_id)===selected)
   if(operation==='attach'&&!target)throw new Error('Choose an app window first')
   const action=attachment?{owner:owner.current,generation:attachment.generation,revision:attachment.revision}:{}
   const args=operation==='attach'?{owner:owner.current,pid:target!.pid,window:target!.window_id,foreground}:operation==='click'?{...action,element}:operation==='type'?{...action,element,text:input}:operation==='hotkey'?{...action,element,keys:keys.split('+').map(value=>value.trim()).filter(Boolean)}:operation==='pixelClick'||operation==='pixelType'?{...action,...point,...(operation==='pixelType'?{text:input}:{})}:{}
   let result=operation==='stop'?await window.donwells.projectToolStop(workspacePath,'computer-control'):await window.donwells.projectToolCall(workspacePath,'computer-control',operation,args)
   if(request!==sequence.current)return
   setImage('');setPoint(null)
   if(operation==='stop'){setAttachment(null);setElements([]);setElement('');setOutput('Controller stopped and released. Select a window and attach again to resume control.');return}
   if(!isObject(result))throw new Error('Invalid computer-control response')
   if(result.isError)throw new Error(Array.isArray(result.content)?result.content.filter(isObject).map(part=>part.text??'').join('\n'):'Computer control failed')
   if(['click','type','hotkey','pixelClick','pixelType'].includes(operation)) {
    setElements([]);setElement('')
    try {
     result=await window.donwells.projectToolCall(workspacePath,'computer-control','observe',{})
     if(request!==sequence.current)return
     if(!isObject(result)||result.isError)throw new Error('The updated observation is unavailable')
    } catch(error) {
     if(request===sequence.current){setFailed(true);setOutput(`Action completed, but the window could not be refreshed. Inspect to continue. ${String(error)}`)}
     return false
    }
   }
   if(isObject(result.structuredContent)&&Array.isArray(result.structuredContent.windows)){const next=result.structuredContent.windows.filter(isObject);setWindows(next);setSelected(current=>next.some(value=>String(value.window_id)===current)?current:next.length===1?String(next[0]!.window_id):'');setOutput(`${result.structuredContent.windows.length} windows available. Choose the exact app and window above.`);return}
   if(isObject(result.structuredContent)&&isObject(result.structuredContent.attachment)){
    const value=result.structuredContent.attachment
    if(typeof value.app==='string'&&typeof value.title==='string'&&Number.isSafeInteger(value.pid)&&Number.isSafeInteger(value.window)&&Number.isSafeInteger(value.generation)&&Number.isSafeInteger(value.revision))setAttachment(value as Attachment)
   }
   if(isObject(result.structuredContent)&&Array.isArray(result.structuredContent.elements)){
    const next=result.structuredContent.elements.filter((value):value is Element=>isObject(value)&&typeof value.element_token==='string')
    setElements(next);setElement(current=>next.some(value=>value.element_token===current)?current:'')
   } else if(['click','type','hotkey','pixelClick','pixelType'].includes(operation)) { setElements([]);setElement('') }
   if(Array.isArray(result.content)){
    setOutput(result.content.filter(part=>isObject(part)&&part.type==='text').map(part=>part.text).join('\n\n').slice(0,256*1024))
    const shot=result.content.find(part=>isObject(part)&&part.type==='image'&&part.mimeType==='image/png')
    if(isObject(shot)&&typeof shot.data==='string')setImage(`data:image/png;base64,${shot.data}`)
   }
   return true
  }catch(error){if(request===sequence.current){setFailed(true);setElements([]);setElement('');setImage('');setPoint(null);setOutput(`${String(error)}\nStop and release the controller before selecting a replacement if the target closed or input outcome is uncertain.`)}return false}finally{if(request===sequence.current)setBusy(false)}
 }
 if(!available) return <section className="empty-note" aria-label="Computer control setup"><p role="status">{checking ? 'Checking computer control…' : output}</p><button className="btn btn-secondary" onClick={()=>useAppStore.getState().openSettings('project')}>Open project tool setup</button></section>
 return <section className="project-graph computer-control-panel" style={{padding:12,overflow:'auto'}} aria-label="Native computer control">
  {attachment ? <p role="status">{attachment.app} · {attachment.title}</p> : <>
   <label htmlFor={id}>App window</label><div style={{display:'flex',gap:6}}><select className="settings-select" style={{flex:1,minWidth:0}} id={id} value={selected} onChange={event=>setSelected(event.target.value)} disabled={busy}><option value="">Choose a window</option>{windows.map(window=><option key={`${String(window.pid)}:${String(window.window_id)}`} value={String(window.window_id)}>{String(window.app_name)} · {String(window.title)}</option>)}</select><button className="icon-btn" aria-label="Refresh windows" title="Refresh windows" disabled={busy} onClick={()=>void run('windows')}><Icon name="refresh"/></button></div>
   <label><input type="checkbox" checked={foreground} onChange={event=>setForeground(event.target.checked)} disabled={busy}/> Allow foreground input for this attachment</label>
  </>}
  <div style={{display:'flex',flexWrap:'wrap',gap:6}}>{Object.entries(attachment ? {observe:'Inspect',screenshot:'Screenshot'} : {attach:'Attach selected window'}).map(([operation,label])=><button className="btn btn-sm" key={operation} title={busy ? 'Wait for the current action or use Interrupt and release' : operation==='attach' ? selected ? 'Connect to the selected window using the chosen foreground permission' : 'Choose an app window first' : operation==='observe' ? 'Refresh the accessible elements of the attached window' : 'Capture the attached window for inspection'} disabled={busy||(operation==='attach'&&!selected)} onClick={()=>void run(operation)}>{label}</button>)}{(attachment||busy)&&<button className="btn btn-sm" title="Interrupt controller work and release the window attachment; this does not quit the app" onClick={()=>void run('stop')}>{busy?'Interrupt and release':'Stop and release'}</button>}</div>
  {attachment && <fieldset disabled={busy}><legend className="sr-only">Window action</legend><label>Accessible element<select className="settings-select" value={element} onChange={event=>setElement(event.target.value)}><option value="">Choose an observed element</option>{elements.map(value=><option key={value.element_token} value={value.element_token}>{value.role??'element'} · {value.label??value.element_token}</option>)}</select></label><label>Action<select className="settings-select" value={actionKind} onChange={event=>setActionKind(event.target.value)}><option value="click">Click</option><option value="type">Type text</option><option value="hotkey">Send keys</option></select></label>{actionKind==='type'&&<label>Text<input className="input" value={input} onChange={event=>setInput(event.target.value)} /></label>}{actionKind==='hotkey'&&<label>Key chord<input className="input" value={keys} onChange={event=>setKeys(event.target.value)} placeholder="Meta+Enter" /></label>}<button className="btn btn-sm" disabled={!element||(actionKind==='hotkey'&&!keys.trim())} onClick={()=>void run(actionKind)}>{actionKind==='click'?'Click':actionKind==='type'?'Type text':'Send keys'}</button></fieldset>}
  {failed&&<p role="alert" className="memory-error">{output}</p>}
  <details><summary title="Inspect controller status, permissions, and the last operation response">Controller diagnostics</summary>{attachment&&<p>PID {attachment.pid} · window {attachment.window} · generation {attachment.generation} · observation {attachment.revision} · {attachment.foregroundAllowed?'foreground allowed':'background preferred'}</p>}<button className="btn btn-secondary btn-sm" disabled={busy} onClick={()=>void run('permissions')}>Check permissions</button><button className="btn btn-secondary btn-sm" disabled={busy} onClick={()=>void run('status')}>Show controller</button><pre className="project-search-document" style={{fontSize:11,margin:0}}>{output}</pre></details>
  {image&&<><label>Text for selected point<input className="input" value={input} onChange={event=>setInput(event.target.value)} disabled={busy}/></label><p>Select a point in the screenshot, then choose an action. Input still follows this attachment’s foreground permission.</p><img src={image} alt={`Current attached window: ${attachment?.app??'selected app'} · ${attachment?.title??'window'}`} style={{maxWidth:'100%',height:'auto',cursor:'crosshair'}} onClick={event=>{const img=event.currentTarget,rect=img.getBoundingClientRect();setPoint({x:Math.floor((event.clientX-rect.left)*img.naturalWidth/rect.width),y:Math.floor((event.clientY-rect.top)*img.naturalHeight/rect.height)})}}/><details><summary>Adjust point coordinates</summary><label>Screenshot X<input className="input" type="number" min={0} value={point?.x??''} onChange={event=>setPoint({x:Number(event.target.value),y:point?.y??0})}/></label><label>Screenshot Y<input className="input" type="number" min={0} value={point?.y??''} onChange={event=>setPoint({x:point?.x??0,y:Number(event.target.value)})}/></label></details><button className="btn btn-sm" disabled={busy||!point} onClick={()=>void run('pixelClick')}>Click selected point</button><button className="btn btn-sm" disabled={busy||!point} onClick={()=>void run('pixelType')}>Type at selected point</button></>}
 </section>
}
