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
  /** Commands this plugin registers. */
  commands?: Array<{ id: string; title: string; description?: string }>
}

export interface PluginContext {
  manifest: PluginManifest
  /** Send a command to the plugin. */
  invoke(method: string, ...args: unknown[]): Promise<unknown>
  /** Log through the structured logger. */
  log: typeof logger
  /** Get a capability from the app. */
  getCapability(capability: string): unknown
}

export type PluginModule = {
  activate?: (ctx: PluginContext) => void | Promise<void>
  deactivate?: () => void | Promise<void>
  commands?: Record<string, (...args: unknown[]) => Promise<unknown> | unknown>
}

export interface LoadedPlugin {
  manifest: PluginManifest
  module: PluginModule
  context: PluginContext
  activated: boolean
}

export class PluginRegistry {
  private plugins = new Map<string, LoadedPlugin>()
  private commandHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()

  async load(manifest: PluginManifest, module: PluginModule): Promise<LoadedPlugin> {
    if (this.plugins.has(manifest.id)) {
      throw new Error(`Plugin ${manifest.id} already loaded`)
    }

    const context: PluginContext = {
      manifest,
      log: logger,
      invoke: (method, ...args) => {
        const handler = module.commands?.[method]
        if (!handler) {
          return Promise.reject(new Error(`Plugin ${manifest.id} has no command: ${method}`))
        }
        return Promise.resolve(handler(...args))
      },
      getCapability: (capability: string) => {
        // Capability-based access control
        if (!manifest.permissions?.includes(capability)) {
          logger.warn({ plugin: manifest.id, capability }, 'plugin: capability denied')
          return null
        }
        return getAppCapability(capability)
      }
    }

    const plugin: LoadedPlugin = { manifest, module, context, activated: false }

    if (module.activate) {
      await module.activate(context)
      plugin.activated = true
    }

    // Register commands
    for (const [method, handler] of Object.entries(module.commands ?? {})) {
      const commandId = `${manifest.id}.${method}`
      this.commandHandlers.set(commandId, (...args: unknown[]) => Promise.resolve(handler(...args)))
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

    // Unregister commands
    for (const method of Object.keys(plugin.module.commands ?? {})) {
      this.commandHandlers.delete(`${pluginId}.${method}`)
    }

    this.plugins.delete(pluginId)
    logger.info({ pluginId }, 'plugin: unloaded')
  }

  getPlugin(pluginId: string): LoadedPlugin | undefined {
    return this.plugins.get(pluginId)
  }

  getAllPlugins(): LoadedPlugin[] {
    return [...this.plugins.values()]
  }

  getCommandHandler(commandId: string): ((...args: unknown[]) => Promise<unknown>) | undefined {
    return this.commandHandlers.get(commandId)
  }

  async invokeCommand(commandId: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.commandHandlers.get(commandId)
    if (!handler) {
      throw new Error(`Unknown plugin command: ${commandId}`)
    }
    return handler(...args)
  }

  async unloadAll(): Promise<void> {
    for (const id of [...this.plugins.keys()]) {
      await this.unload(id)
    }
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
