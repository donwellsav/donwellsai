export type AppCommandCategory = 'File' | 'Workspace' | 'View' | 'Terminal' | 'Source Control' | 'Agent'
export type AppCommandPlatform = 'mac' | 'windows' | 'linux'

export type AppCommandId =
  | 'new-project'
  | 'add-repo'
  | 'new-worktree'
  | 'quick-open'
  | 'command-palette'
  | 'global-navigator'
  | 'navigate-back'
  | 'navigate-forward'
  | 'switch-mru-next'
  | 'switch-mru-previous'
  | 'new-terminal'
  | 'split-terminal'
  | 'find'
  | 'focus-next-pane'
  | 'focus-previous-pane'
  | 'close-active-pane'
  | 'stop-active-process'
  | 'move-pane-left'
  | 'move-pane-right'
  | 'move-pane-up'
  | 'move-pane-down'
  | 'layout-focus'
  | 'layout-pair'
  | 'layout-build'
  | 'layout-review'
  | 'toggle-sidebar'
  | 'toggle-explorer'
  | 'toggle-git-status'
  | 'toggle-markdown-preview'
  | 'run-agent'
  | 'refresh-workspace'
  | 'select-tab-1'
  | 'select-tab-2'
  | 'select-tab-3'
  | 'select-tab-4'
  | 'select-tab-5'
  | 'select-tab-6'
  | 'select-tab-7'
  | 'select-tab-8'
  | 'select-tab-9'
  | 'settings'
  | 'show-agents'
  | 'show-project-memory'
  | 'show-editor-recovery'
  | 'show-parallel-runs'
  | 'show-scheduled-runs'

export type AppCommand = {
  id: AppCommandId
  label: string
  category: AppCommandCategory
  /** Portable chords. Mod means Command on macOS and Control elsewhere. */
  defaultAccelerators: readonly string[]
  palette: boolean
  allowWhilePaletteOpen?: boolean
  /** Renderer-context command; native Electron menus must not install its accelerator globally. */
  rendererOnly?: boolean
}

