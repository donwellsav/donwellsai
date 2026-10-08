// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { resolveTerminalRenderer } from './terminal-renderer'

describe('terminal renderer resolution', () => {
  it('uses Ghostty by default when the native module loaded', () => {
    expect(resolveTerminalRenderer({ requested: 'ghostty', nativeAvailable: true })).toEqual({ renderer: 'ghostty', fellBack: false })
  })

  it('falls back to xterm when the native module is unavailable', () => {
    expect(resolveTerminalRenderer({ requested: 'ghostty', nativeAvailable: false, nativeReason: 'Native Ghostty is available only on macOS.' }))
      .toEqual({ renderer: 'xterm', fellBack: true, reason: 'Native Ghostty is available only on macOS.' })
  })

  it('explains an unexplained fallback rather than rendering a dead pane', () => {
    const resolved = resolveTerminalRenderer({ requested: 'ghostty', nativeAvailable: false })
    expect(resolved.renderer).toBe('xterm')
    expect(resolved.fellBack).toBe(true)
    expect(resolved.reason).toBe('The native Ghostty module is unavailable.')
  })

  it('honours an explicit xterm request even when Ghostty is available', () => {
    expect(resolveTerminalRenderer({ requested: 'xterm', nativeAvailable: true })).toEqual({ renderer: 'xterm', fellBack: false })
  })
})
