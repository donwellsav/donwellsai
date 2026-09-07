import { ProjectKitSettings } from './settings/ProjectKitSettings'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { appCommandPlatform } from '@shared/app-commands'
import type { AgentPreset, AppSettings, SettingKey, SettingsResetRequest, SettingsSection, TerminalThemeName } from '@shared/types'
import {
  SETTINGS_METADATA,
  effectiveDiffFontFamily,
  effectiveDiffFontSize,
  effectiveEditorFontFamily,
  effectiveEditorFontSize,
  validateSettingsPatch
} from '@shared/settings'
import type { SettingControl, SettingMetadata } from '@shared/settings'
import { useAppStore } from '../store'
import { SETTINGS_SECTION_PRESENTATION, resetSettingsAtRevision, searchSettingsCatalog } from '../settings-workspace'
import { TERMINAL_THEMES, TERMINAL_THEME_NAMES } from '../terminal-themes'
import { Icon } from './Icon'
import { ModalDialog } from './ModalDialog'
import {
  SettingsDraftInput,
  SettingsField,
  SettingsSelect,
  SettingsState,
  SettingsSwitch
} from './settings/SettingsControls'
import { ShortcutEditor } from './settings/ShortcutEditor'
import { SkillsManager } from './settings/SkillsManager'
import { ProjectToolsSettings } from './settings/ProjectToolsSettings'

type ResetConfirmation = { kind: 'section'; section: SettingsSection; label: string } | { kind: 'all' }
type NativeFacts = {
  state: 'loading' | 'ready' | 'error'
  meta: { version: string; shell: string; userDataDir: string } | null
  protectedSecrets: boolean | null
  error: string | null
}

function inheritedValue(key: SettingKey, settings: AppSettings): string | undefined {
  if (key === 'editorFontFamily' && settings.editorFontFamily === null) return effectiveEditorFontFamily(settings) || 'Default monospace stack'
  if (key === 'editorFontSize' && settings.editorFontSize === null) return `${effectiveEditorFontSize(settings)}px from Terminal`
  if (key === 'diffFontFamily' && settings.diffFontFamily === null) return effectiveDiffFontFamily(settings) || 'Default monospace stack'
  if (key === 'diffFontSize' && settings.diffFontSize === null) return `${effectiveDiffFontSize(settings)}px from Editor`
  return undefined
}

function navigateRadioCards(event: KeyboardEvent<HTMLDivElement>): void {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  const cards = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)')]
  const current = cards.findIndex((card) => card === event.target)
  if (current < 0) return
  event.preventDefault()
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? cards.length - 1
    : (current + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + cards.length) % cards.length
  cards[index]?.focus()
  cards[index]?.click()
}

function TerminalPalette({ value, disabled, onChange }: { value: TerminalThemeName; disabled: boolean; onChange(value: TerminalThemeName): void }) {
  return (
    <div className="settings-theme-grid" role="radiogroup" aria-label="Terminal palette" aria-busy={disabled} onKeyDown={navigateRadioCards}>
      {TERMINAL_THEME_NAMES.map((id) => {
        const theme = TERMINAL_THEMES[id]
        return (
          <button type="button" role="radio" aria-checked={value === id} tabIndex={value === id ? 0 : -1} disabled={disabled} key={id} className={`settings-theme-card${value === id ? ' is-active' : ''}`} onClick={() => onChange(id)}>
            <span className="settings-theme-swatch" style={{ background: theme.swatch[0] }} aria-hidden="true">
              {theme.swatch.slice(1).map((color) => <i key={color} style={{ background: color }} />)}
            </span>
            <span>{theme.label}</span>
          </button>
        )
      })}
    </div>
  )
}

