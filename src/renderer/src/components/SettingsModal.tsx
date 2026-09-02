import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'

export function SettingsModal({ open }: { open: boolean }) {
  const setOpen = useAppStore((s) => s.setSettingsOpen)
  const settings = useAppStore((s) => s.settings)
  const setSettings = useAppStore((s) => s.setSettings)
  const agents = useAppStore((s) => s.agents)
  const [agentCommand, setAgentCommand] = useState(settings.agentCommand)
  const [fontSize, setFontSize] = useState(settings.fontSize)
  const first = useRef(true)

  useEffect(() => {
    if (open && first.current) {
      setAgentCommand(settings.agentCommand)
      setFontSize(settings.fontSize)
      first.current = false
    }
    if (open) {
      setAgentCommand(settings.agentCommand)
      setFontSize(settings.fontSize)
    }
  }, [open, settings])

  if (!open) return null

  const save = async (): Promise<void> => {
    await setSettings({ agentCommand: agentCommand.trim() || 'codex', fontSize: Math.max(9, Math.min(24, Number(fontSize) || 13)) })
    setOpen(false)
  }

  return (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={() => setOpen(false)}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <label className="field">
            <span>Default agent command</span>
            <input value={agentCommand} onChange={(e) => setAgentCommand(e.target.value)} placeholder="codex, claude, pi, opencode…" />
          </label>
          <div className="agent-chips">
            {agents.map((a) => (
              <button key={a.name} className="chip" onClick={() => setAgentCommand(a.command)}>
                {a.name}
              </button>
            ))}
          </div>
          <label className="field">
            <span>Terminal font size ({fontSize}px)</span>
            <input type="number" min={9} max={24} value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} />
          </label>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}