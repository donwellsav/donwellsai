import { useEffect, useId, useRef, useState } from 'react'
import { isObject } from '@shared/command-catalog'

type Attachment = { app:string; title:string; pid:number; window:number; generation:number; revision:number; foregroundAllowed:boolean }
type Element = { element_token:string; label?:string; role?:string }

export function ComputerControlPanel({workspacePath}:{workspacePath:string}) {
 const id=useId(),owner=useRef(crypto.randomUUID()),sequence=useRef(0)
 const [available,setAvailable]=useState(false),[busy,setBusy]=useState(false),[output,setOutput]=useState('Check permissions before selecting an app window.'),[windows,setWindows]=useState<Record<string,unknown>[]>([]),[selected,setSelected]=useState(''),[foreground,setForeground]=useState(false),[image,setImage]=useState('')
 const [attachment,setAttachment]=useState<Attachment|null>(null),[elements,setElements]=useState<Element[]>([]),[element,setElement]=useState(''),[input,setInput]=useState(''),[keys,setKeys]=useState('Enter')
 const [point,setPoint]=useState<{x:number;y:number}|null>(null)
 useEffect(()=>{let live=true;void window.donwells.projectToolsList(workspacePath).then(services=>{if(live){setAvailable(services.some(service=>service.id==='computer-control'));if(!services.some(service=>service.id==='computer-control'))setOutput('Computer control is unavailable. Configure the admitted external Cua Driver in tool setup.')}}).catch(error=>{if(live)setOutput(String(error))});return()=>{live=false;sequence.current++}},[workspacePath])
 const run=async(operation:string)=>{
  const request=++sequence.current;setBusy(true)
  try{
   const target=windows.find(window=>String(window.window_id)===selected)
   if(operation==='attach'&&!target)throw new Error('Choose an app window first')
   const action=attachment?{owner:owner.current,generation:attachment.generation,revision:attachment.revision,element}:{}
   const args=operation==='attach'?{owner:owner.current,pid:target!.pid,window:target!.window_id,foreground}:operation==='click'?action:operation==='type'?{...action,text:input}:operation==='hotkey'?{...action,keys:keys.split('+').map(value=>value.trim()).filter(Boolean)}:operation==='pixelClick'||operation==='pixelType'?{...action,...point,...(operation==='pixelType'?{text:input}:{})}:{}
   const result=operation==='stop'?await window.donwells.projectToolStop(workspacePath,'computer-control'):await window.donwells.projectToolCall(workspacePath,'computer-control',operation,args)
   if(request!==sequence.current)return
   setImage('');setPoint(null)
   if(operation==='stop'){setAttachment(null);setElements([]);setElement('');setOutput('Controller stopped and released. Select a window and attach again to resume control.');return}
   if(!isObject(result))throw new Error('Invalid computer-control response')
   if(isObject(result.structuredContent)&&Array.isArray(result.structuredContent.windows)){setWindows(result.structuredContent.windows.filter(isObject));setOutput(`${result.structuredContent.windows.length} windows available. Choose the exact app and window above.`);return}
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
  }catch(error){if(request===sequence.current){setElements([]);setElement('');setImage('');setPoint(null);setOutput(`${String(error)}\nStop and release the controller before selecting a replacement if the target closed or input outcome is uncertain.`)}}finally{if(request===sequence.current)setBusy(false)}
 }
 return <section className="project-graph" style={{padding:12,overflow:'auto'}} aria-label="Native computer control">
  <p>Control one selected app window. Background delivery is preferred. Release stops the owned controller before another can take over.</p>
  {attachment&&<p role="status">Attached to {attachment.app} · {attachment.title} · PID {attachment.pid} / window {attachment.window} · generation {attachment.generation} · observation {attachment.revision} · {attachment.foregroundAllowed?'foreground allowed':'background preferred'}</p>}
  <div style={{display:'flex',flexWrap:'wrap',gap:6}}><button className="btn btn-sm" disabled={!available||busy} onClick={()=>void run('permissions')}>Check permissions</button><button className="btn btn-sm" disabled={!available||busy} onClick={()=>void run('windows')}>List app windows</button></div>
  <label htmlFor={id}>App window</label><select className="settings-select" style={{width:'100%',maxWidth:'100%'}} id={id} value={selected} onChange={event=>setSelected(event.target.value)} disabled={busy||!!attachment}><option value="">Choose a window</option>{windows.map(window=><option key={`${String(window.pid)}:${String(window.window_id)}`} value={String(window.window_id)}>{String(window.app_name)} · {String(window.title)} · PID {String(window.pid)} / {String(window.window_id)}</option>)}</select>
  <label><input type="checkbox" checked={foreground} onChange={event=>setForeground(event.target.checked)} disabled={busy||!!attachment}/> Allow foreground input for this attachment</label>
  <div style={{display:'flex',flexWrap:'wrap',gap:6}}>{Object.entries({attach:'Attach selected window',status:'Show controller',observe:'Inspect',screenshot:'Screenshot'}).map(([operation,label])=><button className="btn btn-sm" key={operation} disabled={!available||busy||(operation==='attach'&&(!selected||!!attachment))||(['observe','screenshot'].includes(operation)&&!attachment)} onClick={()=>void run(operation)}>{label}</button>)}<button className="btn btn-sm" disabled={!available} onClick={()=>void run('stop')}>{busy?'Interrupt and release':'Stop and release'}</button></div>
  <fieldset disabled={!attachment||busy}><legend>Act on the latest observation</legend><label>Accessible element<select className="settings-select" value={element} onChange={event=>setElement(event.target.value)}><option value="">Choose an observed element</option>{elements.map(value=><option key={value.element_token} value={value.element_token}>{value.role??'element'} · {value.label??value.element_token}</option>)}</select></label><label>Text<input className="input" value={input} onChange={event=>setInput(event.target.value)} /></label><label>Key chord<input className="input" value={keys} onChange={event=>setKeys(event.target.value)} placeholder="Meta+Enter" /></label><button className="btn btn-sm" disabled={!element} onClick={()=>void run('click')}>Click</button><button className="btn btn-sm" disabled={!element} onClick={()=>void run('type')}>Type</button><button className="btn btn-sm" disabled={!element||!keys.trim()} onClick={()=>void run('hotkey')}>Send keys</button><small>Every input consumes this observation. Inspect again before another action.</small></fieldset>
  <pre className="project-search-document" style={{fontSize:11,margin:0}} aria-live="polite">{output}</pre>
  {image&&<><p>Select a point in the screenshot, then choose an action. Input still follows this attachment’s foreground permission.</p><img src={image} alt={`Current attached window: ${attachment?.app??'selected app'} · ${attachment?.title??'window'}`} style={{maxWidth:'100%',height:'auto',cursor:'crosshair'}} onClick={event=>{const img=event.currentTarget,rect=img.getBoundingClientRect();setPoint({x:Math.floor((event.clientX-rect.left)*img.naturalWidth/rect.width),y:Math.floor((event.clientY-rect.top)*img.naturalHeight/rect.height)})}}/><label>Screenshot X<input className="input" type="number" min={0} value={point?.x??''} onChange={event=>setPoint({x:Number(event.target.value),y:point?.y??0})}/></label><label>Screenshot Y<input className="input" type="number" min={0} value={point?.y??''} onChange={event=>setPoint({x:point?.x??0,y:Number(event.target.value)})}/></label><button className="btn btn-sm" disabled={busy||!point} onClick={()=>void run('pixelClick')}>Click selected point</button><button className="btn btn-sm" disabled={busy||!point} onClick={()=>void run('pixelType')}>Type at selected point</button></>}
 </section>
}
