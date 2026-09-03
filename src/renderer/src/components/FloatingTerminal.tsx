import { useAppStore } from '../store'
import { TerminalPane } from './TerminalPane'
import { Icon } from './Icon'

/**
 * Floating bottom-right terminal panel (Orca FloatingTerminalPanel parity):
 * a global session outside the worktree pane tree, spawned in the active
 * worktree, surviving hide/show via daemon-side scrollback replay.
 */
export function FloatingTerminal() {
  const open = useAppStore((s) => s.floatingOpen)
  const sessionId = useAppStore((s) => s.floatingSessionId)
  const terminals = useAppStore((s) => s.terminals)
  const size = useAppStore((s) => s.floatingSize)
  const setFloatingSize = useAppStore((s) => s.setFloatingSize)

  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const { w, h } = size
    const move = (ev: MouseEvent): void => setFloatingSize(w - (ev.clientX - startX), h - (ev.clientY - startY))
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  if (!open || !sessionId || !terminals[sessionId]) return null

  return (
    <div className="floating-terminal" data-floating-terminal-no-drag style={{ width: size.w, height: size.h }}>
      <div className="floating-terminal-resize" onMouseDown={startResize} />
      <div className="floating-terminal-head">
        <Icon name="terminal" size={11} />
        <span className="floating-terminal-title">floating</span>
        <button
          className="floating-terminal-close"
          title="Hide (⌘J)"
          onClick={() => void useAppStore.getState().toggleFloatingTerminal()}
        >
          <Icon name="x" size={10} />
        </button>
      </div>
      <TerminalPane sessionId={sessionId} cols={80} rows={24} isActive />
    </div>
  )
}
