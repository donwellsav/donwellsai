import { ProjectMemoryStorage } from './ProjectMemoryStorage'
import { useProjectMemoryEditor } from '../project-memory-editor'
import { ProjectKitSettings } from './settings/ProjectKitSettings'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { appCommandPlatform } from '@shared/app-commands'
import type { AgentPreset, AppSettings, SettingKey, SettingsResetRequest, SettingsSection } from '@shared/types'
import {
  SETTINGS_METADATA,
  effectiveDiffFontFamily,
  effectiveDiffFontSize,
  effectiveEditorFontFamily,
  effectiveEditorFontSize,
  validateSettingsPatch
} from '@shared/settings'
import type { SettingMetadata } from '@shared/settings'
import { useAppStore } from '../store'
import { resolveTerminalRenderer } from '../terminal-renderer'
import { SETTINGS_SECTION_PRESENTATION, resetSettingsAtRevision, searchSettingsCatalog } from '../settings-workspace'
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
import { PluginMarketplace } from './PluginMarketplace'
import { ProjectToolsSettings } from './settings/ProjectToolsSettings'
import { ProviderInstancesState } from './settings/ProviderInstances'

type ResetConfirmation = { kind: 'section'; section: SettingsSection; label: string } | { kind: 'all' }
type NativeFacts = {
  state: 'loading' | 'ready' | 'error'
  meta: { version: string; shell: string; userDataDir: string } | null
  error: string | null
}

function inheritedValue(key: SettingKey, settings: AppSettings): string | undefined {
  if (key === 'editorFontFamily' && settings.editorFontFamily === null) return effectiveEditorFontFamily(settings) || 'Default monospace stack'
  if (key === 'editorFontSize' && settings.editorFontSize === null) return `${effectiveEditorFontSize(settings)}px from Terminal`
  if (key === 'diffFontFamily' && settings.diffFontFamily === null) return effectiveDiffFontFamily(settings) || 'Default monospace stack'
  if (key === 'diffFontSize' && settings.diffFontSize === null) return `${effectiveDiffFontSize(settings)}px from Editor`
  return undefined
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
  const ghosttyThemes = useAppStore((state) => state.ghosttyThemes)

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

  if (metadata.key === 'terminalFontWeight' && appCommandPlatform(navigator.platform) === 'mac') {
    return <p role="note">Native Ghostty uses the selected font’s regular face. Numeric font weight applies on Windows and Linux.</p>
  }
  if (metadata.key === 'keyboardShortcutOverrides') {
    return <ShortcutEditor settings={settings} revision={revision} onCommit={onCommit} />
  }
  if (control.type === 'text' || control.type === 'number') {
    return (
      <div className="settings-control-stack">
        <SettingsDraftInput metadata={metadata} control={control} value={value} revision={revision} onCommit={onCommit} />
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
  if (control.type === 'toggle') {
    if (typeof value !== 'boolean') return <SettingsState kind="error" title="Invalid setting definition" detail={metadata.key} />
    rendered = <SettingsSwitch checked={value} label={metadata.label} disabled={saving} onChange={(next) => void commitChoice(validateSettingsPatch({ [metadata.key]: next }))} />
  } else if (control.type === 'select') {
    // Ghostty's catalog lives in the native module, so this list cannot be part
    // of the static descriptor. An empty catalog leaves the app palette alone.
    const options = metadata.key === 'terminalGhosttyTheme'
      ? [{ value: '', label: 'App palette' }, ...ghosttyThemes.map((theme) => ({ value: theme.name, label: theme.name }))]
      : control.options
    rendered = <SettingsSelect metadata={metadata} value={value} control={{ ...control, options }} disabled={saving} onChange={(patch) => void commitChoice(patch)} />
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

/** Settings that only the native Ghostty renderer acts on. */
const FONT_RENDERER_KEYS = new Set(['terminalLigatures', 'terminalFontFeatures', 'terminalFontVariations'])

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
  const nativeTerminal = useAppStore((state) => state.nativeTerminal)
  // Never let a fall back to xterm be silent: explain it beside the control.
  const rendererFallback = resolveTerminalRenderer({
    requested: settings.terminalRenderer,
    nativeAvailable: nativeTerminal.available,
    ...(nativeTerminal.reason === undefined ? {} : { nativeReason: nativeTerminal.reason })
  })
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
          {item.key === 'terminalRenderer' && rendererFallback.fellBack && <p role="note">Terminals are using xterm because Ghostty is unavailable. {rendererFallback.reason}</p>}
          {FONT_RENDERER_KEYS.has(item.key) && rendererFallback.renderer !== 'ghostty' && <p role="note">Applies to the native Ghostty renderer, which is not the active terminal here.</p>}
          {item.key === 'scrollback' && appCommandPlatform(navigator.platform) === 'mac' && <p role="note">Native Ghostty applies this approximate line limit to new surfaces; its separate byte cap can limit history sooner.</p>}
          <SettingControlView metadata={item} settings={settings} revision={revision} agents={agents} onCommit={onCommit} />
        </SettingsField>
      ))}
    </div>
  )
}

