/**
 * Terminal surface selection.
 *
 * Ghostty is the default terminal, but a pane must always render something
 * usable: when the native module cannot load, the pane falls back to xterm
 * instead of showing a dead surface. The main process owns the platform rule
 * (see `nativeTerminalsAvailability`), so this stays a pure decision.
 */

export type TerminalRenderer = 'ghostty' | 'xterm'

export type RendererResolution = {
  renderer: TerminalRenderer
  /** True when the requested renderer was not used. */
  fellBack: boolean
  /** User-facing explanation, present only when `fellBack` is true. */
  reason?: string
}

export function resolveTerminalRenderer(input: {
  requested: TerminalRenderer
  nativeAvailable: boolean
  nativeReason?: string
}): RendererResolution {
  if (input.requested === 'xterm') return { renderer: 'xterm', fellBack: false }
  if (input.nativeAvailable) return { renderer: 'ghostty', fellBack: false }
  return {
    renderer: 'xterm',
    fellBack: true,
    reason: input.nativeReason ?? 'The native Ghostty module is unavailable.'
  }
}
