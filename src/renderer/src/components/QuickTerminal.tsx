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
