import { useEffect, useId, useState } from 'react'
import type { AppSettings, SettingKey } from '@shared/types'
import {
  SettingsValidationError,
  StaleSettingsDraftError,
  patchFromSettingsDraft,
  validateSettingsPatch
} from '@shared/settings'
import type { SettingControl, SettingMetadata, SettingsDraft } from '@shared/settings'

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

export function SettingsField({
  metadata,
  current,
  inheritedValue,
  onReset,
  children
}: {
  metadata: SettingMetadata
  current: AppSettings[SettingKey]
  inheritedValue?: string
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
          <span className="settings-badge">Global</span>
          <span className="settings-badge">{LIFECYCLE_LABELS[metadata.lifecycle]}</span>
        </div>
        <p id={descriptionId}>{metadata.description}</p>
        <div className="settings-default-line">
          <span>Default: {formatSettingValue(metadata.default)}</span>
          {inheritedValue && <span>Effective: {inheritedValue}</span>}
        </div>
      </div>
      <div className="settings-field-action">
        {children}
        <button className="settings-reset-setting" type="button" disabled={isDefault} onClick={onReset} aria-label={`Reset ${metadata.label} to default`}>
          Reset
        </button>
      </div>
    </section>
  )
}

export function SettingsSwitch({ checked, label, onChange }: { checked: boolean; label: string; onChange(value: boolean): void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`settings-switch${checked ? ' is-on' : ''}`} onClick={() => onChange(!checked)}>
      <span className="settings-switch-thumb" />
    </button>
  )
}


export function SettingsSelect({
  metadata,
  value,
  control,
  onChange
}: {
  metadata: SettingMetadata
  value: AppSettings[SettingKey]
  control: Extract<SettingControl, { type: 'select' }>
  onChange(patch: Partial<AppSettings>): void
}) {
  const selectedIndex = control.options.findIndex((option) => option.value === value)
  return (
    <select
      className="settings-select"
      aria-label={metadata.label}
      value={String(selectedIndex)}
      onChange={(event) => {
        const option = control.options[Number(event.currentTarget.value)]
        if (option) onChange(validateSettingsPatch({ [metadata.key]: option.value }))
      }}
    >
      {control.options.map((option, index) => <option key={`${index}:${String(option.value)}`} value={String(index)}>{option.label}</option>)}
    </select>
  )
}

function draftText(value: AppSettings[SettingKey]): string {
  return value === null ? '' : String(value)
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
  onCommit
}: {
  metadata: SettingMetadata
  control: Extract<SettingControl, { type: 'text' | 'number' }>
  value: AppSettings[SettingKey]
  revision: number
  onCommit(patch: Partial<AppSettings>): Promise<void>
}) {
  const [raw, setRaw] = useState(() => draftText(value))
  const [baseRevision, setBaseRevision] = useState(revision)
  const [dirty, setDirty] = useState(false)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (dirty) {
      if (revision !== baseRevision) setStale(true)
      return
    }
    setRaw(draftText(value))
    setBaseRevision(revision)
    setStale(false)
    setError(null)
  }, [baseRevision, dirty, revision, value])

  const commit = async (revisionAtCommit = baseRevision): Promise<void> => {
    if (!dirty) return
    const draft: SettingsDraft = {
      key: metadata.key,
      value: parseDraft(control, raw),
      baseRevision: revisionAtCommit
    }
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
        setError('Enter a valid value within the limits shown for this setting.')
      } else {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    }
  }

  const reload = (): void => {
    setRaw(draftText(value))
    setBaseRevision(revision)
    setDirty(false)
    setStale(false)
    setError(null)
  }

  return (
    <div className="settings-draft-control">
      <div className="settings-input-wrap">
        <input
          className={`settings-input${error ? ' is-invalid' : ''}`}
          type={control.type === 'number' ? 'number' : 'text'}
          min={control.type === 'number' ? control.min : undefined}
          max={control.type === 'number' ? control.max : undefined}
          step={control.type === 'number' ? control.step : undefined}
          maxLength={control.type === 'text' ? control.maxLength : undefined}
          placeholder={control.type === 'text' ? control.placeholder : undefined}
          aria-label={metadata.label}
          aria-invalid={Boolean(error)}
          value={raw}
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
      </div>
      {error && (
        <div className="settings-inline-error" role="alert">
          <span>{error}</span>
          {stale && (
            <span className="settings-inline-actions">
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={reload}>Reload</button>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
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
