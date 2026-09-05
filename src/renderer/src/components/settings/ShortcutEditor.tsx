import { useEffect, useMemo, useState } from 'react'
import {
  APP_COMMANDS,
  appCommand,
  appCommandPlatform,
  formatAppShortcut,
  validateAppShortcutOverrides
} from '@shared/app-commands'
import type { AppCommand, AppCommandPlatform, ShortcutValidationIssue } from '@shared/app-commands'
import type { AppSettings } from '@shared/types'
import { validateSettingsPatch } from '@shared/settings'

const KEY_LABELS: Readonly<Record<string, string>> = {
  ' ': 'Space',
  ',': 'Comma',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Escape: 'Escape'
}

const APP_COMMAND_CATEGORIES = Object.freeze(
  APP_COMMANDS.map((command) => command.category).filter((category, index, all) => all.indexOf(category) === index)
)

export function shortcutFromKeyboardEvent(event: React.KeyboardEvent<HTMLInputElement>, platform: AppCommandPlatform): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return null
  const modifiers: string[] = []
  if (event.metaKey) modifiers.push(platform === 'mac' ? 'Mod' : 'Cmd')
  if (event.ctrlKey) modifiers.push(platform === 'mac' ? 'Ctrl' : 'Mod')
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')
  const mapped = KEY_LABELS[event.key] ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key)
  return [...modifiers, mapped].join('+')
}

function issueMessage(issue: ShortcutValidationIssue): string {
  if (issue.reason === 'unknown-command') return `Stored override references unknown command “${issue.commandId}”.`
  if (issue.reason === 'invalid-shortcut') return `“${issue.shortcut}” is not a valid shortcut.`
  const other = issue.conflictsWith ? appCommand(issue.conflictsWith)?.label ?? issue.conflictsWith : 'another command'
  return `Conflicts with ${other}${issue.platform ? ` on ${issue.platform}` : ''}.`
}

function ShortcutRow({
  command,
  overrides,
  revision,
  platform,
  onCommit
}: {
  command: AppCommand
  overrides: Readonly<Record<string, string>>
  revision: number
  platform: AppCommandPlatform
  onCommit(patch: Partial<AppSettings>): Promise<void>
}) {
  const current = overrides[command.id]
  const [raw, setRaw] = useState(current ?? '')
  const [baseRevision, setBaseRevision] = useState(revision)
  const [dirty, setDirty] = useState(false)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (dirty) {
      if (revision !== baseRevision) setStale(true)
      return
    }
    setRaw(current ?? '')
    setBaseRevision(revision)
    setStale(false)
    setError(null)
  }, [baseRevision, current, dirty, revision])

  const reload = (): void => {
    setRaw(current ?? '')
    setBaseRevision(revision)
    setDirty(false)
    setStale(false)
    setError(null)
  }

  const commit = async (revisionAtCommit = baseRevision): Promise<void> => {
    if (!dirty) return
    if (revisionAtCommit !== revision) {
      setStale(true)
      setError('Shortcuts changed elsewhere. Reload or retry against the latest bindings.')
      return
    }
    const candidate = { ...overrides }
    const shortcut = raw.trim()
    if (shortcut) candidate[command.id] = shortcut
    else delete candidate[command.id]
    const issues = validateAppShortcutOverrides(candidate)
    const issue = issues.find((entry) => entry.commandId === command.id || entry.conflictsWith === command.id)
    if (issue) {
      setError(issueMessage(issue))
      return
    }
    try {
      await onCommit(validateSettingsPatch({ keyboardShortcutOverrides: candidate }))
      setDirty(false)
      setStale(false)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const formattedDefaults = useMemo(
    () => command.defaultAccelerators.map((shortcut) => formatAppShortcut(shortcut, platform)),
    [command, platform]
  )
  return (
    <div className="shortcut-row">
      <div className="shortcut-copy">
        <strong>{command.label}</strong>
        <span>{command.id}</span>
      </div>
      <div className="shortcut-default" aria-label={`Default: ${formattedDefaults.join(' or ') || 'unassigned'}`}>
        {formattedDefaults.length === 0 ? <span className="settings-muted">Unassigned</span> : formattedDefaults.map((shortcut) => <kbd key={shortcut}>{shortcut}</kbd>)}
      </div>
      <div className="shortcut-editor-cell">
        <input
          className={`settings-input shortcut-input${error ? ' is-invalid' : ''}`}
          value={raw}
          placeholder="Use default"
          aria-label={`Custom shortcut for ${command.label}`}
          aria-invalid={Boolean(error)}
          onFocus={() => {
            if (!dirty) setBaseRevision(revision)
          }}
          onChange={(event) => {
            setRaw(event.currentTarget.value)
            setDirty(true)
            setError(null)
          }}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              reload()
              return
            }
            if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) return
            if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
              event.preventDefault()
              void commit()
              return
            }
            const shortcut = shortcutFromKeyboardEvent(event, platform)
            if (!shortcut) return
            event.preventDefault()
            setRaw(shortcut)
            setDirty(true)
            setError(null)
          }}
        />
        {current && <button type="button" className="settings-reset-setting" onMouseDown={(event) => event.preventDefault()} onClick={() => {
          setRaw('')
          setDirty(true)
          setError(null)
        }}>Clear</button>}
        {error && (
          <div className="settings-inline-error shortcut-error" role="alert">
            <span>{error}</span>
            {stale && (
              <span className="settings-inline-actions">
                <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={reload}>Reload</button>
                <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => {
                  setBaseRevision(revision)
                  setStale(false)
                  void commit(revision)
                }}>Retry</button>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export function ShortcutEditor({ settings, revision, onCommit }: { settings: AppSettings; revision: number; onCommit(patch: Partial<AppSettings>): Promise<void> }) {
  const platform = appCommandPlatform(navigator.platform)
  const issues = useMemo(() => validateAppShortcutOverrides(settings.keyboardShortcutOverrides), [settings.keyboardShortcutOverrides])
  const categories = APP_COMMAND_CATEGORIES

  return (
    <div className="shortcut-editor">
      <div className="shortcut-editor-head">
        <div>
          <strong>Application commands</strong>
          <span>Focus a field and press a shortcut, or enter a portable chord such as Mod+Shift+P.</span>
        </div>
        <span className="settings-badge">{platform === 'mac' ? 'macOS' : platform === 'windows' ? 'Windows' : 'Linux'}</span>
      </div>
      {issues.length > 0 && (
        <div className="settings-callout settings-callout-error" role="alert">
          <strong>Some stored shortcuts are inactive</strong>
          {issues.map((issue, index) => <span key={`${issue.commandId}:${issue.platform ?? 'all'}:${index}`}>{issueMessage(issue)}</span>)}
        </div>
      )}
      {categories.map((category) => (
        <section className="shortcut-group" key={category} aria-labelledby={`shortcut-group-${category.replaceAll(' ', '-').toLowerCase()}`}>
          <h4 id={`shortcut-group-${category.replaceAll(' ', '-').toLowerCase()}`}>{category}</h4>
          {APP_COMMANDS.filter((command) => command.category === category).map((command) => (
            <ShortcutRow key={command.id} command={command} overrides={settings.keyboardShortcutOverrides} revision={revision} platform={platform} onCommit={onCommit} />
          ))}
        </section>
      ))}
    </div>
  )
}
