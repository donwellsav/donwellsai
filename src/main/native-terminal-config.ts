import type { AppSettings } from '@shared/types'
import { terminalThemeOf } from '../renderer/src/terminal-themes'

/** ANSI palette order; the index is the value Ghostty's `palette` key expects. */
const ANSI_COLORS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'
] as const

/**
 * Configuration is line-oriented, so no value may carry a line break. Settings
 * are validated on write, but a hand-edited profile reaches this builder too.
 */
const oneLine = (value: string): string => value.replace(/[\r\n\0]/g, ' ').replace(/\s+/g, ' ').trim()

/** Normalise a comma-separated OpenType list onto a single line. */
const openTypeList = (value: string): string =>
  oneLine(value).split(',').map((entry) => entry.trim()).filter(Boolean).join(', ')

/**
 * Keys this builder owns. The app's own Settings are authoritative for these,
 * so an equivalent line in the user's Ghostty configuration is dropped rather
 * than silently overriding the UI.
 */
const MANAGED_KEYS = new Set([
  'font-family', 'font-size', 'adjust-cell-height', 'font-feature', 'font-variation',
  'scrollback-limit-lines', 'copy-on-select', 'cursor-style', 'cursor-style-blink',
  'background', 'foreground', 'cursor-color', 'cursor-text', 'selection-background',
  'palette', 'clipboard-read', 'clipboard-write', 'window-padding-x', 'window-padding-y',
  // Themes set those same color keys, and the app has its own theme picker.
  'theme'
])

/** The key of a `key = value` configuration line, or undefined for anything else. */
function configKey(line: string): string | undefined {
  return /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1]?.toLowerCase()
}

/**
 * Fold the user's own Ghostty configuration into the generated one.
 *
 * Someone with an existing `~/.config/ghostty/config` expects it to work here -
 * keybinds, mouse behaviour, shell integration - so everything the app does not
 * manage is kept. Anything the app manages is dropped, so Settings stays the
 * single authority for it, and the generated values come last as a backstop.
 */
export function mergeGhosttyConfig(userConfig: string, generated: string): string {
  const kept = userConfig.split('\n').filter((line) => {
    const key = configKey(line)
    return key === undefined || !MANAGED_KEYS.has(key)
  })
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === '') kept.pop()
  return kept.length === 0 ? generated : `${kept.join('\n')}\n${generated}`
}

/**
 * Build the Ghostty configuration for a native surface from app settings.
 *
 * The font family is free-form, so quotes and control characters are stripped
 * and the result is JSON-encoded: a family containing a newline must never
 * become a second configuration line.
 */
export function nativeTerminalConfiguration(settings: AppSettings, palette?: Record<string, string>): string {
  const theme = palette ?? terminalThemeOf(settings.terminalTheme)
  const font = settings.terminalFontFamily.split(',')[0]!.trim().replace(/^['"]|['"]$/g, '').replace(/[\r\n\0]/g, '') || 'Menlo'
  // Ligatures and explicit features share one key, so they are merged rather
  // than emitted twice.
  const features = [settings.terminalLigatures ? '' : '-liga', openTypeList(settings.terminalFontFeatures)].filter(Boolean).join(', ')
  const variations = openTypeList(settings.terminalFontVariations)
  return [
    `font-family = ${JSON.stringify(font)}`, `font-size = ${settings.terminalFontSize}`,
    `adjust-cell-height = ${Math.round((settings.terminalLineHeight - 1) * 100)}%`,
    ...(features ? [`font-feature = ${features}`] : []),
    ...(variations ? [`font-variation = ${variations}`] : []),
    `scrollback-limit-lines = ${settings.scrollback}`,
    `copy-on-select = ${settings.copyOnSelect ? 'clipboard' : 'false'}`,
    `cursor-style = ${settings.cursorStyle}`, `cursor-style-blink = ${settings.cursorBlink}`,
    `background = ${theme['background']}`, `foreground = ${theme['foreground']}`,
    `cursor-color = ${theme['cursor']}`, `cursor-text = ${theme['cursorAccent']}`,
    `selection-background = ${theme['selectionBackground']}`,
    ...ANSI_COLORS.map((color, index) => `palette = ${index}=${theme[color]}`),
    'clipboard-read = deny', 'clipboard-write = ask', 'window-padding-x = 0', 'window-padding-y = 0'
  ].join('\n') + '\n'
}
