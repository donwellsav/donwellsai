import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { logger } from '../../shared/logger'
import { moveToTrash } from '../worktree-trash'
import { PluginManifest, PluginModule, getPluginRegistry } from './plugin-registry'
import type { PluginStateView } from '../../shared/types'

export interface PluginLoaderOptions {
  /** Directory to scan for plugins. */
  pluginDir: string
  /** Recoverable destination for removed plugin folders (R1.4). */
  trashRoot?: string
  /**
   * @deprecated Kept for API compatibility. Activation is now user-consented:
   * a discovered plugin executes only after the user enables it (R1.3).
   */
  autoActivate?: boolean
}

const ACTIVATION_FILE = '.donwells-activation.json'

/** Installable ids become directory names, so they must be plain path segments. */
const SAFE_PLUGIN_ID = /^[A-Za-z0-9._-]+$/

/**
 * Loads plugins from a directory with consent-gated activation.
 *
 * Each plugin is a subdirectory containing:
 * - `package.json` (with `donwells` manifest extension)
 * - `index.js` (or `dist/index.js`) — the plugin module
 *
 * Discovery never imports plugin code. A plugin executes only after the user
 * enables it; enabled ids persist in `.donwells-activation.json` beside the
 * plugin directories, so startup imports just the enabled set.
 *
 * Disabling calls the plugin's `deactivate` hook and unregisters its commands,
 * but Node's ESM import cache keeps the module in memory until app restart —
 * no false eviction promise.
 */
export class PluginLoader {
  constructor(private options: PluginLoaderOptions) {}

  private activationPath(): string {
    return join(this.options.pluginDir, ACTIVATION_FILE)
  }

  private readActivation(): string[] {
    try {
      const file = this.activationPath()
      if (!existsSync(file)) return []
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { enabled?: unknown }
      if (!Array.isArray(parsed.enabled)) return []
      return parsed.enabled.filter((id): id is string => typeof id === 'string')
    } catch (error) {
      logger.error({ err: error }, 'plugin-loader: activation file unreadable, treating nothing as enabled')
      return []
    }
  }

  private writeActivation(enabled: string[]): void {
    writeFileSync(this.activationPath(), JSON.stringify({ enabled }, null, 2))
  }

