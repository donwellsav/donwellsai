import { validateAppShortcutOverrides } from './app-commands'
import type { AppSettings, SettingKey, SettingsResetRequest, SettingsSection } from './types'

export const SETTINGS_SCHEMA_VERSION = 2 as const

export type SettingLifecycle = 'live' | 'new-terminal' | 'new-session' | 'restart'
export type SettingScope = 'global'
export type SettingOption = { value: string | number | null; label: string }
export type SettingControl =
  | { type: 'toggle' }
  | { type: 'text'; maxLength: number; placeholder?: string; nullable?: boolean }
  | { type: 'number'; min: number; max: number; step: number; nullable?: boolean }
  | { type: 'select'; options: readonly SettingOption[] }
  | { type: 'shortcut-map' }

export type SettingMetadata<K extends SettingKey = SettingKey> = {
  key: K
  section: SettingsSection
  label: string
  description: string
  default: AppSettings[K]
  lifecycle: SettingLifecycle
  scope: SettingScope
  control: SettingControl
}

type SettingDefinition<K extends SettingKey> = SettingMetadata<K> & {
  validate(value: unknown): value is AppSettings[K]
}

type SettingDefinitions = { [K in SettingKey]: SettingDefinition<K> }

const terminalThemes = ['donwells', 'tomorrow-night', 'dracula', 'solarized-dark', 'github-dark'] as const
const themeOptions = ['system', 'dark', 'light'] as const
const cursorStyles = ['block', 'bar', 'underline'] as const
const editorWhitespaceModes = ['none', 'boundary', 'selection', 'trailing', 'all'] as const
const autoSaveModes = ['after-delay', 'manual'] as const
const diffViewStyles = ['split', 'unified'] as const
const browserSearchEngines = ['duckduckgo', 'google', 'bing'] as const
const imageFitModes = ['contain', 'width', 'actual'] as const
const pdfFitModes = ['page', 'width', 'actual'] as const
const statusPollIntervals = [0, 2000, 5000, 10000] as const

export const DEFAULT_SETTINGS: Readonly<AppSettings> = Object.freeze({
  agentCommand: 'codex',
  theme: 'system',
  uiScale: 1,
  terminalRenderer: 'xterm',
  terminalFontFamily: '',
  terminalFontSize: 13,
  terminalFontWeight: 400,
  terminalLineHeight: 1,
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 10000,
  copyOnSelect: false,
  terminalTheme: 'donwells',
  editorFontFamily: null,
  editorFontSize: null,
  editorWordWrap: 'off',
  editorMinimap: false,
  editorTabSize: 4,
  editorStickyScroll: true,
  editorRenderWhitespace: 'selection',
  editorAutoSaveMode: 'after-delay',
  editorAutoSaveDelayMs: 400,
  markdownPreviewDefault: false,
  diffViewStyle: 'split',
  diffWordWrap: false,
  diffFontFamily: null,
  diffFontSize: null,
  browserHomeUrl: 'http://localhost:3000',
  browserSearchEngine: 'duckduckgo',
  imageViewerFit: 'contain',
  pdfViewerFit: 'page',
  notificationActivityIndicator: true,
  notificationFlashWindow: true,
  keyboardShortcutOverrides: Object.freeze({}),
  statusPollMs: 5000
})

function oneOf<const T extends readonly unknown[]>(options: T): (value: unknown) => value is T[number] {
  return (value: unknown): value is T[number] => options.includes(value)
}

function boundedNumber(value: unknown, min: number, max: number, integer = false): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= min
    && value <= max
    && (!integer || Number.isInteger(value))
}

function nullableBoundedNumber(value: unknown, min: number, max: number): value is number | null {
  return value === null || boundedNumber(value, min, max)
}

function isFontFamily(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 512
    && !/[\0\r\n]/.test(value)
}

function isNullableFontFamily(value: unknown): value is string | null {
  return value === null || isFontFamily(value)
}

function isAgentCommand(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= 4096
    && !/[\0\r\n]/.test(value)
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false
  try {
    const parsed = new URL(value)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.hostname.length > 0
      && parsed.username.length === 0
      && parsed.password.length === 0
  } catch {
    return false
  }
}

