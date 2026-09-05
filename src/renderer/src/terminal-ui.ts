export const TERMINAL_FIND_EVENT = 'donwells:terminal-find'

export type TerminalFindEvent = CustomEvent<{ sessionId: string }>

export function requestTerminalFind(sessionId: string): void {
  window.dispatchEvent(new CustomEvent(TERMINAL_FIND_EVENT, { detail: { sessionId } }))
}
