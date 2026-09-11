/**
 * Central service initialization for Donwells.ai.
 * 
 * All new feature services (event sourcing, analytics, perf monitoring,
 * session templates, collaboration) are created here.
 */

import { join } from 'node:path'
import { app } from 'electron'
import { logger } from '@shared/logger'
import { EventStore } from './events/event-store'
import { initPerfMonitor } from '@shared/perf-monitor'
import { AnalyticsCollector } from '@shared/analytics'
import { SessionTemplateManager } from './templates/session-template-manager'
import { CollaborationService } from './collaboration/collaboration-service'
import { AutonomousAgent } from './autonomous/autonomous-agent'

export interface DonwellsServices {
  eventStore: EventStore
  perfMonitor: ReturnType<typeof initPerfMonitor>
  analytics: AnalyticsCollector
  sessionTemplates: SessionTemplateManager
  collaboration: CollaborationService
  autonomousAgent: AutonomousAgent
}

let services: DonwellsServices | null = null

export function initServices(): DonwellsServices {
  if (services) return services

  logger.info('services: initializing')

  const eventStore = new EventStore({
    baseDir: join(app.getPath('userData'), 'events'),
  })

  const perfMonitor = initPerfMonitor(process.env['DONWELLS_PERF'] === '1')

  const analytics = new AnalyticsCollector({
    enabled: process.env['DONWELLS_ANALYTICS'] === '1',
  })

  const sessionTemplates = new SessionTemplateManager({
    userDir: join(app.getPath('userData'), 'templates'),
  })

  const collaboration = new CollaborationService({
    roomName: 'default',
    userId: 'local',
  })

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
    perfMonitor,
    analytics,
    sessionTemplates,
    collaboration,
    autonomousAgent,
  }

  logger.info('services: ready')
  return services
}

export function getServices(): DonwellsServices {
  if (!services) throw new Error('Services not initialized. Call initServices() first.')
  return services
}