function isShortcutOverrides(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const entries = Object.entries(value)
  if (entries.length > 256) return false
  const overrides: Record<string, string> = {}
  for (const [command, chord] of entries) {
    if (command.length > 128 || typeof chord !== 'string' || chord.length === 0 || chord.length > 128 || /[\0-\x1f\x7f]/.test(chord)) return false
    overrides[command] = chord
  }
  return validateAppShortcutOverrides(overrides).length === 0
}

const booleanValue = (value: unknown): value is boolean => typeof value === 'boolean'
const stringOptions = (values: readonly string[]): readonly SettingOption[] => values.map((value) => ({ value, label: value }))

export const SETTING_DEFINITIONS: SettingDefinitions = {
  agentCommand: {
    key: 'agentCommand', section: 'agents', label: 'Default agent command',
    description: 'Command used when starting an agent in a new session.',
    default: DEFAULT_SETTINGS.agentCommand, lifecycle: 'new-session', scope: 'global',
    control: { type: 'text', maxLength: 4096, placeholder: 'codex' }, validate: isAgentCommand
  },
  theme: {
    key: 'theme', section: 'appearance', label: 'Theme',
    description: 'Follow the operating system or use a fixed light or dark appearance.',
    default: DEFAULT_SETTINGS.theme, lifecycle: 'live', scope: 'global',
    control: { type: 'select', options: stringOptions(themeOptions) }, validate: oneOf(themeOptions)
  },
  uiScale: {
    key: 'uiScale', section: 'appearance', label: 'Interface scale',
    description: 'Scale application chrome without changing terminal or editor text.',
    default: DEFAULT_SETTINGS.uiScale, lifecycle: 'live', scope: 'global',
    control: { type: 'number', min: 0.75, max: 2, step: 0.05 }, validate: (value): value is number => boundedNumber(value, 0.75, 2)
  },
  terminalFontFamily: {
    key: 'terminalFontFamily', section: 'terminal', label: 'Font family',
    description: 'CSS font-family used by terminals; blank uses the default monospace stack.',
    default: DEFAULT_SETTINGS.terminalFontFamily, lifecycle: 'live', scope: 'global',
    control: { type: 'text', maxLength: 512, placeholder: 'Default monospace' }, validate: isFontFamily
  },
  terminalFontSize: {
    key: 'terminalFontSize', section: 'terminal', label: 'Font size',
    description: 'Terminal text size in pixels.',
    default: DEFAULT_SETTINGS.terminalFontSize, lifecycle: 'live', scope: 'global',
    control: { type: 'number', min: 9, max: 24, step: 1 }, validate: (value): value is number => boundedNumber(value, 9, 24, true)
  },
  terminalFontWeight: {
    key: 'terminalFontWeight', section: 'terminal', label: 'Font weight',
    description: 'Weight used for normal terminal text.',
    default: DEFAULT_SETTINGS.terminalFontWeight, lifecycle: 'live', scope: 'global',
    control: { type: 'select', options: [400, 500, 600, 700].map((value) => ({ value, label: String(value) })) },
    validate: oneOf([400, 500, 600, 700] as const)
  },
  terminalLineHeight: {
    key: 'terminalLineHeight', section: 'terminal', label: 'Line height',
    description: 'Spacing multiplier between terminal rows.',
    default: DEFAULT_SETTINGS.terminalLineHeight, lifecycle: 'live', scope: 'global',
    control: { type: 'number', min: 1, max: 2, step: 0.05 }, validate: (value): value is number => boundedNumber(value, 1, 2)
  },
  cursorStyle: {
    key: 'cursorStyle', section: 'terminal', label: 'Cursor style',
    description: 'Shape of the terminal cursor.',
    default: DEFAULT_SETTINGS.cursorStyle, lifecycle: 'live', scope: 'global',
    control: { type: 'select', options: stringOptions(cursorStyles) }, validate: oneOf(cursorStyles)
  },
  cursorBlink: {
    key: 'cursorBlink', section: 'terminal', label: 'Blink cursor',
    description: 'Animate the terminal cursor while focused.',
    default: DEFAULT_SETTINGS.cursorBlink, lifecycle: 'live', scope: 'global',
    control: { type: 'toggle' }, validate: booleanValue
  },
  scrollback: {
    key: 'scrollback', section: 'terminal', label: 'Scrollback',
    description: 'Maximum retained lines for newly created terminals.',
    default: DEFAULT_SETTINGS.scrollback, lifecycle: 'new-terminal', scope: 'global',
    control: { type: 'select', options: [1000, 5000, 10000, 50000].map((value) => ({ value, label: value.toLocaleString() })) },
    validate: (value): value is number => boundedNumber(value, 1000, 50000, true)
  },
  copyOnSelect: {
    key: 'copyOnSelect', section: 'terminal', label: 'Copy on select',
    description: 'Copy terminal selections to the clipboard immediately.',
    default: DEFAULT_SETTINGS.copyOnSelect, lifecycle: 'live', scope: 'global',
    control: { type: 'toggle' }, validate: booleanValue
  },
  terminalRenderer: {
    key: 'terminalRenderer', section: 'terminal', label: 'Terminal renderer',
    description: 'Native Ghostty uses Metal on macOS. Switching reconnects views to the same running processes.',
    default: DEFAULT_SETTINGS.terminalRenderer, lifecycle: 'live', scope: 'global',
    control: { type: 'select', options: [{ value: 'xterm', label: 'xterm' }, { value: 'ghostty', label: 'Native Ghostty (macOS)' }] }, validate: oneOf(['xterm', 'ghostty'] as const)
  },
  terminalTheme: {
    key: 'terminalTheme', section: 'terminal', label: 'Terminal palette',
    description: 'ANSI color palette used by terminal sessions.',
    default: DEFAULT_SETTINGS.terminalTheme, lifecycle: 'live', scope: 'global',
    control: { type: 'select', options: stringOptions(terminalThemes) }, validate: oneOf(terminalThemes)
  },
  editorFontFamily: {
    key: 'editorFontFamily', section: 'editor', label: 'Editor font family',
    description: 'Editor font family; inherit follows the terminal font.',
    default: DEFAULT_SETTINGS.editorFontFamily, lifecycle: 'live', scope: 'global',
    control: { type: 'text', maxLength: 512, nullable: true, placeholder: 'Inherit terminal font' }, validate: isNullableFontFamily
  },
  editorFontSize: {
    key: 'editorFontSize', section: 'editor', label: 'Editor font size',
    description: 'Editor text size; inherit follows the terminal size.',
    default: DEFAULT_SETTINGS.editorFontSize, lifecycle: 'live', scope: 'global',
    control: { type: 'number', min: 9, max: 32, step: 1, nullable: true }, validate: (value): value is number | null => nullableBoundedNumber(value, 9, 32)
  },
  editorWordWrap: {
    key: 'editorWordWrap', section: 'editor', label: 'Word wrap',
    description: 'Wrap long editor lines at the viewport edge.',
    default: DEFAULT_SETTINGS.editorWordWrap, lifecycle: 'live', scope: 'global',
    control: { type: 'select', options: stringOptions(['off', 'on']) }, validate: oneOf(['off', 'on'] as const)
  },
  editorMinimap: {
    key: 'editorMinimap', section: 'editor', label: 'Minimap',
    description: 'Show the document overview beside the editor.',
    default: DEFAULT_SETTINGS.editorMinimap, lifecycle: 'live', scope: 'global',
    control: { type: 'toggle' }, validate: booleanValue
  },
  editorTabSize: {
    key: 'editorTabSize', section: 'editor', label: 'Tab size',
    description: 'Number of spaces represented by a tab.',
    default: DEFAULT_SETTINGS.editorTabSize, lifecycle: 'live', scope: 'global',
    control: { type: 'select', options: [2, 4, 8].map((value) => ({ value, label: String(value) })) }, validate: oneOf([2, 4, 8] as const)
  },
  editorStickyScroll: {
    key: 'editorStickyScroll', section: 'editor', label: 'Sticky scroll',
    description: 'Keep enclosing symbols visible while scrolling.',
    default: DEFAULT_SETTINGS.editorStickyScroll, lifecycle: 'live', scope: 'global',
    control: { type: 'toggle' }, validate: booleanValue
  },
  editorRenderWhitespace: {
    key: 'editorRenderWhitespace', section: 'editor', label: 'Whitespace',
    description: 'Choose when the editor renders whitespace characters.',
    default: DEFAULT_SETTINGS.editorRenderWhitespace, lifecycle: 'live', scope: 'global',
    control: { type: 'select', options: stringOptions(editorWhitespaceModes) }, validate: oneOf(editorWhitespaceModes)
  },
  editorAutoSaveMode: {
    key: 'editorAutoSaveMode', section: 'editor', label: 'Save mode',
    description: 'Save after a guarded delay or only on an explicit save command.',
    default: DEFAULT_SETTINGS.editorAutoSaveMode, lifecycle: 'live', scope: 'global',
    control: { type: 'select', options: stringOptions(autoSaveModes) }, validate: oneOf(autoSaveModes)
  },
  editorAutoSaveDelayMs: {
    key: 'editorAutoSaveDelayMs', section: 'editor', label: 'Auto-save delay',
    description: 'Idle time before a guarded automatic save.',
    default: DEFAULT_SETTINGS.editorAutoSaveDelayMs, lifecycle: 'live', scope: 'global',
    control: { type: 'number', min: 100, max: 5000, step: 50 }, validate: (value): value is number => boundedNumber(value, 100, 5000, true)
  },
  markdownPreviewDefault: {
    key: 'markdownPreviewDefault', section: 'editor', label: 'Open Markdown as preview',
    description: 'Open Markdown files in the rendered preview by default.',
    default: DEFAULT_SETTINGS.markdownPreviewDefault, lifecycle: 'live', scope: 'global',
    control: { type: 'toggle' }, validate: booleanValue
  },
  diffViewStyle: {
    key: 'diffViewStyle', section: 'source-control', label: 'Diff layout',
    description: 'Show new diffs side by side or in a unified stream.',
    default: DEFAULT_SETTINGS.diffViewStyle, lifecycle: 'live', scope: 'global',
    control: { type: 'select', options: stringOptions(diffViewStyles) }, validate: oneOf(diffViewStyles)
  },
  diffWordWrap: {
    key: 'diffWordWrap', section: 'source-control', label: 'Wrap diff lines',
    description: 'Wrap long diff lines instead of scrolling horizontally.',
    default: DEFAULT_SETTINGS.diffWordWrap, lifecycle: 'live', scope: 'global',
    control: { type: 'toggle' }, validate: booleanValue
  },
  diffFontFamily: {
    key: 'diffFontFamily', section: 'source-control', label: 'Diff font family',
    description: 'Diff font family; inherit follows the effective editor font.',
    default: DEFAULT_SETTINGS.diffFontFamily, lifecycle: 'live', scope: 'global',
    control: { type: 'text', maxLength: 512, nullable: true, placeholder: 'Inherit editor font' }, validate: isNullableFontFamily
  },
  diffFontSize: {
    key: 'diffFontSize', section: 'source-control', label: 'Diff font size',
    description: 'Diff text size; inherit follows the effective editor size.',
    default: DEFAULT_SETTINGS.diffFontSize, lifecycle: 'live', scope: 'global',
    control: { type: 'number', min: 9, max: 32, step: 1, nullable: true }, validate: (value): value is number | null => nullableBoundedNumber(value, 9, 32)
  },
  browserHomeUrl: {
    key: 'browserHomeUrl', section: 'browser', label: 'Browser home page',
    description: 'HTTP(S) page opened by new browser panes.',
    default: DEFAULT_SETTINGS.browserHomeUrl, lifecycle: 'live', scope: 'global',
    control: { type: 'text', maxLength: 2048, placeholder: 'http://localhost:3000' }, validate: isHttpUrl
  },
  browserSearchEngine: {
    key: 'browserSearchEngine', section: 'browser', label: 'Search engine',
    description: 'Provider used when the browser address is not a URL.',
    default: DEFAULT_SETTINGS.browserSearchEngine, lifecycle: 'live', scope: 'global',
    control: { type: 'select', options: stringOptions(browserSearchEngines) }, validate: oneOf(browserSearchEngines)
  },
  imageViewerFit: {
    key: 'imageViewerFit', section: 'browser', label: 'Image fit',
    description: 'Default scale used when opening images.',
    default: DEFAULT_SETTINGS.imageViewerFit, lifecycle: 'live', scope: 'global',
    control: { type: 'select', options: stringOptions(imageFitModes) }, validate: oneOf(imageFitModes)
  },
  pdfViewerFit: {
    key: 'pdfViewerFit', section: 'browser', label: 'PDF fit',
    description: 'Default scale used when opening PDF documents.',
    default: DEFAULT_SETTINGS.pdfViewerFit, lifecycle: 'live', scope: 'global',
    control: { type: 'select', options: stringOptions(pdfFitModes) }, validate: oneOf(pdfFitModes)
  },
  notificationActivityIndicator: {
    key: 'notificationActivityIndicator', section: 'notifications', label: 'Needs-attention indicator',
    description: 'Show a tray and Dock marker while an agent is waiting, needs permission, cannot be verified, or failed.',
    default: DEFAULT_SETTINGS.notificationActivityIndicator, lifecycle: 'live', scope: 'global',
    control: { type: 'toggle' }, validate: booleanValue
  },
  notificationFlashWindow: {
    key: 'notificationFlashWindow', section: 'notifications', label: 'Flash for attention',
    description: 'Flash an unfocused window when an agent first enters a needs-attention state.',
    default: DEFAULT_SETTINGS.notificationFlashWindow, lifecycle: 'live', scope: 'global',
    control: { type: 'toggle' }, validate: booleanValue
  },
  keyboardShortcutOverrides: {
    key: 'keyboardShortcutOverrides', section: 'shortcuts', label: 'Shortcut overrides',
    description: 'Per-command keyboard shortcuts; command validation is supplied by the command catalog.',
    default: DEFAULT_SETTINGS.keyboardShortcutOverrides, lifecycle: 'live', scope: 'global',
    control: { type: 'shortcut-map' }, validate: isShortcutOverrides
  },
  statusPollMs: {
    key: 'statusPollMs', section: 'advanced', label: 'Status polling',
    description: 'Refresh interval for worktree and Git status; Off disables polling.',
    default: DEFAULT_SETTINGS.statusPollMs, lifecycle: 'live', scope: 'global',
    control: {
      type: 'select',
      options: statusPollIntervals.map((value) => ({ value, label: value === 0 ? 'Off' : String(value / 1000) + 's' }))
    },
    validate: oneOf(statusPollIntervals)
  }
}

