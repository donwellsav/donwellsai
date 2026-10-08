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
 * Build the Ghostty configuration for a native surface from app settings.
 *
 * The font family is free-form, so quotes and control characters are stripped
 * and the result is JSON-encoded: a family containing a newline must never
 * become a second configuration line.
 */
export function nativeTerminalConfiguration(settings: AppSettings): string {
  const theme = terminalThemeOf(settings.terminalTheme)
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
