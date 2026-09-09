import { guiDraftMap } from '../../gui-drafts'
import { useEffect, useId, useRef, useState } from 'react'
import type { AppSettings, SettingKey } from '@shared/types'
import {
  SettingsValidationError,
  StaleSettingsDraftError,
  patchFromSettingsDraft,
  validateSettingsPatch
} from '@shared/settings'
import type { SettingControl, SettingMetadata, SettingsDraft } from '@shared/settings'

const inputDrafts = guiDraftMap<{ raw: string; base: AppSettings[SettingKey] }>('settings-inputs')

const LIFECYCLE_LABELS = {
  live: 'Applies now',
  'new-terminal': 'New terminals',
  'new-session': 'New sessions',
  restart: 'Restart required'
} as const

export function formatSettingValue(value: AppSettings[SettingKey]): string {
  if (value === null || value === '') return 'Inherit'
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  if (typeof value === 'object') return Object.keys(value).length === 0 ? 'Standard bindings' : `${Object.keys(value).length} custom`
  return String(value)
}

function displayOptionLabel(label: string): string {
  const words = label.replace(/[-_]+/g, ' ')
  return words.length > 0 ? words[0]!.toLocaleUpperCase() + words.slice(1) : words
}

export function SettingsField({
  metadata,
  current,
  inheritedValue,
  resetting = false,
  onReset,
  children
}: {
  metadata: SettingMetadata
  current: AppSettings[SettingKey]
  inheritedValue?: string
  resetting?: boolean
  onReset(): void
  children: React.ReactNode
}) {
  const titleId = useId()
  const descriptionId = useId()
  const isDefault = typeof current !== 'object' || current === null || typeof metadata.default !== 'object' || metadata.default === null
    ? current === metadata.default
    : JSON.stringify(current) === JSON.stringify(metadata.default)
  return (
    <section className="settings-field" data-setting-key={metadata.key} tabIndex={-1} aria-labelledby={titleId} aria-describedby={descriptionId}>
      <div className="settings-field-copy">
        <div className="settings-field-title-line">
          <h3 id={titleId}>{metadata.label}</h3>
          {metadata.lifecycle !== 'live' && <span className="settings-badge">{LIFECYCLE_LABELS[metadata.lifecycle]}</span>}
        </div>
        <p id={descriptionId}>{metadata.description}{inheritedValue && <span className="settings-inherited-value"> Using {inheritedValue}.</span>}</p>
      </div>
      <div className="settings-field-action">
        {children}
        {(!isDefault || resetting) && (
          <button
            className="settings-reset-setting"
            type="button"
            disabled={resetting}
            onClick={onReset}
            aria-label={`Reset ${metadata.label} to default`} title={`Restore ${metadata.label} to ${formatSettingValue(metadata.default)}`}
          >
            {resetting ? 'Resetting…' : 'Reset to default'}
          </button>
        )}
      </div>
    </section>
  )
}