export const APP_COMMANDS: readonly AppCommand[] = Object.freeze([
  { id: 'new-project', label: 'New project…', category: 'File', defaultAccelerators: ['Mod+Shift+N'], palette: true },
  { id: 'add-repo', label: 'Open existing folder…', category: 'File', defaultAccelerators: ['Mod+O'], palette: true },
  { id: 'new-worktree', label: 'New worktree', category: 'Workspace', defaultAccelerators: ['Mod+N'], palette: true },
  { id: 'quick-open', label: 'Quick Open…', category: 'File', defaultAccelerators: ['Mod+P'], palette: false, allowWhilePaletteOpen: true },
  { id: 'command-palette', label: 'Show Command Palette…', category: 'View', defaultAccelerators: ['Mod+Shift+P', 'Mod+K'], palette: false, allowWhilePaletteOpen: true },
  { id: 'global-navigator', label: 'Open Global Navigator…', category: 'View', defaultAccelerators: ['Mod+Shift+O'], palette: true, allowWhilePaletteOpen: true },
  { id: 'navigate-back', label: 'Go back', category: 'View', defaultAccelerators: ['Alt+ArrowLeft'], palette: true },
  { id: 'navigate-forward', label: 'Go forward', category: 'View', defaultAccelerators: ['Alt+ArrowRight'], palette: true },
  { id: 'switch-mru-next', label: 'Switch to next recent location', category: 'View', defaultAccelerators: ['Control+Tab'], palette: true },
  { id: 'switch-mru-previous', label: 'Switch to previous recent location', category: 'View', defaultAccelerators: ['Control+Shift+Tab'], palette: true },
  { id: 'new-terminal', label: 'New terminal', category: 'Terminal', defaultAccelerators: ['Mod+T'], palette: true },
  { id: 'split-terminal', label: 'Split terminal', category: 'Terminal', defaultAccelerators: ['Mod+Shift+5'], palette: true },
  { id: 'close-active-pane', label: 'Hide active view', category: 'View', defaultAccelerators: ['Mod+W'], palette: true },
  { id: 'move-pane-left', label: 'Move active view left', category: 'View', defaultAccelerators: [], palette: true, rendererOnly: true },
  { id: 'move-pane-right', label: 'Move active view right', category: 'View', defaultAccelerators: [], palette: true, rendererOnly: true },
  { id: 'move-pane-up', label: 'Move active view up', category: 'View', defaultAccelerators: [], palette: true, rendererOnly: true },
  { id: 'move-pane-down', label: 'Move active view down', category: 'View', defaultAccelerators: [], palette: true, rendererOnly: true },
  { id: 'stop-active-process', label: 'Stop active terminal process…', category: 'Terminal', defaultAccelerators: [], palette: true },
  { id: 'layout-focus', label: 'Focus workspace layout', category: 'View', defaultAccelerators: [], palette: true },
  { id: 'layout-pair', label: 'Pair workspace layout', category: 'View', defaultAccelerators: [], palette: true },
  { id: 'layout-build', label: 'Build and preview workspace layout', category: 'View', defaultAccelerators: [], palette: true },
  { id: 'layout-review', label: 'Review workspace layout', category: 'View', defaultAccelerators: [], palette: true },
  { id: 'find', label: 'Find in active view', category: 'View', defaultAccelerators: ['Mod+F'], palette: true, rendererOnly: true },
  { id: 'focus-next-pane', label: 'Focus next pane', category: 'View', defaultAccelerators: ['Mod+Alt+ArrowRight'], palette: true, rendererOnly: true },
  { id: 'focus-previous-pane', label: 'Focus previous pane', category: 'View', defaultAccelerators: ['Mod+Alt+ArrowLeft'], palette: true, rendererOnly: true },
  { id: 'toggle-sidebar', label: 'Toggle workspace sidebar', category: 'View', defaultAccelerators: ['Mod+B'], palette: true },
  { id: 'toggle-explorer', label: 'Toggle Explorer', category: 'View', defaultAccelerators: ['Mod+Shift+E'], palette: true },
  { id: 'toggle-git-status', label: 'Toggle Source Control', category: 'Source Control', defaultAccelerators: ['Mod+Shift+G'], palette: true },
  { id: 'toggle-markdown-preview', label: 'Toggle Markdown preview', category: 'View', defaultAccelerators: ['Mod+Shift+V'], palette: true },
  { id: 'run-agent', label: 'Run default agent', category: 'Agent', defaultAccelerators: ['Mod+Enter'], palette: true },
  { id: 'refresh-workspace', label: 'Refresh workspace', category: 'Workspace', defaultAccelerators: [], palette: true },
  { id: 'select-tab-1', label: 'Select tab 1', category: 'View', defaultAccelerators: ['Mod+1'], palette: false },
  { id: 'select-tab-2', label: 'Select tab 2', category: 'View', defaultAccelerators: ['Mod+2'], palette: false },
  { id: 'select-tab-3', label: 'Select tab 3', category: 'View', defaultAccelerators: ['Mod+3'], palette: false },
  { id: 'select-tab-4', label: 'Select tab 4', category: 'View', defaultAccelerators: ['Mod+4'], palette: false },
  { id: 'select-tab-5', label: 'Select tab 5', category: 'View', defaultAccelerators: ['Mod+5'], palette: false },
  { id: 'select-tab-6', label: 'Select tab 6', category: 'View', defaultAccelerators: ['Mod+6'], palette: false },
  { id: 'select-tab-7', label: 'Select tab 7', category: 'View', defaultAccelerators: ['Mod+7'], palette: false },
  { id: 'select-tab-8', label: 'Select tab 8', category: 'View', defaultAccelerators: ['Mod+8'], palette: false },
  { id: 'select-tab-9', label: 'Select tab 9', category: 'View', defaultAccelerators: ['Mod+9'], palette: false },
  { id: 'settings', label: 'Settings…', category: 'View', defaultAccelerators: ['Mod+Comma'], palette: true },
  { id: 'show-agents', label: 'Show agent sessions', category: 'Agent', defaultAccelerators: [], palette: true },
  { id: 'show-project-memory', label: 'Show project memory', category: 'Workspace', defaultAccelerators: [], palette: true },
  { id: 'show-editor-recovery', label: 'Show editor recovery', category: 'View', defaultAccelerators: [], palette: true },
  { id: 'show-parallel-runs', label: 'Show parallel runs', category: 'View', defaultAccelerators: [], palette: true },
  { id: 'show-scheduled-runs', label: 'Show scheduled runs', category: 'View', defaultAccelerators: [], palette: true }
] satisfies AppCommand[])