function AppearanceTheme({
  metadata,
  control,
  value,
  disabled,
  onChange
}: {
  metadata: SettingMetadata
  control: Extract<SettingControl, { type: 'select' }>
  value: AppSettings['theme']
  disabled: boolean
  onChange(patch: Partial<AppSettings>): void
}) {
  return (
    <div className="settings-appearance-grid" role="radiogroup" aria-label={metadata.label} aria-busy={disabled} onKeyDown={navigateRadioCards}>
      {control.options.map((option) => {
        const id = String(option.value)
        return (
          <button type="button" role="radio" aria-checked={value === option.value} tabIndex={value === option.value ? 0 : -1} disabled={disabled} key={id} className={`settings-appearance-card${value === option.value ? ' is-active' : ''}`} onClick={() => onChange(validateSettingsPatch({ theme: option.value }))}>
            <span className={`settings-appearance-preview settings-appearance-preview-${id}`} aria-hidden="true"><i /><i /><i /></span>
            <span>{id === 'system' ? 'System' : id === 'dark' ? 'Dark' : 'Light'}</span>
          </button>
        )
      })}
    </div>
  )
}

function SettingControlView({
  metadata,
  settings,
  revision,
  agents,
  onCommit
}: {
  metadata: SettingMetadata
  settings: AppSettings
  revision: number
  agents: readonly AgentPreset[]
  onCommit(patch: Partial<AppSettings>): Promise<void>
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [failedPatch, setFailedPatch] = useState<Partial<AppSettings> | null>(null)
  const control = metadata.control
  const value = settings[metadata.key]
  const availableAgents = agents.filter((agent) => agent.available)

  const commitChoice = async (patch: Partial<AppSettings>): Promise<void> => {
    if (saving) return
    setSaving(true)
    setError(null)
    setFailedPatch(null)
    try {
      await onCommit(patch)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setFailedPatch(patch)
    } finally {
      setSaving(false)
    }
  }

  if (metadata.key === 'keyboardShortcutOverrides') {
    return <ShortcutEditor settings={settings} revision={revision} onCommit={onCommit} />
  }
  if (control.type === 'text' || control.type === 'number') {
    return (
      <div className="settings-control-stack">
        <SettingsDraftInput metadata={metadata} control={control} value={value} revision={revision} onCommit={onCommit} />
        {metadata.key === 'agentCommand' && availableAgents.length > 0 && (
          <div className="settings-agent-suggestions" aria-label="Discovered agent commands">
            <span>Installed harnesses</span>
            <div>
              {availableAgents.map((agent) => (
                <button
                  type="button"
                  key={agent.id}
                  disabled={saving}
                  className={settings.agentCommand === agent.command ? 'is-active' : ''}
                  title={agent.executablePath}
                  onClick={() => void commitChoice(validateSettingsPatch({ agentCommand: agent.command }))}
                >
                  {agent.name}
                </button>
              ))}
            </div>
          </div>
        )}
        {saving && <span className="settings-save-status" role="status">Saving preference…</span>}
        {error && (
          <div className="settings-inline-error" role="alert">
            <span>{error}</span>
            {failedPatch && <button type="button" disabled={saving} onClick={() => void commitChoice(failedPatch)}>Retry</button>}
          </div>
        )}
      </div>
    )
  }

  let rendered: React.ReactNode
  if (metadata.key === 'theme' && control.type === 'select') {
    rendered = <AppearanceTheme metadata={metadata} control={control} value={settings.theme} disabled={saving} onChange={(patch) => void commitChoice(patch)} />
  } else if (metadata.key === 'terminalTheme') {
    rendered = <TerminalPalette value={settings.terminalTheme} disabled={saving} onChange={(next) => void commitChoice(validateSettingsPatch({ terminalTheme: next }))} />
  } else if (control.type === 'toggle') {
    if (typeof value !== 'boolean') return <SettingsState kind="error" title="Invalid setting definition" detail={metadata.key} />
    rendered = <SettingsSwitch checked={value} label={metadata.label} disabled={saving} onChange={(next) => void commitChoice(validateSettingsPatch({ [metadata.key]: next }))} />
  } else if (control.type === 'select') {
    rendered = <SettingsSelect metadata={metadata} value={value} control={control} disabled={saving} onChange={(patch) => void commitChoice(patch)} />
  } else {
    return <SettingsState kind="error" title="Unsupported setting control" detail={metadata.key} />
  }

  return (
    <div className="settings-choice-control" aria-busy={saving}>
      {rendered}
      {saving && <span className="settings-save-status" role="status">Saving preference…</span>}
      {error && (
        <div className="settings-inline-error" role="alert">
          <span>{error}</span>
          {failedPatch && <button type="button" disabled={saving} onClick={() => void commitChoice(failedPatch)}>Retry</button>}
        </div>
      )}
    </div>
  )
}

function SettingsList({
  metadata,
  settings,
  revision,
  resettingKey,
  onCommit,
  onReset
}: {
  metadata: readonly SettingMetadata[]
  settings: AppSettings
  revision: number
  resettingKey: SettingKey | null
  onCommit(patch: Partial<AppSettings>): Promise<void>
  onReset(key: SettingKey): void
}) {
  const agents = useAppStore((state) => state.agents)
  return (
    <div className="settings-list">
      {metadata.map((item) => (
        <SettingsField
          key={item.key}
          metadata={item}
          current={settings[item.key]}
          inheritedValue={inheritedValue(item.key, settings)}
          resetting={resettingKey === item.key}
          onReset={() => {
            if (resettingKey === null) onReset(item.key)
          }}
        >
          <SettingControlView metadata={item} settings={settings} revision={revision} agents={agents} onCommit={onCommit} />
        </SettingsField>
      ))}
    </div>
  )
}

function PrivacySection({ facts, onRetry }: { facts: NativeFacts; onRetry(): void }) {
  if (facts.state === 'loading') return <SettingsState kind="loading" title="Checking native protections" detail="Reading this device’s credential capability." />
  if (facts.state === 'error') return <SettingsState kind="error" title="Native capability check failed" detail={facts.error ?? undefined} action={<button className="btn btn-secondary" type="button" onClick={onRetry}>Retry check</button>} />
  return (
    <div className="settings-security-wrap">
      <div className="settings-policy-note" role="note">
        <strong>Security boundaries are fixed, not optional preferences.</strong>
        <span>This app does not offer switches that weaken workspace confinement, renderer isolation, browser sandboxing, or provider consent.</span>
      </div>
      <div className="settings-security-grid">
        <article className="settings-security-card"><span className="settings-security-status">Enforced</span><h3>Renderer isolation</h3><p>The interface is sandboxed and context-isolated. Native access is limited to the typed <code>window.donwells</code> bridge.</p></article>
        <article className="settings-security-card"><span className="settings-security-status">Confined</span><h3>Workspace files</h3><p>File operations pass through native handlers and stay confined to the selected worktree.</p></article>
        <article className="settings-security-card"><span className="settings-security-status">Sandboxed</span><h3>Browser content</h3><p>Persistent browser guests accept HTTP(S) content without exposing Electron or Node.js APIs.</p></article>
        <article className="settings-security-card"><span className={`settings-security-status${facts.protectedSecrets ? '' : ' is-muted'}`}>{facts.protectedSecrets ? 'Available' : 'Unavailable'}</span><h3>Protected credentials</h3><p>{facts.protectedSecrets ? 'This device can encrypt native service secrets. Stored values are never displayed in Settings.' : 'Operating-system secret protection is not available in this environment.'}</p></article>
        <article className="settings-security-card settings-security-card-wide"><span className="settings-security-status">Required</span><h3>Provider consent</h3><p>No preference on this screen can bypass confirmation for provider calls, permission grants or other consequential actions.</p></article>
      </div>
    </div>
  )
}

function AdvancedFacts({ facts, onRetry }: { facts: NativeFacts; onRetry(): void }) {
  if (facts.state === 'loading') return <SettingsState kind="loading" title="Loading application details" />
  if (facts.state === 'error' || !facts.meta) return <SettingsState kind="error" title="Application details unavailable" detail={facts.error ?? undefined} action={<button className="btn btn-secondary" type="button" onClick={onRetry}>Retry</button>} />
  return (
    <section className="settings-about" aria-labelledby="settings-about-title">
      <div><h3 id="settings-about-title">donwells.ai</h3><span>Version {facts.meta.version}</span></div>
      <dl>
        <div><dt>Shell</dt><dd>{facts.meta.shell || 'System default'}</dd></div>
        <div><dt>App data</dt><dd title={facts.meta.userDataDir}>{facts.meta.userDataDir}</dd></div>
      </dl>
      <button className="btn btn-secondary btn-sm" type="button" onClick={onRetry}>Refresh details</button>
    </section>
  )
}

function ResetAlert({ confirmation, busy, error, onCancel, onConfirm }: { confirmation: ResetConfirmation; busy: boolean; error: string | null; onCancel(): void; onConfirm(): void }) {
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    panelRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [])
  const subject = confirmation.kind === 'all' ? 'all settings' : `${confirmation.label} settings`
  return (
    <div className="settings-confirm-layer">
      <div
        ref={panelRef}
        className="settings-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="settings-confirm-title"
        aria-describedby="settings-confirm-description"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) {
            event.preventDefault()
            event.stopPropagation()
            onCancel()
            return
          }
          if (event.key !== 'Tab') return
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
          if (buttons.length === 0) return
          const active = document.activeElement
          const index = active instanceof HTMLButtonElement ? buttons.indexOf(active) : -1
          const next = event.shiftKey ? (index <= 0 ? buttons.length - 1 : index - 1) : (index === buttons.length - 1 ? 0 : index + 1)
          event.preventDefault()
          buttons[next]?.focus()
        }}
      >
        <span className="settings-confirm-eyebrow">Reset preferences</span>
        <h2 id="settings-confirm-title">Reset {subject}?</h2>
        <p id="settings-confirm-description">This restores canonical defaults. Open sessions keep settings whose lifecycle begins with a new terminal or session.</p>
        {error && <div className="settings-inline-error" role="alert"><span>{error}</span></div>}
        <div className="settings-confirm-actions">
          <button className="btn btn-secondary" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
          <button className="btn btn-danger" type="button" disabled={busy} onClick={onConfirm}>{busy ? 'Resetting…' : `Reset ${subject}`}</button>
        </div>
      </div>
    </div>
  )
}

