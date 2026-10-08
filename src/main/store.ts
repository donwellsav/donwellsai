import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import {
  SETTING_DEFINITIONS,
  SETTINGS_SCHEMA_VERSION,
  resolveSettings,
  settingsKeysForSection,
  sparseSettings,
  validateSettingsPatch,
  validateSettingsResetRequest
} from '@shared/settings'
import type { AppSettings, PersistedState, Repo, SettingKey, SettingsResetRequest } from '@shared/types'

const FILE = 'donwells-data.json'

const LEGACY_DEFAULT_SETTINGS: Record<string, unknown> = {
  theme: 'dark',
  fontSize: 13,
  fontFamily: '',
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 10000,
  copyOnSelect: false,
  terminalTheme: 'tomorrow-night',
  editorWordWrap: 'off',
  editorMinimap: false,
  editorTabSize: 4,
  markdownPreviewDefault: false,
  statusPollMs: 5000
}

const LEGACY_SETTING_KEYS: Record<string, true> = {
  // Accepted because a schema-v1 envelope may carry it; it is the provider
  // migration's source, so it is tolerated here and carried forward to disk
  // rather than mapped into the current settings shape.
  agentCommand: true,
  theme: true,
  fontSize: true,
  fontFamily: true,
  cursorStyle: true,
  cursorBlink: true,
  scrollback: true,
  copyOnSelect: true,
  terminalTheme: true,
  editorWordWrap: true,
  editorMinimap: true,
  editorTabSize: true,
  markdownPreviewDefault: true,
  statusPollMs: true
}

export type StoreLoadErrorKind = 'corrupt' | 'unsupported-schema' | 'read'

export class StoreLoadError extends Error {
  readonly kind: StoreLoadErrorKind
  readonly path: string

  constructor(kind: StoreLoadErrorKind, path: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'StoreLoadError'
    this.kind = kind
    this.path = path
  }
}

type LoadedState = { state: PersistedState; migrated: boolean }


function validateRepos(value: unknown, path: string): Repo[] {
  if (!Array.isArray(value)) throw new StoreLoadError('corrupt', path, 'Persisted repos must be an array')
  for (const repo of value) {
    if (typeof repo !== 'object' || repo === null || Array.isArray(repo)) {
      throw new StoreLoadError('corrupt', path, 'Persisted repo must be an object')
    }
    if ('taskAuthority' in repo && repo.taskAuthority !== undefined && repo.taskAuthority !== 'backlog.md') throw new StoreLoadError('corrupt', path, 'Invalid project task authority')
    if (!('id' in repo) || typeof repo.id !== 'string'
      || !('path' in repo) || typeof repo.path !== 'string'
      || !('addedAt' in repo) || typeof repo.addedAt !== 'string') {
      throw new StoreLoadError('corrupt', path, 'Persisted repo fields are invalid')
    }
  }
  return structuredClone(value)
}

function validateOptionalOwnedState(envelope: Record<string, unknown>, path: string): void {
  const retiredNames = envelope.retiredNames
  if (retiredNames !== undefined) {
    if (typeof retiredNames !== 'object' || retiredNames === null || Array.isArray(retiredNames)) {
      throw new StoreLoadError('corrupt', path, 'Persisted retired names must be an object')
    }
    for (const names of Object.values(retiredNames)) {
      if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) {
        throw new StoreLoadError('corrupt', path, 'Persisted retired names are invalid')
      }
    }
  }

  const lineage = envelope.worktreeLineage
  if (lineage !== undefined) {
    if (typeof lineage !== 'object' || lineage === null || Array.isArray(lineage)) {
      throw new StoreLoadError('corrupt', path, 'Persisted worktree lineage must be an object')
    }
    for (const branches of Object.values(lineage)) {
      if (typeof branches !== 'object' || branches === null || Array.isArray(branches)
        || Object.values(branches).some((base) => typeof base !== 'string')) {
        throw new StoreLoadError('corrupt', path, 'Persisted worktree lineage is invalid')
      }
    }
  }

  const workspaceSession = envelope.workspaceSession
  if (workspaceSession !== undefined
    && (typeof workspaceSession !== 'object' || workspaceSession === null || Array.isArray(workspaceSession))) {
    throw new StoreLoadError('corrupt', path, 'Persisted workspace session must be an object')
  }
}