function PrivacySection() {
  const worktreePath = useAppStore(state => state.activeWorktreePath)
  const [confirm, setConfirm] = useState<{ kind: 'history' | 'sites'; path?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [cleared, setCleared] = useState('')
  const operation = useRef(false)
  const clear = async () => {
    if (operation.current || !confirm) return
    operation.current = true; setBusy(true); setError('')
    try {
      if (confirm.kind === 'sites') await window.donwells.browserSiteDataClear(confirm.path!)
      else await window.donwells.browserHistoryClear()
      setCleared(confirm.kind === 'sites' ? `Cookies and site data cleared for ${confirm.path}. Open pages can create new data.` : 'Saved browsing history cleared.')
      setConfirm(null)
    } catch (cause) { setError(String(cause)) }
    finally { operation.current = false; setBusy(false) }
  }
  return <section className="settings-preference-group" aria-label="Saved browser data">
    <h3>Saved browser data</h3>
    <h3>Saved browser data</h3>
    <p>Clear saved addresses across this profile. Cookies, website sign-ins and project files are kept.</p>
    <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setError(''); setCleared(''); setConfirm({ kind: 'history' }) }}>Clear browsing history…</button>
    <p>Remove cookies, cached files and website storage for the current checkout’s built-in browser. This can sign you out of websites.</p>
    <button type="button" className="btn btn-secondary btn-sm" disabled={!worktreePath} title={worktreePath ? `Clear browser site data for ${worktreePath}` : 'Select a project checkout first'} onClick={() => { if (worktreePath) { setError(''); setCleared(''); setConfirm({ kind: 'sites', path: worktreePath }) } }}>Clear cookies and site data…</button>
    {cleared && <p role="status">{cleared}</p>}
    {confirm && <ModalDialog labelledBy="clear-browser-data-title" onClose={() => { if (!operation.current) setConfirm(null) }}>
      <h2 id="clear-browser-data-title" className="modal-title">{confirm.kind === 'sites' ? 'Clear cookies and site data?' : 'Clear browsing history?'}</h2>
      {confirm.kind === 'sites' ? <>
        <p>This permanently removes cookies, cached files and website storage for the checkout below. Website sign-ins and locally saved website drafts may be lost. Project files, browsing history and other checkouts are kept.</p>
        <p style={{ overflowWrap: 'anywhere' }}>{confirm.path}</p>
        <p>Open pages can create new data. Save any website work before continuing.</p>
      </> : <p>This permanently deletes saved addresses from this profile. It cannot be undone. New visits will still be saved if history recording is on.</p>}
      {error && <p role="alert">{error}</p>}
      <div className="modal-footer">
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void clear()}>{busy ? 'Clearing…' : confirm.kind === 'sites' ? 'Clear site data permanently' : 'Clear history permanently'}</button>
      </div>
    </ModalDialog>}
  </section>
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
  const [facts, setFacts] = useState<NativeFacts>({ state: 'loading', meta: null, error: null })
  const resetTrigger = useRef<HTMLButtonElement | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const searchGroups = useMemo(() => searchSettingsCatalog(query), [query])
  const activePresentation = SETTINGS_SECTION_PRESENTATION.find((item) => item.id === section) ?? SETTINGS_SECTION_PRESENTATION[0]!
  const searchModifier = appCommandPlatform(navigator.platform) === 'mac' ? '⌘' : 'Ctrl+'

  const loadFacts = useCallback((): void => {
    setFacts({ state: 'loading', meta: null, error: null })
    void window.donwells.meta().then(
      meta => setFacts({ state: 'ready', meta, error: null }),
      (caught: unknown) => setFacts({ state: 'error', meta: null, error: caught instanceof Error ? caught.message : String(caught) })
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
      currentSettings: () => useAppStore.getState().settings,
      sync: syncSettings
    })
    if (!applied) throw new Error('Settings changed while the reset was in flight. Review the current values before retrying.')
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
    const controls = [...dirty.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)')]
    const control = controls.find(item => item.checkVisibility()) ?? controls[0]
    let ancestor: HTMLElement | null = control ?? dirty
    while (ancestor) { if (ancestor instanceof HTMLDetailsElement) ancestor.open = true; ancestor = ancestor.parentElement }
    control?.focus()
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
    if (target === 'appearance' || target === 'terminal') return <>
      {(target === 'appearance' ? [
        ['Theme', ['theme']],
        ['Interface', ['interfaceFont', 'uiScale', 'interfaceDensity', 'interfaceMotion']],
        ['Layout', ['navigationLabels', 'toolPanelSide']]
      ] as const : [
        ['Terminal surface', ['terminalRenderer']],
        ['Text', ['terminalFontFamily', 'terminalFontSize', 'terminalFontWeight', 'terminalLigatures', 'terminalFontFeatures', 'terminalFontVariations', 'terminalLineHeight']],
        ['Colors and cursor', ['terminalTheme', 'terminalGhosttyTheme', 'cursorStyle', 'cursorBlink']],
        ['Behavior', ['scrollback', 'copyOnSelect']]
      ] as const).map(([label, keys]) => {
        const fields = keys.flatMap(key => metadata.filter(field => field.key === key))
        return fields.length > 0 && <section className="settings-preference-group" key={label} aria-label={label}>
          {label !== 'Theme' && <h3>{label}</h3>}
          <SettingsList metadata={fields} settings={settings} revision={revision} resettingKey={resettingKey} onCommit={commit} onReset={key => void resetOne(key)} />
        </section>
      })}
          {!query && target === 'appearance' && <div className="settings-typography-links">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => openSection('editor')}>Editor typography</button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => openSection('terminal')}>Terminal typography</button>
      </div>}
    </>
    return (
      <div className={target === 'privacy' ? 'settings-preference-group' : undefined}>
        {metadata.length > 0 ? <SettingsList metadata={metadata} settings={settings} revision={revision} resettingKey={resettingKey} onCommit={commit} onReset={(key) => void resetOne(key)} /> : null}
        {target === 'project' && <><ProjectToolsSettings key={useAppStore.getState().activeWorktreePath} onNavigate={route => {
          if (focusDirtyControl()) return
          const state = useAppStore.getState(), path = state.activeWorktreePath
          if (!path) return
          if (route === 'search') useAppStore.setState({ contentSearch: { ...state.contentSearch, source: 'session' } })
          state.openWorkspaceModule(path, route); setOpen(false)
        }} /><details className="project-settings-group"><summary>Agent skills</summary><SkillsManager /></details><details className="project-settings-group"><summary>Manage plugins</summary><PluginMarketplace /></details><details className="project-settings-group"><summary>Backup and restore</summary><ProjectKitSettings key={useAppStore.getState().activeWorktreePath} /></details></>}
        {target === 'privacy' && <PrivacySection />}
        {target === 'advanced' && <><ProjectMemoryStorage onChanged={useProjectMemoryEditor.getState().refresh} /><AdvancedFacts facts={facts} onRetry={loadFacts} /></>}
        {target === 'agents' && <ProviderInstancesState />}
      </div>
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
            {query && <button type="button" aria-label="Clear settings search" title="Clear the filter and show all settings" onClick={() => { if (!focusDirtyControl()) setQuery('') }}><Icon name="x" size={13} /></button>}
            <kbd>{searchModifier}F</kbd>
          </label>
          <button className="icon-btn settings-close" type="button" aria-label="Close settings" title="Close settings and return to your workspace" onClick={close}><Icon name="x" size={15} /></button>
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
                {searchGroups.length === 0 ? <SettingsState kind="empty" title="Nothing matched your search" detail="Search includes setting names, descriptions, routes and application commands." action={<button className="btn btn-secondary" type="button" onClick={() => { if (!focusDirtyControl()) setQuery('') }}>Clear search</button>} /> : searchGroups.map((group) => (
                  <section className="settings-result-group" key={group.section.id}>
                    <button type="button" className="settings-result-route" onClick={() => openSection(group.section.id)}><Icon name={group.section.icon} size={14} /><span>{group.section.label}</span><Icon name="chevrons" size={12} /></button>
                    {group.settings.length > 0 && <SettingsList metadata={group.settings} settings={settings} revision={revision} resettingKey={resettingKey} onCommit={commit} onReset={key => void resetOne(key)} />}
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
