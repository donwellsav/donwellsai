import type { HerdrTerminalSource } from './herdr-session'

export type NativeTerminalRequest = { sessionId: string; instance: string } & (
  | { op: 'create' | 'reattach' | 'dispose' | 'focus' | 'find' | 'redraw' }
  | { op: 'bounds'; rect: { x: number; y: number; width: number; height: number } | null }
) & { source?: HerdrTerminalSource }
export type NativeTerminalResult = { connected?: boolean; truncated?: boolean }

/**
 * Whether the native Ghostty surface can render on this machine. `reason` is
 * user-facing: it explains a fall back to xterm in Settings.
 */
export type NativeTerminalAvailability = { available: boolean; reason?: string }
export type NativeTerminalEvent = { sessionId: string; instance: string; error?: string; focused?: boolean }
