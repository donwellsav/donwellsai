/**
 * Central service initialization for Donwells.ai.
 * 
 * All new feature services (event sourcing, analytics, perf monitoring,
 * session templates, autonomous loop, plugins) are created here.
 */

import { join } from 'node:path'
import { app } from 'electron'
import { logger } from '@shared/logger'
import { EventStore } from './events/event-store'
import { initPerfMonitor, getPerfStats } from '@shared/perf-monitor'
import { AnalyticsCollector } from '@shared/analytics'
import { SessionTemplateManager } from './templates/session-template-manager'
import { AutonomousAgent } from './autonomous/autonomous-agent'
import { PluginLoader } from './plugins/plugin-loader'
import { registerPluginCapabilities } from './plugins/app-capabilities'

export interface DonwellsServices {
  eventStore: EventStore
  analytics: AnalyticsCollector
  sessionTemplates: SessionTemplateManager
  autonomousAgent: AutonomousAgent
  pluginLoader: PluginLoader
}

let services: DonwellsServices | undefined = undefined

export function initServices(): DonwellsServices {
  if (services) return services

  logger.info('services: initializing')

  const eventStore = new EventStore({
    baseDir: join(app.getPath('userData'), 'events'),
  })

    const analytics = new AnalyticsCollector({
    enabled: process.env['DONWELLS_ANALYTICS'] === '1',
  })

  const sessionTemplates = new SessionTemplateManager({
    userDir: join(app.getPath('userData'), 'templates'),
  })
  void sessionTemplates.load().catch((err) => logger.error({ err }, 'session-templates: load failed'))

  registerPluginCapabilities(eventStore)
  const pluginLoader = new PluginLoader({
    pluginDir: join(app.getPath('userData'), 'plugins'),
    // Removed plugins land here recoverably (R1.4), same convention as worktrees.
    trashRoot: join(app.getPath('userData'), 'trash'),
  })
  // Consent-gated: loadAll imports only plugins the user has enabled (R1.3).
  void pluginLoader.loadAll().catch((err) => logger.error({ err }, 'plugin-loader: init failed'))

  const autonomousAgent = new AutonomousAgent({
    maxIterations: 100,
    maxDurationMs: 3600000,
    maxTokens: 100000,
    requireApproval: true,
    requireApprovalFor: ['shell', 'write', 'delete'],
    pauseOnError: true,
    iterationIntervalMs: 1000,
  })

  services = {
    eventStore,
    analytics,
    sessionTemplates,
    autonomousAgent,
    pluginLoader,
  }

  logger.info('services: ready')
  return services
}

export function getServices(): DonwellsServices {
  if (!services) throw new Error('Services not initialized. Call initServices() first.')
  return services
}
