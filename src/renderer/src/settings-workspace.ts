import { APP_COMMANDS } from '@shared/app-commands'
import type { AppSettings, SettingsResetRequest, SettingsSection } from '@shared/types'
import { SETTINGS_METADATA } from '@shared/settings'
import type { SettingMetadata } from '@shared/settings'

export type SettingsSectionPresentation = {
  id: SettingsSection
  label: string
  description: string
  icon: 'robot' | 'file' | 'git' | 'globe' | 'eye' | 'terminal' | 'bolt' | 'activity' | 'check' | 'gear'
}

export const SETTINGS_SECTION_PRESENTATION: readonly SettingsSectionPresentation[] = Object.freeze([
  { id: 'agents', label: 'Agents', description: 'Launch defaults and agent session behavior.', icon: 'robot' },
  { id: 'editor', label: 'Editor', description: 'Editing, saving, Markdown and inherited typography.', icon: 'file' },
  { id: 'source-control', label: 'Source Control', description: 'Diff presentation and inherited typography.', icon: 'git' },
  { id: 'browser', label: 'Browser & Media', description: 'Sandboxed browser defaults and document viewers.', icon: 'globe' },
  { id: 'appearance', label: 'Appearance', description: 'Theme and application interface scale.', icon: 'eye' },
  { id: 'terminal', label: 'Terminal', description: 'Palette, typography, cursor and scrollback.', icon: 'terminal' },
  { id: 'shortcuts', label: 'Keyboard Shortcuts', description: 'Application commands and conflict-safe overrides.', icon: 'bolt' },
  { id: 'notifications', label: 'Notifications', description: 'Local activity and attention indicators.', icon: 'activity' },
  { id: 'privacy', label: 'Privacy & Security', description: 'Fixed renderer, browser and credential protections.', icon: 'check' },
  { id: 'advanced', label: 'Advanced', description: 'Status polling and application diagnostics.', icon: 'gear' }
])

export type SettingsSearchGroup = {
  section: SettingsSectionPresentation
  settings: readonly SettingMetadata[]
}

const SETTINGS_SEARCH_GROUPS: readonly SettingsSearchGroup[] = Object.freeze(
  SETTINGS_SECTION_PRESENTATION.map((section) => ({
    section,
    settings: SETTINGS_METADATA.filter((metadata) => metadata.section === section.id)
  }))
)
const SHORTCUT_SEARCH_TEXT = APP_COMMANDS.map((command) => `${command.label} ${command.id} ${command.category}`).join(' ').toLocaleLowerCase()
export function searchSettingsCatalog(query: string): readonly SettingsSearchGroup[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return []
  const groups: SettingsSearchGroup[] = []
  for (const group of SETTINGS_SEARCH_GROUPS) {
    const { section, settings: sectionSettings } = group
    const commandMatches = section.id === 'shortcuts' && SHORTCUT_SEARCH_TEXT.includes(normalized)
    const sectionMatches = commandMatches || `${section.label} ${section.description} ${section.id}`.toLocaleLowerCase().includes(normalized)
    const matchingSettings = sectionMatches
      ? sectionSettings
      : sectionSettings.filter((metadata) => `${metadata.label} ${metadata.description} ${metadata.key}`.toLocaleLowerCase().includes(normalized))
    if (matchingSettings.length > 0 || (section.id === 'privacy' && sectionMatches)) {
      groups.push({ section, settings: matchingSettings })
    }
  }
  return groups
}

export async function resetSettingsAtRevision({
  request,
  revision,
  reset,
  currentRevision,
  sync
}: {
  request: SettingsResetRequest
  revision: number
  reset(request: SettingsResetRequest): Promise<AppSettings>
  currentRevision(): number
  sync(settings: AppSettings): void
}): Promise<boolean> {
  const settings = await reset(request)
  if (currentRevision() !== revision) return false
  sync(settings)
  return true
}
