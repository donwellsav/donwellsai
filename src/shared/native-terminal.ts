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

/**
 * One of Ghostty's own themes, as compiled into the vendored wrapper (486 of
 * them, sourced from iTerm2-Color-Schemes). Colors are bare `RRGGBB`.
 */
export type GhosttyTheme = {
  name: string
  background: string
  foreground: string
  cursor?: string
  cursorText?: string
  selectionBackground?: string
  selectionForeground?: string
  /** ANSI index (`"0"`–`"15"`) to color. */
  palette: Record<string, string>
}
export type NativeTerminalEvent = { sessionId: string; instance: string; error?: string; focused?: boolean }
