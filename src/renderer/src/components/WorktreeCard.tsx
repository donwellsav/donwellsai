import { useEffect, useRef, useState } from 'react'
import type { Worktree } from '@shared/types'
import { useAppStore } from '../store'
import { TerminalPane } from './TerminalPane'

export function WorktreeCard({ worktree }: { worktree: Worktree }) {
  const openTerminal = useAppStore((s) => s.openTerminal)
  const closeTerminal = useAppStore((s) => s.closeTerminal)
  const removeWorktree = useAppStore((s) => s.removeWorktree)
  const terminals = useAppStore((s) => s.terminals)
  const terminalOrder = useAppStore((s) => s.terminalOrder)
  const runInSession = useAppStore((s) => s.runInSession)
  const agents = useAppStore((s) => s.agents)

  const worktreeTerminals = terminalOrder
    .map((id) => terminals[id])
    .filter((t): t is NonNullable<typeof t> => !!t && t.session.worktreePath === worktree.path)

  const [activeId, setActiveId] = useState<string | null>(null)
  const [cmd, setCmd] = useState('')
  const firstActive = useRef(false)

  // Auto-focus the first terminal when a card mounts
  useEffect(() => {
    if (worktreeTerminals.length > 0 && !activeId && !firstActive.current) {
      firstActive.current = true
      setActiveId(worktreeTerminals[worktreeTerminals.length - 1]!.session.id)
    }
  }, [worktreeTerminals, activeId])

  const launch = async (command: string) => {
    const trimmed = command.trim()
    if (!trimmed) return
    const session = await openTerminal(worktree.path)
    if (!session) return
    setActiveId(session.id)
    runInSession(session.id, trimmed)
  }

  return (
    <div className="worktree-card">
      <div className="worktree-card-header">
        <span className="wt-name" title={worktree.path}>
          {worktree.path.split('/').filter(Boolean).pop()}
        </span>
        <span className="wt-branch" title={worktree.branch}>
          {worktree.isMain ? 'main' : worktree.branch}
        </span>
        <div className="wt-actions">
          <button className="btn" title="Open terminal" onClick={() => void openTerminal(worktree.path)}>
            ⌘_
          </button>
          {!worktree.isMain && (
            <button className="btn btn-danger" title="Delete worktree" onClick={() => void removeWorktree(worktree.path)}>
              del
            </button>
          )}
        </div>
      </div>

      {worktreeTerminals.length > 0 && (
        <div className="terminal-tabs">
          {worktreeTerminals.map((t) => (
            <div key={t.session.id} className={`tab ${t.session.id === activeId ? 'active' : ''}`} onClick={() => setActiveId(t.session.id)}>
              <span className="tab-title">{t.session.exited ? `${t.session.title} (exited)` : t.session.title}</span>
              <span
                className="tab-close"
                role="button"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTerminal(t.session.id)
                }}
              >
                ×
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="terminal-panes">
        {worktreeTerminals.map((t) => (
          <TerminalPane
            key={t.session.id}
            sessionId={t.session.id}
            cols={t.cols}
            rows={t.rows}
            isActive={t.session.id === activeId}
          />
        ))}
      </div>

      <div className="agent-launch">
        <label>Run</label>
        {agents.map((a) => (
          <button key={a.command} className="agent-chip" onClick={() => launch(a.command)}>
            {a.name}
          </button>
        ))}
        <input
          className="agent-cmd"
          placeholder={agents.length ? 'custom command…' : 'e.g. codex, claude, npm test'}
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              launch(cmd)
              setCmd('')
            }
          }}
        />
      </div>
    </div>
  )
}