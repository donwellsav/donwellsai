import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { logger } from '../../shared/logger'
import { PluginManifest, PluginModule, getPluginRegistry } from './plugin-registry'

export interface PluginLoaderOptions {
  /** Directory to scan for plugins. */
  pluginDir: string
  /** Whether to auto-activate plugins on load. */
  autoActivate?: boolean
}

/**
 * Loads plugins from a directory.
 *
 * Each plugin is a subdirectory containing:
 * - `package.json` (with `donwells` manifest extension)
 * - `index.js` (or `dist/index.js`) — the plugin module
 */
export class PluginLoader {
  constructor(private options: PluginLoaderOptions) {}

  async loadAll(): Promise<number> {
    const { pluginDir } = this.options
    if (!existsSync(pluginDir)) {
      logger.info({ pluginDir }, 'plugin-loader: directory not found, skipping')
      return 0
    }

    const entries = readdirSync(pluginDir, { withFileTypes: true })
    let loaded = 0

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const pluginPath = join(pluginDir, entry.name)
      try {
        await this.loadPlugin(pluginPath)
        loaded++
      } catch (error) {
        logger.error({ err: error, plugin: entry.name }, 'plugin-loader: failed to load')
      }
    }

    return loaded
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
    const module = await import(mainPath) as PluginModule

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