export function appCommand(id: string): AppCommand | undefined {
  return APP_COMMANDS.find((command) => command.id === id)
}

export function appCommandPlatform(platform: string): AppCommandPlatform {
  if (platform === 'darwin' || platform === 'mac' || platform === 'MacIntel') return 'mac'
  if (platform === 'win32' || platform === 'windows' || platform.startsWith('Win')) return 'windows'
  return 'linux'
}

type ParsedChord = {
  key: string
  mod: boolean
  command: boolean
  control: boolean
  alt: boolean
  shift: boolean
}

const MODIFIER_ALIASES: Readonly<Record<string, 'mod' | 'command' | 'control' | 'alt' | 'shift'>> = Object.freeze({
  mod: 'mod',
  cmdorctrl: 'mod',
  commandorcontrol: 'mod',
  cmd: 'command',
  command: 'command',
  meta: 'command',
  ctrl: 'control',
  control: 'control',
  alt: 'alt',
  option: 'alt',
  shift: 'shift'
})

const KEY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  ',': 'comma',
  comma: 'comma',
  return: 'enter',
  esc: 'escape',
  spacebar: 'space',
  ' ': 'space'
})

function parseChord(value: string): ParsedChord | null {
  const parts = value.split('+').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0 || parts.length > 6) return null
  const parsed: ParsedChord = { key: '', mod: false, command: false, control: false, alt: false, shift: false }
  for (const raw of parts) {
    const part = raw.toLowerCase()
    const modifier = MODIFIER_ALIASES[part]
    if (modifier) {
      if (parsed[modifier]) return null
      parsed[modifier] = true
      continue
    }
    if (parsed.key) return null
    const key = KEY_ALIASES[part] ?? part
    if (!/^(?:[a-z0-9]|f(?:[1-9]|1[0-2])|enter|escape|comma|space|tab|backspace|delete|arrow(?:up|down|left|right))$/.test(key)) return null
    parsed.key = key
  }
  if (!parsed.key || (parsed.mod && (parsed.command || parsed.control))) return null
  return parsed
}

function normalizedChord(parsed: ParsedChord, platform: AppCommandPlatform): string {
  const modifiers = [
    parsed.mod ? (platform === 'mac' ? 'command' : 'control') : '',
    parsed.command ? 'command' : '',
    parsed.control ? 'control' : '',
    parsed.alt ? 'alt' : '',
    parsed.shift ? 'shift' : ''
  ].filter(Boolean).sort()
  return [...modifiers, parsed.key].join('+')
}

export type ShortcutValidationIssue = {
  commandId: string
  shortcut: string
  reason: 'unknown-command' | 'invalid-shortcut' | 'conflict'
  conflictsWith?: AppCommandId
  platform?: AppCommandPlatform
}

export function validateAppShortcutOverrides(overrides: Readonly<Record<string, string>>): ShortcutValidationIssue[] {
  const issues: ShortcutValidationIssue[] = []
  for (const [commandId, shortcut] of Object.entries(overrides)) {
    if (!appCommand(commandId)) {
      issues.push({ commandId, shortcut, reason: 'unknown-command' })
      continue
    }
    if (!parseChord(shortcut)) issues.push({ commandId, shortcut, reason: 'invalid-shortcut' })
  }
  for (const platform of ['mac', 'windows', 'linux'] as const) {
    const seen = new Map<string, AppCommandId>()
    for (const command of APP_COMMANDS) {
      const chords = overrides[command.id] === undefined ? command.defaultAccelerators : [overrides[command.id]!]
      for (const chord of chords) {
        const parsed = parseChord(chord)
        if (!parsed) continue
        const normalized = normalizedChord(parsed, platform)
        const other = seen.get(normalized)
        if (other && other !== command.id) {
          issues.push({ commandId: command.id, shortcut: chord, reason: 'conflict', conflictsWith: other, platform })
        } else {
          seen.set(normalized, command.id)
        }
      }
    }
  }
  return issues
}

