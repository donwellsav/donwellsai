import { logger } from '../../shared/logger'

export interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  main: string
  /** Plugin API version this plugin targets. */
  apiVersion: '1.0.0'
  /** Donwells version constraint. */
  engines?: { donwells?: string }
  /** IPC channels this plugin needs access to. */
  permissions?: string[]
}

export interface PluginContext {
  manifest: PluginManifest
  /** Log through the structured logger. */
  log: typeof logger
  /** Get a capability from the app. */
  getCapability(capability: string): unknown
}

export type PluginModule = {
  activate?: (ctx: PluginContext) => void | Promise<void>
  deactivate?: () => void | Promise<void>
}

export interface LoadedPlugin {
  manifest: PluginManifest
  module: PluginModule
  context: PluginContext
}

export class PluginRegistry {
  private plugins = new Map<string, LoadedPlugin>()

  async load(manifest: PluginManifest, module: PluginModule): Promise<LoadedPlugin> {
    if (this.plugins.has(manifest.id)) {
      throw new Error(`Plugin ${manifest.id} already loaded`)
    }

    const context: PluginContext = {
      manifest,
      log: logger,
      getCapability: (capability: string) => {
        // Capability-based access control
        if (!manifest.permissions?.includes(capability)) {
          logger.warn({ plugin: manifest.id, capability }, 'plugin: capability denied')
          return null
        }
        return getAppCapability(capability)
      }
    }

    const plugin: LoadedPlugin = { manifest, module, context }

    if (module.activate) {
      await module.activate(context)
    }

    this.plugins.set(manifest.id, plugin)
    logger.info({ pluginId: manifest.id, name: manifest.name, version: manifest.version }, 'plugin: loaded')

    return plugin
  }

  async unload(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found`)
    }

    if (plugin.module.deactivate) {
      await plugin.module.deactivate()
    }

    this.plugins.delete(pluginId)
    logger.info({ pluginId }, 'plugin: unloaded')
  }

  getPlugin(pluginId: string): LoadedPlugin | undefined {
    return this.plugins.get(pluginId)
  }
}

// Singleton registry
let _registry: PluginRegistry | null = null

export function getPluginRegistry(): PluginRegistry {
  if (!_registry) {
    _registry = new PluginRegistry()
  }
  return _registry
}

// Placeholder for app capabilities registry
const appCapabilities = new Map<string, unknown>()

export function registerAppCapability(name: string, capability: unknown): void {
  appCapabilities.set(name, capability)
}

function getAppCapability(name: string): unknown {
  return appCapabilities.get(name)
}