function migrateLegacySettings(value: unknown, path: string): Partial<AppSettings> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StoreLoadError('corrupt', path, 'Persisted settings must be an object')
  }
  const legacy = value as Record<string, unknown>
  for (const key of Object.keys(legacy)) {
    if (!Object.hasOwn(LEGACY_SETTING_KEYS, key)) {
      throw new StoreLoadError('corrupt', path, `Unknown legacy setting: ${key}`)
    }
  }
  const effective = { ...LEGACY_DEFAULT_SETTINGS, ...legacy }
  if (effective.theme !== 'dark') {
    throw new StoreLoadError('corrupt', path, 'Legacy theme must be dark')
  }
  try {
    return sparseSettings(resolveSettings({
      theme: 'dark',
      terminalFontSize: effective.fontSize,
      terminalFontFamily: effective.fontFamily,
      cursorStyle: effective.cursorStyle,
      cursorBlink: effective.cursorBlink,
      scrollback: effective.scrollback,
      copyOnSelect: effective.copyOnSelect,
      terminalTheme: effective.terminalTheme,
      editorWordWrap: effective.editorWordWrap,
      editorMinimap: effective.editorMinimap,
      editorTabSize: effective.editorTabSize,
      ...(Object.hasOwn(legacy, 'markdownPreviewDefault') ? { markdownPreviewDefault: effective.markdownPreviewDefault } : {}),
      statusPollMs: effective.statusPollMs
    }))
  } catch (error) {
    throw new StoreLoadError('corrupt', path, 'Legacy settings contain an invalid value', error)
  }
}

/**
 * Persists user-owned state in one versioned JSON envelope. Settings stay as
 * sparse overrides; getters resolve them against the canonical defaults.
 */
export class Store {
  /** Absolute path of the backing JSON file (public for tests/tools). */
  readonly path: string
  private state: PersistedState

  constructor(userDataDir?: string) {
    this.path = join(userDataDir ?? app.getPath('userData'), FILE)
    const loaded = this.load()
    if (loaded.migrated) this.writeState(loaded.state)
    this.state = loaded.state
  }

