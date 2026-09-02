import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppSettings, PersistedState, Repo } from '@shared/types'

const FILE = 'orca-lite-data.json'
export const DEFAULT_SETTINGS: AppSettings = {
  agentCommand: 'codex',
  theme: 'dark',
  fontSize: 13,
  statusPollMs: 5000
}
const DEFAULT_STATE: PersistedState = {
  schemaVersion: 1,
  repos: [],
  settings: { agentCommand: 'codex' }
}

/**
 * Lite persistence: one JSON file in userData, atomic rename writes.
 * Deliberately stores only user intent (added repos, settings) — all worktree
 * state is derived live from git, mirroring Orca's "filesystem is truth" model.
 */
export class Store {
  /** Absolute path of the backing JSON file (public for tests/tools). */
  readonly path: string
  private state: PersistedState

  constructor(userDataDir?: string) {
    this.path = join(userDataDir ?? app.getPath('userData'), FILE)
    this.state = this.load()
  }

  private load(): PersistedState {
    try {
      const raw = readFileSync(this.path, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.repos)) return structuredClone(DEFAULT_STATE)
      return { ...structuredClone(DEFAULT_STATE), ...parsed }
    } catch {
      return structuredClone(DEFAULT_STATE)
    }
  }

  /** Atomic-ish save: write temp file then rename over target. */
  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8')
    renameSync(tmp, this.path)
  }

  listRepos(): Repo[] {
    return this.state.repos
  }

  addRepo(repo: Repo): void {
    if (this.state.repos.some((r) => r.id === repo.id)) return
    this.state.repos.push(repo)
    this.save()
  }

  removeRepo(repoId: string): void {
    this.state.repos = this.state.repos.filter((r) => r.id !== repoId)
    delete this.state.retiredNames?.[repoId]
    this.save()
  }

  /** Retired worktree names for a repo (empty set when none). */
  getRetiredNames(repoId: string): Set<string> {
    return new Set(this.state.retiredNames?.[repoId] ?? [])
  }
  /** Monotonic retirement: union the given names into the repo's registry. */
  retireNames(repoId: string, names: Iterable<string>): void {
    if (!this.state.retiredNames) this.state.retiredNames = {}
    const set = new Set(this.state.retiredNames[repoId] ?? [])
    for (const n of names) set.add(n)
    this.state.retiredNames[repoId] = [...set].sort()
    this.save()
  }

  /** Worktree lineage for a repo (branch → base at creation). */
  getLineage(repoId: string): Record<string, string> {
    return { ...(this.state.worktreeLineage?.[repoId] ?? {}) }
  }

  setLineage(repoId: string, lineage: Record<string, string>): void {
    if (!this.state.worktreeLineage) this.state.worktreeLineage = {}
    this.state.worktreeLineage[repoId] = lineage
    this.save()
  }

  getAgentCommand(): string {
    return this.getSettings().agentCommand
  }

  setAgentCommand(command: string): void {
    this.state.settings.agentCommand = command
    this.save()
  }

  getSettings(): AppSettings {
    return { ...DEFAULT_SETTINGS, ...this.state.settings }
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.state.settings = { ...this.getSettings(), ...patch }
    this.save()
    return this.state.settings as AppSettings
  }
}

/** Stable id from an absolute path. */
export function idFromPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '').replace(/[^a-zA-Z0-9._/-]/g, '_')
}