export function SettingsModal({ open }: { open: boolean }) {
  const settings = useAppStore((state) => state.settings)
  const revision = useAppStore((state) => state.settingsRevision)
  const section = useAppStore((state) => state.settingsSection)
  const setOpen = useAppStore((state) => state.setSettingsOpen)
  const setSettings = useAppStore((state) => state.setSettings)
  const syncSettings = useAppStore((state) => state.syncSettings)
  const [query, setQuery] = useState('')
  const [confirmation, setConfirmation] = useState<ResetConfirmation | null>(null)
  const [resettingKey, setResettingKey] = useState<SettingKey | null>(null)
  const [resetBusy, setResetBusy] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)
  const [draftGuardError, setDraftGuardError] = useState<string | null>(null)
  const [facts, setFacts] = useState<NativeFacts>({ state: 'loading', meta: null, protectedSecrets: null, error: null })
  const resetTrigger = useRef<HTMLButtonElement | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const searchGroups = useMemo(() => searchSettingsCatalog(query), [query])
  const activePresentation = SETTINGS_SECTION_PRESENTATION.find((item) => item.id === section) ?? SETTINGS_SECTION_PRESENTATION[0]!
  const searchModifier = appCommandPlatform(navigator.platform) === 'mac' ? '⌘' : 'Ctrl+'

  const loadFacts = useCallback((): void => {
    setFacts({ state: 'loading', meta: null, protectedSecrets: null, error: null })
    void Promise.all([window.donwells.meta(), window.donwells.secretAvailable()]).then(
      ([meta, protectedSecrets]) => setFacts({ state: 'ready', meta, protectedSecrets, error: null }),
      (caught: unknown) => setFacts({ state: 'error', meta: null, protectedSecrets: null, error: caught instanceof Error ? caught.message : String(caught) })
    )
  }, [])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setResetError(null)
    setDraftGuardError(null)
    loadFacts()
  }, [loadFacts, open])

  useEffect(() => {
    if (!confirmation) resetTrigger.current?.focus()
  }, [confirmation])

  const commit = async (patch: Partial<AppSettings>): Promise<void> => {
    const result = await setSettings(patch)
    if (!result.ok) throw new Error(result.error)
  }

  const reset = async (request: SettingsResetRequest): Promise<void> => {
    const expectedRevision = useAppStore.getState().settingsRevision
    const applied = await resetSettingsAtRevision({
      request,
      revision: expectedRevision,
      reset: (target) => window.donwells.resetSettings(target),
      currentRevision: () => useAppStore.getState().settingsRevision,
      sync: syncSettings
    })
    if (!applied) throw new Error('Settings changed while the reset was in flight. Nothing was overwritten; review the current values and retry.')
  }

  const resetOne = async (key: SettingKey): Promise<void> => {
    setResettingKey(key)
    setResetError(null)
    try {
      await reset({ keys: [key] })
    } catch (caught) {
      setResetError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setResettingKey(null)
    }
  }

  const confirmReset = async (): Promise<void> => {
    if (!confirmation || resetBusy) return
    setResetBusy(true)
    setResetError(null)
    try {
      await reset(confirmation.kind === 'all' ? { keys: SETTINGS_METADATA.map((item) => item.key) } : { section: confirmation.section })
      setConfirmation(null)
    } catch (caught) {
      setResetError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setResetBusy(false)
    }
  }

  if (!open) return null
  const sectionMetadata = SETTINGS_METADATA.filter((item) => item.section === section)

  const focusDirtyControl = (): boolean => {
    const dirty = document.querySelector<HTMLElement>('[data-settings-dirty="true"]')
    if (!dirty) {
      setDraftGuardError(null)
      return false
    }
    setDraftGuardError('Apply or discard the highlighted change before leaving this settings view.')
    dirty.querySelector<HTMLElement>('input, button')?.focus()
    return true
  }

  const close = (): void => {
    if (confirmation) {
      if (!resetBusy) setConfirmation(null)
      return
    }
    if (focusDirtyControl()) return
    setOpen(false)
  }

  const openSection = (target: SettingsSection): void => {
    if (focusDirtyControl()) return
    setQuery('')
    useAppStore.getState().openSettings(target)
  }

  const renderSectionContent = (target: SettingsSection, metadata: readonly SettingMetadata[]): React.ReactNode => {
    if (target === 'privacy') return <PrivacySection facts={facts} onRetry={loadFacts} />
    return (
      <>
        {metadata.length > 0 ? <SettingsList metadata={metadata} settings={settings} revision={revision} resettingKey={resettingKey} onCommit={commit} onReset={(key) => void resetOne(key)} /> : <SettingsState kind="empty" title="No preferences in this section" />}
        {target === 'agents' && <><ProjectToolsSettings onNavigate={route => {
          if (focusDirtyControl()) return
          const state = useAppStore.getState(), path = state.activeWorktreePath
          if (!path) return
          if (route === 'search') useAppStore.setState({ contentSearch: { ...state.contentSearch, source: 'session' } })
          state.openWorkspaceModule(path, route); setOpen(false)
        }} /><SkillsManager /></>}
        {target === 'advanced' && <><ProjectKitSettings /><AdvancedFacts facts={facts} onRetry={loadFacts} /></>}
      </>
    )
  }

  return (
    <ModalDialog className="modal settings-modal" labelledBy="settings-title" onClose={close}>
      <div className="settings-workspace" onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
          event.preventDefault()
          if (!focusDirtyControl()) searchInput.current?.focus()
        }
      }}>
        <header className="settings-header">
          <div className="settings-header-title"><h1 id="settings-title">Settings</h1></div>
          <label className="settings-search">
            <Icon name="search" size={15} />
            <span className="sr-only">Search settings</span>
            <input
              ref={searchInput}
              autoFocus
              value={query}
              placeholder="Search settings and commands"
              onChange={(event) => {
                if (!focusDirtyControl()) setQuery(event.currentTarget.value)
              }}
            />
            {query && <button type="button" aria-label="Clear settings search" onClick={() => setQuery('')}><Icon name="x" size={13} /></button>}
            <kbd>{searchModifier}F</kbd>
          </label>
          <button className="icon-btn settings-close" type="button" aria-label="Close settings" onClick={close}><Icon name="x" size={15} /></button>
        </header>
        <div className="settings-layout">
          <nav
            className="settings-nav"
            aria-label="Settings sections"
            onKeyDown={(event) => {
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
              const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.settings-nav-item')]
              const active = document.activeElement
              const current = active instanceof HTMLButtonElement ? buttons.indexOf(active) : -1
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (current + 1) % buttons.length : (current <= 0 ? buttons.length - 1 : current - 1)
              event.preventDefault()
              buttons[next]?.focus()
            }}
          >
            <div className="settings-nav-list">
              {SETTINGS_SECTION_PRESENTATION.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={`settings-nav-item${section === item.id && !query ? ' is-active' : ''}`}
                  aria-current={section === item.id && !query ? 'page' : undefined}
                  onClick={() => openSection(item.id)}
                >
                  <Icon name={item.icon} size={16} /><span>{item.label}</span>
                </button>
              ))}
            </div>
            <div className="settings-nav-footer">
              <button
                type="button"
                onClick={(event) => {
                  if (focusDirtyControl()) return
                  resetTrigger.current = event.currentTarget
                  setResetError(null)
                  setConfirmation({ kind: 'all' })
                }}
              >Reset all</button>
            </div>
          </nav>
          <main className="settings-content" aria-live="polite">
            {draftGuardError && (
              <div className="settings-callout settings-callout-warning" role="alert">
                <strong>Unsaved setting</strong>
                <span>{draftGuardError}</span>
                <button type="button" onClick={() => focusDirtyControl()}>Review change</button>
              </div>
            )}
            {query ? (
              <div className="settings-search-results">
                <div className="settings-section-heading"><div><span>Search</span><h2>{searchGroups.length === 0 ? 'No matching settings' : `Results for “${query}”`}</h2><p>{searchGroups.length === 0 ? 'Try a setting name, description, section or command.' : `${searchGroups.reduce((count, group) => count + Math.max(group.settings.length, 1), 0)} results across ${searchGroups.length} sections.`}</p></div></div>
                {searchGroups.length === 0 ? <SettingsState kind="empty" title="Nothing matched your search" detail="Search includes setting names, descriptions, routes and application commands." action={<button className="btn btn-secondary" type="button" onClick={() => setQuery('')}>Clear search</button>} /> : searchGroups.map((group) => (
                  <section className="settings-result-group" key={group.section.id}>
                    <button type="button" className="settings-result-route" onClick={() => openSection(group.section.id)}><Icon name={group.section.icon} size={14} /><span>{group.section.label}</span><Icon name="chevrons" size={12} /></button>
                    {renderSectionContent(group.section.id, group.settings)}
                  </section>
                ))}
              </div>
            ) : (
              <div className="settings-section">
                <div className="settings-section-heading">
                  <div><h2>{activePresentation.label}</h2><p>{activePresentation.description}</p></div>
                  {sectionMetadata.length > 0 && (
                    <button className="btn btn-secondary" type="button" onClick={(event) => {
                      if (focusDirtyControl()) return
                      resetTrigger.current = event.currentTarget
                      setResetError(null)
                      setConfirmation({ kind: 'section', section, label: activePresentation.label })
                    }}>Reset section</button>
                  )}
                </div>
                {resetError && !confirmation && <div className="settings-callout settings-callout-error" role="alert"><strong>Could not reset settings</strong><span>{resetError}</span></div>}
                {renderSectionContent(section, sectionMetadata)}
              </div>
            )}
          </main>
        </div>
        {confirmation && <ResetAlert confirmation={confirmation} busy={resetBusy} error={resetError} onCancel={() => setConfirmation(null)} onConfirm={() => void confirmReset()} />}
      </div>
    </ModalDialog>
  )
}
