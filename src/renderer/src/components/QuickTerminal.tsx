import { useEffect } from 'react'
import { useAppStore } from '../store'
import { ModalDialog } from './ModalDialog'
import { TerminalPane } from './TerminalPane'

/**
 * A terminal you can summon over whatever you are doing, without disturbing the
 * workspace: its session is registered for rendering but never becomes a pane,
 * and it is disposed when the overlay closes. Ghostty calls this the quick
 * terminal; here it is an in-window overlay because the app has a single window
 * and registers no global shortcut.
 */
export function QuickTerminal() {
  // Quitting with the overlay open used to orphan its daemon session. It has no
  // pane and is not persisted, so nothing could list or close it - and because
  // the daemon refuses to exit while it owns sessions, the orphan later blocked
  // removing that worktree with no visible terminal to close. Disposing it as
  // the window goes away is the teardown half of that; the alternative would be
  // to persist and restore the overlay, which is a product decision.
  useEffect(() => {
    const dispose = (): void => {
      const session = useAppStore.getState().quickTerminalSessionId
      if (session) void window.donwells.closeTerminal(session).catch(() => undefined)
    }
    window.addEventListener('pagehide', dispose)
    return () => window.removeEventListener('pagehide', dispose)
  }, [])
  const sessionId = useAppStore((s) => s.quickTerminalSessionId)
  const terminal = useAppStore((s) => (sessionId ? s.terminals[sessionId] : undefined))
  if (!sessionId || !terminal) return null
  return (
    <ModalDialog
      labelledBy="quick-terminal-title"
      className="modal quick-terminal-modal"
      onClose={() => void useAppStore.getState().closeQuickTerminal()}
    >
      <h2 id="quick-terminal-title" className="modal-title">Quick terminal</h2>
      <div className="quick-terminal-surface">
        <TerminalPane sessionId={sessionId} cols={terminal.cols} rows={terminal.rows} isActive />
      </div>
    </ModalDialog>
  )
}
