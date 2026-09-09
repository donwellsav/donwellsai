import { guiDraftMap } from '../../gui-drafts'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  APP_COMMANDS,
  appCommand,
  appCommandPlatform,
  appShortcutKey,
  formatAppShortcut,
  validateAppShortcutOverrides
} from '@shared/app-commands'
import type { AppCommand, AppCommandPlatform, ShortcutValidationIssue } from '@shared/app-commands'
import type { AppSettings } from '@shared/types'
import { validateSettingsPatch } from '@shared/settings'

const shortcutDrafts = guiDraftMap<{ raw: string; base: string | undefined }>('settings-shortcuts')

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
  const key = appShortcutKey(event, platform)
  const mapped = KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key)
  return [...modifiers, mapped].join('+')
}

function issueMessage(issue: ShortcutValidationIssue): string {
  if (issue.reason === 'unknown-command') return `Stored override references unknown command “${issue.commandId}”.`
  if (issue.reason === 'invalid-shortcut') return `“${issue.shortcut}” is not a valid shortcut.`
  const other = issue.conflictsWith ? appCommand(issue.conflictsWith)?.label ?? issue.conflictsWith : issue.nativeCommand ?? 'another command'
  return `Conflicts with ${other}${issue.platform ? ` on ${issue.platform}` : ''}.`
}

function ShortcutRow({
  command,
  overrides,
  revision,
  platform,
  onCommit,
  hidden
}: {
  command: AppCommand
  hidden: boolean
  overrides: Readonly<Record<string, string>>
  revision: number
  platform: AppCommandPlatform
  onCommit(patch: Partial<AppSettings>): Promise<void>
}) {
  const current = overrides[command.id]
  const recovered = shortcutDrafts.get(command.id)
  const baseValue = useRef(recovered ? recovered.base : current)
  const [raw, setRaw] = useState(recovered?.raw ?? current ?? '')
  const [baseRevision, setBaseRevision] = useState(revision)
  const [dirty, setDirty] = useState(Boolean(recovered && recovered.raw !== (current ?? '')))
  const [busy, setBusy] = useState(false)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { if (dirty) shortcutDrafts.set(command.id, { raw, base: baseValue.current }); else shortcutDrafts.delete(command.id) }, [command.id, raw, dirty])

  useEffect(() => {
    if (dirty) {
      if (current !== baseValue.current) setStale(true)
      else if (!stale) setBaseRevision(revision)
      return
    }
    baseValue.current = current
    setRaw(current ?? '')
    setBaseRevision(revision)
    setStale(false)
    setError(null)
  }, [baseRevision, current, dirty, revision, stale])

  const reload = (): void => {
    baseValue.current = current
    setRaw(current ?? '')
    setBaseRevision(revision)
    setDirty(false)
    setStale(false)
    setError(null)
  }

  const commit = async (revisionAtCommit = baseRevision): Promise<void> => {
    if (!dirty || busy) return
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
    setBusy(true)
    try {
      await onCommit(validateSettingsPatch({ keyboardShortcutOverrides: candidate }))
      setDirty(false)
      setStale(false)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const formattedDefaults = useMemo(
    () => command.defaultAccelerators.map((shortcut) => formatAppShortcut(shortcut, platform)),
    [command, platform]
  )
  return (
    <div hidden={hidden && !dirty} className="shortcut-row" data-settings-dirty={dirty ? 'true' : undefined} aria-busy={busy}>
      <div className="shortcut-copy">
        <strong>{command.label}</strong>
      </div>
      <div className="shortcut-default" aria-label={`Default: ${formattedDefaults.join(' or ') || 'unassigned'}`}>
        {formattedDefaults.length === 0 ? <span className="settings-muted">Unassigned</span> : formattedDefaults.map((shortcut) => <kbd key={shortcut}>{shortcut}</kbd>)}
      </div>
      <div className="shortcut-editor-cell">
        <input
          className={`settings-input shortcut-input${error ? ' is-invalid' : ''}`}
          value={raw}
          disabled={busy}
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
        {(dirty || current) && (
          <div className="shortcut-row-actions">
            {raw.length > 0 && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => {
              setRaw('')
              setDirty(true)
              setError(null)
            }}>Use default</button>}
            {dirty && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={reload}>Discard</button>}
            {dirty && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void commit()}>{busy ? 'Applying…' : 'Apply'}</button>}
          </div>
        )}
        {error && (
          <div className="settings-inline-error shortcut-error" role="alert">
            <span>{error}</span>
            {stale && (
              <span className="settings-inline-actions">
                <button type="button" onClick={reload}>Reload</button>
                <button type="button" disabled={busy} onClick={() => {
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
  const [query, setQuery] = useState('')
  const issues = useMemo(() => validateAppShortcutOverrides(settings.keyboardShortcutOverrides), [settings.keyboardShortcutOverrides])
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const matchingCommands = useMemo(() => APP_COMMANDS.filter((command) => (
    !normalizedQuery || `${command.label} ${command.id} ${command.category}`.toLocaleLowerCase().includes(normalizedQuery)
  )), [normalizedQuery])

  return (
    <div className="shortcut-editor">
      <div className="shortcut-toolbar">
        <label>
          <span className="sr-only">Filter application commands</span>
          <input className="settings-input" value={query} placeholder="Filter commands or categories" onChange={(event) => setQuery(event.currentTarget.value)} />
        </label>
        <span>{matchingCommands.length} of {APP_COMMANDS.length} commands</span>
      </div>
      {issues.length > 0 && (
        <div className="settings-callout settings-callout-error" role="alert">
          <strong>Some stored shortcuts are inactive</strong>
          {issues.map((issue, index) => <span key={`${issue.commandId}:${issue.platform ?? 'all'}:${index}`}>{issueMessage(issue)}</span>)}
        </div>
      )}
      {APP_COMMAND_CATEGORIES.map((category) => {
        const commands = APP_COMMANDS.filter((command) => command.category === category)
        const headingId = `shortcut-group-${category.replaceAll(' ', '-').toLowerCase()}`
        return (
          <section className="shortcut-group" key={category} aria-labelledby={headingId}>
            <h4 id={headingId}>{category}</h4>
            {commands.map((command) => (
              <ShortcutRow hidden={!matchingCommands.includes(command)} key={command.id} command={command} overrides={settings.keyboardShortcutOverrides} revision={revision} platform={platform} onCommit={onCommit} />
            ))}
          </section>
        )
      })}
      {matchingCommands.length === 0 && <div className="settings-state settings-state-empty"><strong>No matching commands</strong><span>Try a command name, category, or command identifier.</span></div>}
    </div>
  )
}
