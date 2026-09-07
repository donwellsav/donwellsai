import { TerminalBus } from '@shared/terminal-stream'
export { TerminalBus } from '@shared/terminal-stream'
export type { TerminalSubscription } from '@shared/terminal-stream'

export const terminalBus = new TerminalBus()

/** Wire main-process events once at app start and return symmetric cleanup. */
export function initTerminalEvents(
  onExit: (sessionId: string, exitCode?: number) => void,
  onTitle: (sessionId: string, title: string) => void
): () => void {
  const disposeData = window.donwells.on('terminal:data', ({ sessionId, data, sequence }) => {
    terminalBus.emitData(sessionId, data, sequence)
  })
  const disposeDisconnected = window.donwells.on('terminal:disconnected', () => terminalBus.disconnect())
  const disposeExit = window.donwells.on('terminal:exit', ({ sessionId, exitCode }) => onExit(sessionId, exitCode))
  const disposeTitle = window.donwells.on('terminal:title', ({ sessionId, title }) => onTitle(sessionId, title))
  return () => {
    disposeData()
    disposeDisconnected()
    disposeExit()
    disposeTitle()
  }
}