export type ResolvedAppShortcut = {
  command: AppCommand
  shortcut: string
  normalized: string
}

export type ResolvedAppShortcuts = {
  shortcuts: readonly ResolvedAppShortcut[]
  issues: readonly ShortcutValidationIssue[]
}

export function resolveAppShortcuts(
  overrides: Readonly<Record<string, string>>,
  platform: AppCommandPlatform
): ResolvedAppShortcuts {
  const issues = validateAppShortcutOverrides(overrides)
  const conflicted = new Set(
    issues
      .filter((issue) => issue.reason === 'conflict' && issue.platform === platform)
      .flatMap((issue) => [issue.commandId, issue.conflictsWith ?? ''])
  )
  const shortcuts: ResolvedAppShortcut[] = []
  for (const command of APP_COMMANDS) {
    if (conflicted.has(command.id)) continue
    const chords = overrides[command.id] === undefined ? command.defaultAccelerators : [overrides[command.id]!]
    for (const shortcut of chords) {
      const parsed = parseChord(shortcut)
      if (!parsed) continue
      shortcuts.push({ command, shortcut, normalized: normalizedChord(parsed, platform) })
    }
  }
  return { shortcuts, issues }
}

export type AppKeyboardEvent = {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}


export function createAppShortcutMatcher(
  overrides: Readonly<Record<string, string>>,
  platform: AppCommandPlatform
): (event: AppKeyboardEvent) => AppCommand | undefined {
  const resolved = resolveAppShortcuts(overrides, platform).shortcuts
  return (event) => {
    const modifiers = [
      event.metaKey ? 'command' : '',
      event.ctrlKey ? 'control' : '',
      event.altKey ? 'alt' : '',
      event.shiftKey ? 'shift' : ''
    ].filter(Boolean).sort()
    const key = event.key.toLowerCase()
    const normalized = [...modifiers, KEY_ALIASES[key] ?? key].join('+')
    return resolved.find((entry) => entry.normalized === normalized)?.command
  }
}

export function formatAppShortcut(shortcut: string, platform: AppCommandPlatform): string {
  const parsed = parseChord(shortcut)
  if (!parsed) return shortcut
  const keys: string[] = []
  if (parsed.mod) keys.push(platform === 'mac' ? '⌘' : 'Ctrl')
  if (parsed.command) keys.push(platform === 'mac' ? '⌘' : 'Meta')
  if (parsed.control) keys.push(platform === 'mac' ? '⌃' : 'Ctrl')
  if (parsed.alt) keys.push(platform === 'mac' ? '⌥' : 'Alt')
  if (parsed.shift) keys.push(platform === 'mac' ? '⇧' : 'Shift')
  const labels: Readonly<Record<string, string>> = { comma: ',', enter: 'Enter', escape: 'Esc', space: 'Space', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→' }
  keys.push(labels[parsed.key] ?? parsed.key.toUpperCase())
  return platform === 'mac' ? keys.join('') : keys.join('+')
}

/** Electron accelerator for the primary binding; native menus consume this registry. */
export function electronAccelerator(command: AppCommand, overrides: Readonly<Record<string, string>> = {}): string | undefined {
  if (command.rendererOnly) return undefined
  const shortcut = overrides[command.id] ?? command.defaultAccelerators[0]
  if (!shortcut) return undefined
  const parsed = parseChord(shortcut)
  if (!parsed) return undefined
  const keys: string[] = []
  if (parsed.mod) keys.push('CmdOrCtrl')
  if (parsed.command) keys.push('Command')
  if (parsed.control) keys.push('Control')
  if (parsed.alt) keys.push('Alt')
  if (parsed.shift) keys.push('Shift')
  const labels: Readonly<Record<string, string>> = { comma: ',', enter: 'Enter', escape: 'Escape', space: 'Space', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right' }
  keys.push(labels[parsed.key] ?? parsed.key.toUpperCase())
  return keys.join('+')
}