  /** Read manifests from disk WITHOUT importing any plugin code. */
  private discover(): Array<{ manifest: PluginManifest; path: string }> {
    const { pluginDir } = this.options
    if (!existsSync(pluginDir)) return []

    const found: Array<{ manifest: PluginManifest; path: string }> = []
    for (const entry of readdirSync(pluginDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const pluginPath = join(pluginDir, entry.name)
      try {
        const manifestPath = join(pluginPath, 'package.json')
        if (!existsSync(manifestPath)) continue
        const raw = readFileSync(manifestPath, 'utf-8')
        const manifest = this.validateManifest(JSON.parse(raw), pluginPath)
        found.push({ manifest, path: pluginPath })
      } catch (error) {
        logger.error({ err: error, plugin: entry.name }, 'plugin-loader: invalid manifest, skipped')
      }
    }
    return found
  }

  /** Truthful three-way state per discovered plugin: manifest / enabled / active. */
  async list(): Promise<PluginStateView[]> {
    const enabledIds = new Set(this.readActivation())
    return this.discover().map(({ manifest }) => ({
      manifest,
      enabled: enabledIds.has(manifest.id),
      active: getPluginRegistry().getPlugin(manifest.id) !== undefined,
    }))
  }

  async loadAll(): Promise<number> {
    const { pluginDir } = this.options
    if (!existsSync(pluginDir)) {
      logger.info({ pluginDir }, 'plugin-loader: directory not found, skipping')
      return 0
    }

    const enabledIds = new Set(this.readActivation())
    let loaded = 0

    for (const { manifest, path } of this.discover()) {
      if (!enabledIds.has(manifest.id)) continue
      if (getPluginRegistry().getPlugin(manifest.id) !== undefined) {
        // Already active in this process — consent is satisfied; don't re-import.
        loaded++
        continue
      }
      try {
        await this.loadPlugin(path)
        loaded++
      } catch (error) {
        logger.error({ err: error, plugin: manifest.id }, 'plugin-loader: failed to load')
      }
    }

    return loaded
  }

  /** User consent point: persist enablement, then import + activate if not already loaded. */
  async enable(pluginId: string): Promise<void> {
    const found = this.discover().find((entry) => entry.manifest.id === pluginId)
    if (!found) throw new Error(`Plugin not found: ${pluginId}`)

    const enabled = this.readActivation()
    if (!enabled.includes(pluginId)) {
      enabled.push(pluginId)
      this.writeActivation(enabled)
    }

    if (getPluginRegistry().getPlugin(pluginId) === undefined) {
      await this.loadPlugin(found.path)
    }
  }

  /** Removes the user's consent: deactivate + unregister, then persist disablement. */
  async disable(pluginId: string): Promise<void> {
    if (getPluginRegistry().getPlugin(pluginId) !== undefined) {
      try {
        await getPluginRegistry().unload(pluginId)
      } catch (error) {
        logger.error({ err: error, plugin: pluginId }, 'plugin-loader: unload during disable failed')
      }
    }
    this.writeActivation(this.readActivation().filter((id) => id !== pluginId))
  }

  /**
   * Copies a validated plugin folder into the plugin directory (R1.4). The
   * install is DISABLED until the user enables it — copying never executes code.
   */
  async install(sourceDirPath: string): Promise<PluginManifest> {
    const manifestPath = join(sourceDirPath, 'package.json')
    if (!existsSync(manifestPath)) {
      throw new Error(`No package.json in ${sourceDirPath}`)
    }

    const manifest = this.validateManifest(JSON.parse(readFileSync(manifestPath, 'utf-8')), sourceDirPath)
    if (!SAFE_PLUGIN_ID.test(manifest.id) || manifest.id === '.' || manifest.id === '..') {
      throw new Error(`Plugin id is not installable: ${manifest.id}`)
    }

    const target = join(this.options.pluginDir, manifest.id)
    if (existsSync(target)) {
      throw new Error(`Plugin already installed: ${manifest.id}`)
    }

    mkdirSync(this.options.pluginDir, { recursive: true })
    cpSync(sourceDirPath, target, { recursive: true })
    logger.info({ plugin: manifest.id, target }, 'plugin-loader: plugin installed (inactive until enabled)')
    return manifest
  }

  /**
   * Revokes consent, unloads, then moves the plugin folder to the trash root
   * so removal is recoverable (R1.4).
   */
  async remove(pluginId: string): Promise<void> {
    const found = this.discover().find((entry) => entry.manifest.id === pluginId)
    if (!found) throw new Error(`Plugin not found: ${pluginId}`)

    await this.disable(pluginId)

    if (!this.options.trashRoot) {
      throw new Error('Plugin trash root not configured')
    }
    moveToTrash(found.path, this.options.trashRoot)
    logger.info({ plugin: pluginId }, 'plugin-loader: plugin folder moved to trash')
  }

  async loadPlugin(pluginPath: string): Promise<void> {
    const manifestPath = join(pluginPath, 'package.json')
    if (!existsSync(manifestPath)) {
      throw new Error(`No package.json in ${pluginPath}`)
    }

    const raw = readFileSync(manifestPath, 'utf-8')
    const pkg = JSON.parse(raw)

    const manifest = this.validateManifest(pkg, pluginPath)

    // Resolve main entry
    const mainPath = this.resolveMain(pluginPath, pkg.main || 'index.js')
    const module = await import(pathToFileURL(mainPath).href) as PluginModule

    await getPluginRegistry().load(manifest, module)
  }

  private validateManifest(pkg: Record<string, unknown>, pluginPath: string): PluginManifest {
    const errors: string[] = []
    if (!pkg.id && !pkg.name) errors.push('missing id/name')
    if (!pkg.version) errors.push('missing version')
    if (!pkg.main) errors.push('missing main')

    if (errors.length > 0) {
      throw new Error(`Invalid plugin manifest in ${pluginPath}: ${errors.join(', ')}`)
    }

    return {
      id: (pkg.id || pkg.name) as string,
      name: (pkg.name || pkg.id) as string,
      version: pkg.version as string,
      description: pkg.description as string | undefined,
      author: pkg.author as string | undefined,
      main: (pkg.main || 'index.js') as string,
      apiVersion: '1.0.0',
      engines: pkg.engines as PluginManifest['engines'],
      permissions: (pkg as { permissions?: string[] }).permissions,
      commands: (pkg as { commands?: PluginManifest['commands'] }).commands,
    }
  }

  private resolveMain(pluginPath: string, main: string): string {
    const mainPath = resolve(pluginPath, main)
    if (!existsSync(mainPath)) {
      // Try dist/ fallback
      const distPath = resolve(pluginPath, 'dist', main)
      if (existsSync(distPath)) return distPath
      throw new Error(`Plugin main not found: ${mainPath}`)
    }
    return mainPath
  }
}