export const SETTING_KEYS = Object.freeze(Object.keys(SETTING_DEFINITIONS) as SettingKey[])
export const SETTINGS_METADATA: readonly SettingMetadata[] = Object.freeze(
  SETTING_KEYS.map((key) => {
    const { validate: _validate, ...metadata } = SETTING_DEFINITIONS[key]
    return Object.freeze(metadata)
  })
)

export class SettingsValidationError extends Error {
  readonly key: string | undefined

  constructor(message: string, key?: string) {
    super(key ? `${key}: ${message}` : message)
    this.name = 'SettingsValidationError'
    this.key = key
  }
}

export class StaleSettingsDraftError extends Error {
  constructor() {
    super('Settings changed while this value was being edited')
    this.name = 'StaleSettingsDraftError'
  }
}


function cloneSettingValue<T>(value: T): T {
  return structuredClone(value)
}

export function validateSettingsPatch(value: unknown): Partial<AppSettings> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SettingsValidationError('Settings patch must be an object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new SettingsValidationError('Settings patch must be a plain object')
  }
  const validated: Record<string, unknown> = {}
  for (const [rawKey, candidate] of Object.entries(value)) {
    if (!Object.hasOwn(SETTING_DEFINITIONS, rawKey)) {
      throw new SettingsValidationError('Unknown setting', rawKey)
    }
    const key = rawKey as SettingKey
    if (!SETTING_DEFINITIONS[key].validate(candidate)) {
      throw new SettingsValidationError('Invalid value', key)
    }
    validated[key] = cloneSettingValue(candidate)
  }
  return validated
}