  private load(): LoadedState {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          state: { schemaVersion: SETTINGS_SCHEMA_VERSION, repos: [], settings: {} },
          migrated: false
        }
      }
      throw new StoreLoadError('read', this.path, 'Could not read persisted state', error)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new StoreLoadError('corrupt', this.path, 'Persisted state is not valid JSON', error)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new StoreLoadError('corrupt', this.path, 'Persisted state must be an object')
    }
    const envelope = parsed as Record<string, unknown>
    const schemaVersion = envelope.schemaVersion
    if (!Number.isInteger(schemaVersion)) {
      throw new StoreLoadError('corrupt', this.path, 'Persisted schema version is invalid')
    }
    if (schemaVersion !== 1 && schemaVersion !== SETTINGS_SCHEMA_VERSION) {
      throw new StoreLoadError('unsupported-schema', this.path, `Unsupported persisted schema version: ${String(schemaVersion)}`)
    }

    const repos = validateRepos(envelope.repos, this.path)
    validateOptionalOwnedState(envelope, this.path)
    let migrated = schemaVersion === 1
    let settings: Partial<AppSettings>
    if (schemaVersion === 1) {
      settings = migrateLegacySettings(envelope.settings, this.path)
      // A schema-v1 envelope predates provider instances, so its own command
      // field is not the migration's source and is retired with the envelope.
    } else {
      // This store owns removal of settings retired from its schema.
      // `language` is genuinely retired. `terminalRenderer` was retired by an
      // earlier change and then re-used as the name of a live setting, so it
      // must NOT stay here: doing so deleted the user's renderer choice from the
      // profile on every launch and silently reverted them to the default.
      const RETIRED_AND_REMOVED_HERE = ['language'] as const
      // `agentCommand` is different: the daemon removes it as the provider
      // migration's settings publication, and that migration reads the persisted
      // file. Trimming it here would delete the migration's own source before it
      // could run — this store is constructed before the daemon connects — so it
      // is tolerated in memory and deliberately NOT persisted. The daemon's
      // removal is what takes it off disk.
      const RETIRED_ELSEWHERE = ['agentCommand'] as const
      const settingsRecord = typeof envelope.settings === 'object'
        && envelope.settings !== null
        && !Array.isArray(envelope.settings)
        ? { ...(envelope.settings as Record<string, unknown>) }
        : null
      let settingsInput: unknown = envelope.settings
      if (settingsRecord !== null) {
        for (const key of RETIRED_AND_REMOVED_HERE) {
          if (key in settingsRecord) {
            delete settingsRecord[key]
            migrated = true
          }
        }
        // Dropped from the in-memory view only.  carries whatever the
        // file still holds forward, so the owning authority decides when it goes.
        for (const key of RETIRED_ELSEWHERE) delete settingsRecord[key]
        settingsInput = settingsRecord
      }
      try {
        settings = sparseSettings(resolveSettings(settingsInput))
      } catch (error) {
        throw new StoreLoadError('corrupt', this.path, 'Persisted settings contain an invalid value', error)
      }
    }

    const state = structuredClone(envelope) as PersistedState
    state.schemaVersion = SETTINGS_SCHEMA_VERSION
    state.repos = repos
    state.settings = settings
    return { state, migrated }
  }

  /**
   * The keys in the persisted envelope that this version does not define.
   *
   * Read from disk at write time so a removal performed by the owning authority
   * is honoured rather than undone. A missing or unparseable file yields none:
   * there is nothing to carry forward.
   */
  private foreignSettingsOnDisk(): Record<string, unknown> {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch {
      return {}
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return {}
    }
    if (typeof parsed !== 'object' || parsed === null) return {}
    const settings = (parsed as Record<string, unknown>)['settings']
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return {}
    const foreign: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(settings as Record<string, unknown>)) {
      // Anything this version defines is the store's own business; only the
      // remainder belongs to another authority.
      if (!Object.hasOwn(SETTING_DEFINITIONS, key) && key !== 'language') foreign[key] = value
    }
    return foreign
  }

  /** Write a complete next snapshot before publishing it to in-memory readers. */
  private writeState(next: PersistedState): void {
    const dir = dirname(this.path)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    // Keys owned by another authority are carried through from the CURRENT file
    // rather than from memory: the daemon removes one of them as its migration's
    // publication, and re-adding a stale copy would resurrect it. Reading at
    // write time makes the removal stick without this store having to be told.
    const foreign = this.foreignSettingsOnDisk()
    const serialized = Object.keys(foreign).length === 0
      ? next
      : { ...next, settings: { ...foreign, ...next.settings } }
    let fd: number | undefined
    try {
      fd = openSync(tmp, 'wx', 0o600)
      writeFileSync(fd, `${JSON.stringify(serialized, null, 2)}\n`, 'utf8')
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(tmp, this.path)
    } catch (error) {
      if (fd !== undefined) closeSync(fd)
      rmSync(tmp, { force: true })
      throw error
    }

    if (process.platform !== 'win32') {
      let dirFd: number | undefined
      try {
        dirFd = openSync(dir, 'r')
        fsyncSync(dirFd)
      } catch {
        // Directory fsync is not supported by every Unix filesystem. The file
        // contents were already flushed and atomically renamed above.
      } finally {
        if (dirFd !== undefined) closeSync(dirFd)
      }
    }
  }

  private commit(next: PersistedState): void {
    this.writeState(next)
    this.state = next
  }

  listRepos(): Repo[] {
    return structuredClone(this.state.repos)
  }

  addRepo(repo: Repo): void {
    if (this.state.repos.some((candidate) => candidate.id === repo.id)) return
    const next = structuredClone(this.state)
    next.repos.push(structuredClone(repo))
    this.commit(next)
  }

  /** Publish a fully prepared restore and its layout in one existing state-file commit. */
  addImportedRepo(repo: Repo, workspace: NonNullable<PersistedState['workspaceSession']>['repos'][string]): void {
    if (this.state.repos.some(value => value.id === repo.id || value.path === repo.path)) throw new Error('Restore destination is already registered')
    const next = structuredClone(this.state)
    next.repos.push(repo)
    next.workspaceSession ??= { activeRepoId: null, repos: {} }
    next.workspaceSession.repos[repo.id] = workspace
    this.commit(next)
  }

  setTaskAuthority(repoId: string, enabled: boolean): void {
    if (typeof enabled !== 'boolean') throw new Error('Invalid task authority choice')
    const next = structuredClone(this.state)
    const repo = next.repos.find(repo => repo.id === repoId)
    if (!repo) throw new Error('Project is no longer registered')
    if (enabled) repo.taskAuthority = 'backlog.md'
    else delete repo.taskAuthority
    this.commit(next)
  }

  removeRepo(repoId: string): void {
    const next = structuredClone(this.state)
    next.repos = next.repos.filter((repo) => repo.id !== repoId)
    delete next.retiredNames?.[repoId]
    this.commit(next)
  }

  /** Retired worktree names for a repo (empty set when none). */
  getRetiredNames(repoId: string): Set<string> {
    return new Set(this.state.retiredNames?.[repoId] ?? [])
  }

  /** Monotonic retirement: union the given names into the repo's registry. */
  retireNames(repoId: string, names: Iterable<string>): void {
    const next = structuredClone(this.state)
    if (!next.retiredNames) next.retiredNames = {}
    const retired = new Set(next.retiredNames[repoId] ?? [])
    for (const name of names) retired.add(name)
    next.retiredNames[repoId] = [...retired].sort()
    this.commit(next)
  }

  /** Worktree lineage for a repo (branch → base at creation). */
  getLineage(repoId: string): Record<string, string> {
    return { ...(this.state.worktreeLineage?.[repoId] ?? {}) }
  }

  setLineage(repoId: string, lineage: Record<string, string>): void {
    const next = structuredClone(this.state)
    if (!next.worktreeLineage) next.worktreeLineage = {}
    next.worktreeLineage[repoId] = structuredClone(lineage)
    this.commit(next)
  }

  getWindowState(): PersistedState['windowState'] {
    const value = this.state.windowState
    if (!value || ![value.x, value.y, value.width, value.height].every((part) => Number.isInteger(part) && Math.abs(part) <= 2_147_483_647) ||
      value.width <= 0 || value.height <= 0 || typeof value.maximized !== 'boolean') return undefined
    return { ...value }
  }

  setWindowState(windowState: NonNullable<PersistedState['windowState']>): void {
    this.commit({ ...this.state, windowState: { ...windowState } })
  }

  getWorkspaceSession(): PersistedState['workspaceSession'] {
    return structuredClone(this.state.workspaceSession)
  }

  setWorkspaceSession(workspaceSession: NonNullable<PersistedState['workspaceSession']>): void {
    const next = structuredClone(this.state)
    next.workspaceSession = structuredClone(workspaceSession)
    // Preserve layouts for registered projects not yet loaded by this renderer (including a CLI restore).
    for (const repo of next.repos) {
      const previous = this.state.workspaceSession?.repos[repo.id]
      if (previous && !next.workspaceSession.repos[repo.id]) next.workspaceSession.repos[repo.id] = structuredClone(previous)
    }
    for (const [id, repo] of Object.entries(next.workspaceSession.repos)) {
      const previous = this.state.workspaceSession?.repos[id]
      const backup = previous?.preDockingLayouts ?? (repo.docking ? previous?.layouts ?? repo.layouts : undefined)
      if (backup) repo.preDockingLayouts = structuredClone(backup)
    }
    this.commit(next)
  }

  getSettings(): AppSettings {
    return resolveSettings(this.state.settings)
  }

  updateSettings(patch: unknown): AppSettings {
    const validated = validateSettingsPatch(patch)
    const settings = resolveSettings({ ...this.state.settings, ...validated })
    const next = structuredClone(this.state)
    next.settings = sparseSettings(settings)
    this.commit(next)
    return structuredClone(settings)
  }

  resetSettings(request: SettingsResetRequest): AppSettings {
    const validated = validateSettingsResetRequest(request)
    const keys: readonly SettingKey[] = 'keys' in validated
      ? validated.keys
      : settingsKeysForSection(validated.section)
    if (keys.length === 0) return this.getSettings()

    const overrides = { ...this.state.settings }
    for (const key of keys) delete overrides[key]
    const next = structuredClone(this.state)
    next.settings = sparseSettings(resolveSettings(overrides))
    this.commit(next)
    return this.getSettings()
  }
}

/** Stable id from an absolute path. */
export function idFromPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '').replace(/[^a-zA-Z0-9._/-]/g, '_')
}
