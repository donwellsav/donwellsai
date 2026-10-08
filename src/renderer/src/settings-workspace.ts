import { PROJECT_INTEGRATION_ROLES, PROJECT_TOOL_FIELDS } from '@shared/project-doctor'
import { APP_COMMANDS } from '@shared/app-commands'
import type { AppSettings, SettingsResetRequest, SettingsSection } from '@shared/types'
import { SETTINGS_METADATA, settingsKeysForSection } from '@shared/settings'
import type { SettingMetadata } from '@shared/settings'

export type SettingsSectionPresentation = {
  id: SettingsSection
  label: string
  description: string
  icon: 'robot' | 'file' | 'git' | 'globe' | 'eye' | 'terminal' | 'command' | 'shield' | 'dir' | 'gear'
}

export const SETTINGS_SECTION_PRESENTATION: readonly SettingsSectionPresentation[] = Object.freeze([
  { id: 'project', label: 'Project configuration', description: 'Optional capabilities and data for your current project.', icon: 'dir' },
  { id: 'agents', label: 'Agents', description: 'Launch defaults and agent session behavior.', icon: 'robot' },
  { id: 'editor', label: 'Editor', description: 'Editing, saving, Markdown and inherited typography.', icon: 'file' },
  { id: 'source-control', label: 'Git', description: 'Git source control, diff presentation and inherited typography.', icon: 'git' },
  { id: 'browser', label: 'Browser & Media', description: 'Browser defaults, document viewers and site storage kept separate for each checkout.', icon: 'globe' },
  { id: 'appearance', label: 'Appearance', description: 'Customize the interface and workspace layout.', icon: 'eye' },
  { id: 'terminal', label: 'Terminal', description: 'Palette, typography, cursor and scrollback.', icon: 'terminal' },
  { id: 'shortcuts', label: 'Keyboard Shortcuts', description: 'Application commands and conflict-safe overrides.', icon: 'command' },
  { id: 'privacy', label: 'Privacy & Security', description: 'Browsing history, local data and external agent access.', icon: 'shield' },
  { id: 'advanced', label: 'Advanced', description: 'Status polling, profile memory storage and application diagnostics.', icon: 'gear' }
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
const PROJECT_SEARCH_TEXT = [...PROJECT_INTEGRATION_ROLES.map(role => `${role.id} ${role.name}`), ...Object.values(PROJECT_TOOL_FIELDS), 'skills backup restore'].join(' ').toLocaleLowerCase()
const SHORTCUT_SEARCH_TEXT = APP_COMMANDS.map((command) => `${command.label} ${command.id} ${command.category}`).join(' ').toLocaleLowerCase()
export function searchSettingsCatalog(query: string): readonly SettingsSearchGroup[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return []
  const groups: SettingsSearchGroup[] = []
  for (const group of SETTINGS_SEARCH_GROUPS) {
    const { section, settings: sectionSettings } = group
    const commandMatches = section.id === 'shortcuts' && SHORTCUT_SEARCH_TEXT.includes(normalized)
    const sectionMatches = commandMatches || (section.id === 'project' && PROJECT_SEARCH_TEXT.includes(normalized)) || `${section.label} ${section.description} ${section.id}`.toLocaleLowerCase().includes(normalized)
    const matchingSettings = sectionMatches
      ? sectionSettings
      : sectionSettings.filter((metadata) => `${metadata.label} ${metadata.description} ${metadata.key}`.toLocaleLowerCase().includes(normalized))
    if (matchingSettings.length > 0 || sectionMatches) {
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
  currentSettings,
  sync
}: {
  request: SettingsResetRequest
  revision: number
  reset(request: SettingsResetRequest): Promise<AppSettings>
  currentRevision(): number
  currentSettings(): AppSettings
  sync(settings: AppSettings): void
}): Promise<boolean> {
  const settings = await reset(request)
  if (currentRevision() !== revision) {
    const current = currentSettings()
    const keys = 'keys' in request ? request.keys : settingsKeysForSection(request.section)
    return keys.every(key => JSON.stringify(current[key]) === JSON.stringify(settings[key]))
  }
  sync(settings)
  return true
}