export function resolveSettings(overrides: unknown = {}): AppSettings {
  const validated = validateSettingsPatch(overrides)
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...validated
  }
}

function settingsEqual(left: AppSettings[SettingKey], right: AppSettings[SettingKey]): boolean {
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return left === right
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b))
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries)
}

export function sparseSettings(settings: unknown): Partial<AppSettings> {
  const validated = validateSettingsPatch(settings)
  for (const key of SETTING_KEYS) {
    if (!Object.hasOwn(validated, key)) throw new SettingsValidationError('Missing setting', key)
  }
  const sparse: Record<string, unknown> = {}
  for (const key of SETTING_KEYS) {
    const value = validated[key] as AppSettings[SettingKey]
    if (!settingsEqual(value, DEFAULT_SETTINGS[key])) sparse[key] = cloneSettingValue(value)
  }
  return sparse
}


export function settingsKeysForSection(section: SettingsSection): readonly SettingKey[] {
  return SETTING_KEYS.filter((key) => SETTING_DEFINITIONS[key].section === section)
}

export function validateSettingsResetRequest(value: unknown): SettingsResetRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SettingsValidationError('Reset request must be an object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new SettingsValidationError('Reset request must be a plain object')
  }
  const keys = Object.keys(value)
  if (keys.length !== 1) throw new SettingsValidationError('Reset request must contain exactly one target')
  if ('keys' in value) {
    if (!Array.isArray(value.keys) || value.keys.length === 0) throw new SettingsValidationError('Reset keys must be a non-empty array')
    const unique = new Set<SettingKey>()
    for (const key of value.keys) {
      if (typeof key !== 'string' || !Object.hasOwn(SETTING_DEFINITIONS, key)) throw new SettingsValidationError('Unknown reset key', String(key))
      unique.add(key as SettingKey)
    }
    return { keys: [...unique] }
  }
  if ('section' in value) {
    const section = value.section
    if (typeof section !== 'string' || !SETTINGS_SECTIONS.includes(section as SettingsSection)) {
      throw new SettingsValidationError('Unknown settings section', String(section))
    }
    return { section: section as SettingsSection }
  }
  throw new SettingsValidationError('Reset request must target keys or a section')
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = Object.freeze([
  'agents',
  'editor',
  'source-control',
  'browser',
  'appearance',
  'terminal',
  'shortcuts',
  'notifications',
  'privacy',
  'advanced'
])

export function effectiveEditorFontFamily(settings: AppSettings): string {
  return settings.editorFontFamily ?? settings.terminalFontFamily
}

export function effectiveEditorFontSize(settings: AppSettings): number {
  return settings.editorFontSize ?? settings.terminalFontSize
}

export function effectiveDiffFontFamily(settings: AppSettings): string {
  return settings.diffFontFamily ?? effectiveEditorFontFamily(settings)
}

export function effectiveDiffFontSize(settings: AppSettings): number {
  return settings.diffFontSize ?? effectiveEditorFontSize(settings)
}

export type SettingsDraft<K extends SettingKey = SettingKey> = {
  key: K
  value: AppSettings[K]
  baseRevision: number
}

export function beginSettingsDraft<K extends SettingKey>(settings: AppSettings, revision: number, key: K): SettingsDraft<K> {
  return { key, value: cloneSettingValue(settings[key]), baseRevision: revision }
}

export function patchFromSettingsDraft<K extends SettingKey>(draft: SettingsDraft<K>, currentRevision: number): Partial<AppSettings> {
  if (draft.baseRevision !== currentRevision) throw new StaleSettingsDraftError()
  return validateSettingsPatch({ [draft.key]: draft.value })
}