export function SettingsSwitch({
  checked,
  label,
  disabled = false,
  onChange
}: {
  checked: boolean
  label: string
  disabled?: boolean
  onChange(value: boolean): void
}) {
  return (
    <div className="settings-switch-control">
      <span aria-hidden="true">{checked ? 'On' : 'Off'}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label} title={`${checked ? 'Turn off' : 'Turn on'} ${label}`}
        disabled={disabled}
        className={`settings-switch${checked ? ' is-on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span className="settings-switch-thumb" />
      </button>
    </div>
  )
}

export function SettingsSelect({
  metadata,
  value,
  control,
  disabled = false,
  onChange
}: {
  metadata: SettingMetadata
  value: AppSettings[SettingKey]
  control: Extract<SettingControl, { type: 'select' }>
  disabled?: boolean
  onChange(patch: Partial<AppSettings>): void
}) {
  const selectedIndex = control.options.findIndex((option) => option.value === value)
  return (
    <select
      className="settings-select"
      aria-label={metadata.label}
      disabled={disabled}
      value={String(selectedIndex)}
      onChange={(event) => {
        const option = control.options[Number(event.currentTarget.value)]
        if (option) onChange(validateSettingsPatch({ [metadata.key]: option.value }))
      }}
    >
      {control.options.map((option, index) => <option key={`${index}:${String(option.value)}`} value={String(index)}>{displayOptionLabel(option.label)}</option>)}
    </select>
  )
}

function parseDraft(control: Extract<SettingControl, { type: 'text' | 'number' }>, raw: string): string | number | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0 && control.nullable) return null
  if (control.type === 'text') return trimmed
  if (trimmed.length === 0) return Number.NaN
  return Number(trimmed)
}

export function SettingsDraftInput({
  metadata,
  control,
  value,
  revision,
  suggestions,
  onCommit
}: {
  metadata: SettingMetadata
  control: Extract<SettingControl, { type: 'text' | 'number' }>
  value: AppSettings[SettingKey]
  revision: number
  suggestions?: readonly { value: string; label: string }[]
  onCommit(patch: Partial<AppSettings>): Promise<void>
}) {
  const recovered = inputDrafts.get(metadata.key)
  const [raw, setRaw] = useState(() => recovered?.raw ?? (value === null ? '' : String(value)))
  const [custom, setCustom] = useState(() => !suggestions?.some(option => option.value === (recovered?.raw ?? value)))
  const baseValue = useRef(recovered ? recovered.base : value)
  const [baseRevision, setBaseRevision] = useState(revision)
  const [dirty, setDirty] = useState(Boolean(recovered && recovered.raw !== (value === null ? '' : String(value))))
  const [busy, setBusy] = useState(false)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { if (dirty) inputDrafts.set(metadata.key, { raw, base: baseValue.current }); else inputDrafts.delete(metadata.key) }, [metadata.key, raw, dirty])

  useEffect(() => {
    if (dirty) {
      if (!Object.is(value, baseValue.current)) setStale(true)
      else if (!stale) setBaseRevision(revision)
      return
    }
    baseValue.current = value
    setRaw(value === null ? '' : String(value))
    setBaseRevision(revision)
    setStale(false)
    setError(null)
  }, [baseRevision, dirty, revision, value, stale])

  const suggestedValue = suggestions?.some(option => option.value === value) ?? false
  useEffect(() => {
    if (!dirty) setCustom(!suggestedValue)
  }, [dirty, suggestedValue, value])

  const commit = async (revisionAtCommit = baseRevision, choice?: string): Promise<void> => {
    if ((!dirty && choice === undefined) || busy) return
    const draft: SettingsDraft = {
      key: metadata.key,
      value: parseDraft(control, choice ?? raw),
      baseRevision: revisionAtCommit
    }
    setBusy(true)
    try {
      const patch = patchFromSettingsDraft(draft, revision)
      await onCommit(patch)
      setDirty(false)
      setStale(false)
      setError(null)
    } catch (caught) {
      if (caught instanceof StaleSettingsDraftError) {
        setStale(true)
        setError('This setting changed elsewhere. Reload its current value or retry your edit against the latest settings.')
      } else if (caught instanceof SettingsValidationError) {
        setError(caught.message)
      } else {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    } finally {
      setBusy(false)
    }
  }

  const reload = (): void => {
    baseValue.current = value
    setRaw(value === null ? '' : String(value))
    setBaseRevision(revision)
    setDirty(false)
    setStale(false)
    setError(null)
  }

  return (
    <div className="settings-draft-control" data-settings-dirty={dirty ? 'true' : undefined} aria-busy={busy}>
      {suggestions?.length ? <select className="settings-select" aria-label={metadata.label} title="Choose an installed agent, or use a custom command" value={custom ? '' : raw} disabled={busy} onChange={event => {
          setCustom(event.currentTarget.value === '')
          const choice = event.currentTarget.value
          setError(null)
          if (choice) { setRaw(choice); setDirty(true); void commit(baseRevision, choice) }
        }}>{suggestions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}<option value="">Custom command…</option></select> : null}
      {(!suggestions?.length || custom) && <div className="settings-input-wrap">
        <input
          title={suggestions?.length ? "Command and arguments used to start your agent" : undefined}
          className={`settings-input${error ? ' is-invalid' : ''}`}
          type={control.type === 'number' ? 'number' : 'text'}
          min={control.type === 'number' ? control.min : undefined}
          max={control.type === 'number' ? control.max : undefined}
          step={control.type === 'number' ? control.step : undefined}
          maxLength={control.type === 'text' ? control.maxLength : undefined}
          placeholder={control.type === 'text' ? control.placeholder : control.nullable ? 'Inherit' : undefined}
          aria-label={suggestions?.length ? "Custom agent command" : metadata.label}
          aria-invalid={Boolean(error)}
          disabled={busy}
          value={raw}
          onFocus={() => {
            if (!dirty) setBaseRevision(revision)
          }}
          onChange={(event) => {
            setRaw(event.currentTarget.value)
            setDirty(true)
            setError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void commit()
            }
            if (event.key === 'Escape' && dirty) {
              event.stopPropagation()
              reload()
            }
          }}
        />
        {metadata.key === 'uiScale' && (
          <span className="settings-input-suffix">{Number.isFinite(Number(raw)) ? `${Math.round(Number(raw) * 100)}%` : '—'}</span>
        )}
      </div>}
      {dirty && (
        <div className="settings-draft-actions">
          <span>{busy ? 'Saving…' : 'Unsaved change'}</span>
          <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={reload}>Discard</button>
          <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={() => void commit()}>{busy ? 'Applying…' : 'Apply'}</button>
        </div>
      )}
      {error && (
        <div className="settings-inline-error" role="alert">
          <span>{error}</span>
          {stale && (
            <span className="settings-inline-actions">
              <button type="button" onClick={reload}>Reload</button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setBaseRevision(revision)
                  setStale(false)
                  void commit(revision)
                }}
              >
                Retry
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  )
}

export function SettingsState({ kind, title, detail, action }: { kind: 'loading' | 'empty' | 'error'; title: string; detail?: string; action?: React.ReactNode }) {
  return (
    <div className={`settings-state settings-state-${kind}`} role={kind === 'error' ? 'alert' : 'status'} aria-live="polite">
      {kind === 'loading' && <span className="settings-state-spinner" aria-hidden="true" />}
      <strong>{title}</strong>
      {detail && <span>{detail}</span>}
      {action}
    </div>
  )
}
