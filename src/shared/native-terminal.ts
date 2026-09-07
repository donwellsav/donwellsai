export type NativeTerminalRequest = { sessionId: string; instance: string } & (
  | { op: 'create' | 'reattach' | 'dispose' | 'focus' | 'find' | 'redraw' }
  | { op: 'bounds'; rect: { x: number; y: number; width: number; height: number } | null }
)
export type NativeTerminalResult = { connected?: boolean; truncated?: boolean }
export type NativeTerminalEvent = { sessionId: string; instance: string; error?: string; focused?: boolean }
