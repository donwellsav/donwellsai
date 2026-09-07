import { useEffect, useRef, useState } from 'react'
import type { NativeTerminalRequest } from '@shared/native-terminal'
import { useAppStore } from '../store'
import { TERMINAL_FIND_EVENT, type TerminalFindEvent } from '../terminal-ui'
import { acknowledgeVisibleAttention, useAttentionInboxState } from '../attention-inbox'

export function NativeTerminalPane({ sessionId, isActive }: { sessionId: string; isActive: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const instance = useRef(crypto.randomUUID())
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [message, setMessage] = useState('')
  const [connecting, setConnecting] = useState(false)
  const runsOpen = useAppStore(state => state.runsOpen)
  const inbox = useAttentionInboxState()
  const nativeFocused = useRef(false)
  const active = useRef(isActive); active.current = isActive
  const call = (request: Omit<NativeTerminalRequest, 'sessionId' | 'instance'>) => window.donwells.nativeTerminal({ ...request, sessionId, instance: instance.current } as NativeTerminalRequest)
  const reconnect = async () => {
    setConnecting(true)
    try { const result = await call({ op: 'reattach' }); setTruncated(result.truncated === true); setError(null) }
    catch (cause) { setError(String(cause)) }
    finally { setConnecting(false) }
  }
  useEffect(() => {
    let alive = true
    const acknowledge = (allowCapture: boolean) => {
      if (host.current && nativeFocused.current) void acknowledgeVisibleAttention({ sessionId, isActive: active.current, runsOverlayOpen: useAppStore.getState().runsOpen, host: host.current, allowCapture, nativeFocused: true })
    }
    const dispose = window.donwells.onNativeTerminal(event => {
      if (event.sessionId !== sessionId || event.instance !== instance.current || !alive) return
      if (event.error) setError(event.error)
      if (event.focused !== undefined) {
        nativeFocused.current = event.focused
        if (event.focused) {
          const state = useAppStore.getState(), path = state.terminals[sessionId]?.session.worktreePath
          if (path) state.setActivePane(path, `term:${sessionId}`)
          acknowledge(true)
        }
      }
    })
    void call({ op: 'create' }).then(result => {
      if (alive) { setReady(true); setTruncated(result.truncated === true) }
    }).catch(cause => { if (alive) setError(String(cause)) })
    const find = (event: Event) => {
      if ((event as TerminalFindEvent).detail.sessionId === sessionId) void call({ op: 'find' }).catch(cause => setError(String(cause)))
    }
    window.addEventListener(TERMINAL_FIND_EVENT, find)
    return () => { alive = false; dispose(); window.removeEventListener(TERMINAL_FIND_EVENT, find); void call({ op: 'dispose' }).catch(() => {}) }
  }, [sessionId])

  useEffect(() => {
    if (!ready) return
    let frame = 0, last = ''
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure) }
    const measure = () => {
      const node = host.current
      if (!node) return
      const r = node.getBoundingClientRect()
      const overlays = [...document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"], [role="menu"], .palette-backdrop, .browser-suggestions, .design-capture-panel, .flexlayout__outline_rect, .flexlayout__drag_rect')]
      const blocked = overlays.some(item => { const b = item.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.right > r.left && b.left < r.right && b.bottom > r.top && b.top < r.bottom && getComputedStyle(item).visibility !== 'hidden' })
      const visible = isActive && !error && !truncated && !runsOpen && !inbox.overlayOpen && !blocked && document.visibilityState === 'visible' && node.getClientRects().length > 0 && r.width > 0 && r.height > 0
      const rect = visible ? { x: Math.max(0,r.left), y: Math.max(0,r.top), width: Math.max(0,Math.min(r.right,innerWidth)-Math.max(0,r.left)), height: Math.max(0,Math.min(r.bottom,innerHeight)-Math.max(0,r.top)) } : null
      const serialized = JSON.stringify(rect)
      if (serialized !== last) {
        last = serialized
        if (!rect) nativeFocused.current = false
        void window.donwells.nativeTerminal({ op: 'bounds', sessionId, instance: instance.current, rect }).catch(cause => setError(String(cause)))
      }
    }
    const resize = new ResizeObserver(schedule); if (host.current) resize.observe(host.current)
    const mutation = new MutationObserver(schedule)
    mutation.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style','class','open','aria-hidden'] })
    window.addEventListener('resize',schedule); window.addEventListener('scroll',schedule,true); document.addEventListener('visibilitychange',schedule)
    schedule()
    return () => { resize.disconnect(); mutation.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('resize',schedule); window.removeEventListener('scroll',schedule,true); document.removeEventListener('visibilitychange',schedule) }
  }, [ready,isActive,error,truncated,runsOpen,inbox.overlayOpen,sessionId])

  useEffect(() => {
    if (ready && isActive && inbox.reveals[sessionId] && !runsOpen && !inbox.overlayOpen && !error && !truncated) void call({ op: 'focus' }).catch(cause => setError(String(cause)))
  }, [ready,isActive,inbox.reveals[sessionId],runsOpen,inbox.overlayOpen,error,truncated])

  return <div className={'terminal-host-wrap ' + (isActive ? '' : 'terminal-hidden')}>
    {error && <div className="terminal-replay-warning" role="alert"><strong>Native terminal unavailable</strong><p>{error}</p>
      {ready && <button className="btn btn-secondary btn-sm" disabled={connecting} onClick={() => void reconnect()}>{connecting ? 'Reattaching…' : 'Reattach terminal'}</button>}
      <button className="btn btn-secondary btn-sm" onClick={() => useAppStore.getState().openSettings('terminal')}>Terminal settings</button>
    </div>}
    {!error && truncated && <div className="terminal-replay-warning" role="alert"><strong>Terminal history is incomplete</strong><p>{message || 'Retained output was shortened. Request a redraw from the same running process.'}</p>
      <button className="btn btn-secondary btn-sm" onClick={() => void call({ op: 'redraw' }).then(() => setMessage('Redraw requested. Check the screen before continuing.')).catch(cause => setMessage(String(cause)))}>Request redraw</button>
      <button className="btn btn-secondary btn-sm" onClick={() => setTruncated(false)}>Dismiss notice</button>
    </div>}
    <div className="terminal-host native-terminal-host" data-native-instance={instance.current} ref={host} tabIndex={0} aria-label="Native terminal" onFocus={() => { if (ready) void call({ op: 'focus' }).catch(cause => setError(String(cause))) }} />
  </div>
}
