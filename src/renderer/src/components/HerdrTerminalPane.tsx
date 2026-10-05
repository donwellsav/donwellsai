import { useState } from 'react'
import { appCommandPlatform } from '@shared/app-commands'
import type { HerdrTerminalSource } from '@shared/herdr-session'
import { NativeTerminalPane } from './NativeTerminalPane'

export function HerdrTerminalPane({ paneId, label, isActive }: { paneId: string; label?: string; isActive: boolean }) {
  const [mode, setMode] = useState<'observe' | 'control'>('observe')
  const [takeover, setTakeover] = useState(false)
  if (appCommandPlatform(navigator.platform || navigator.userAgent) !== 'mac') {
    return <div className="empty-note" role="status"><strong>Live sessions use Ghostty in Don</strong><p>The native Ghostty terminal surface is available on macOS.</p></div>
  }
  const source: HerdrTerminalSource = { kind: 'herdr', paneId, mode, ...(takeover ? { takeover: true } : {}) }
  return <div className="herdr-terminal-view">
    <div className="herdr-terminal-toolbar">
      <div className="herdr-terminal-copy"><strong>{label || 'Live session'}</strong><small><span className="herdr-mode" data-mode={mode}>{mode === 'observe' ? 'Read only' : takeover ? 'Takeover requested' : 'Control requested'}</span> · {mode === 'observe' ? 'Live screen; full scrollback stays with the original session' : 'The original session keeps running'}</small></div>
      {mode === 'observe' ? <button type="button" className="btn btn-primary btn-sm herdr-action" onClick={() => { setTakeover(false); setMode('control') }}>Take control</button> : <div className="herdr-terminal-actions">
        {!takeover && <button type="button" className="btn btn-secondary btn-sm herdr-action" onClick={() => setTakeover(true)}>Take over session</button>}
        <button type="button" className="btn btn-secondary btn-sm herdr-action" onClick={() => { setTakeover(false); setMode('observe') }}>Read only</button>
      </div>}
    </div>
    <div className="herdr-terminal-surface"><NativeTerminalPane key={`${mode}:${takeover}`} sessionId={`herdr:${paneId}`} isActive={isActive} source={source} /></div>
  </div>
}
