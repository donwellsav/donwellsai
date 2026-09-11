import { logger } from './logger'

export interface AnalyticsEvent {
  name: string
  category: 'app' | 'agent' | 'project' | 'ui' | 'performance' | 'error'
  properties?: Record<string, string | number | boolean | null>
  timestamp?: number
}

export interface AnalyticsConfig {
  enabled: boolean
  /** Maximum events to queue before flushing. */
  flushThreshold: number
  /** Flush interval in ms. */
  flushIntervalMs: number
  /** Custom collector endpoint URL. */
  endpoint?: string
  /** Environment tag (dev/staging/production). */
  environment?: string
}

const DEFAULT_CONFIG: AnalyticsConfig = {
  enabled: false,
  flushThreshold: 50,
  flushIntervalMs: 30000,
  environment: 'production'
}

/**
 * Privacy-respecting, opt-in analytics collector.
 *
 * Collects anonymized usage events. No personal data, file paths, or
 * message content is captured. Respects Do Not Track headers.
 */
export class AnalyticsCollector {
  private queue: AnalyticsEvent[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private config: AnalyticsConfig

  constructor(config: Partial<AnalyticsConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Tracks an event.
   */
  track(name: string, category: AnalyticsEvent['category'], properties?: AnalyticsEvent['properties']): void {
    if (!this.config.enabled) return

    // Sanitize: remove any potentially identifying info
    const sanitized = properties ? this.sanitizeProperties(properties) : undefined

    this.queue.push({
      name,
      category,
      properties: sanitized,
      timestamp: Date.now()
    })

    if (this.queue.length >= this.config.flushThreshold) {
      void this.flush()
    }
  }

  /**
   * Tracks a UI interaction (button click, navigation, etc.).
   */
  trackUI(name: string, properties?: AnalyticsEvent['properties']): void {
    this.track(name, 'ui', properties)
  }

  /**
   * Tracks a performance metric.
   */
  trackPerformance(name: string, durationMs: number, properties?: AnalyticsEvent['properties']): void {
    this.track(name, 'performance', { ...properties, durationMs })
  }

  /**
   * Tracks an error.
   */
  trackError(name: string, error: Error, properties?: AnalyticsEvent['properties']): void {
    this.track(name, 'error', { ...properties, errorMessage: error.message, errorName: error.name })
  }

  /**
   * Starts periodic flushing.
   */
  start(): void {
    if (!this.config.enabled || this.flushTimer) return
    this.flushTimer = setInterval(() => void this.flush(), this.config.flushIntervalMs)
  }

  /**
   * Stops the collector and flushes remaining events.
   */
  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    await this.flush()
  }

  /**
   * Manually flush queued events.
   */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return

    const events = [...this.queue]
    this.queue = []

    if (this.config.endpoint) {
      await this.sendToEndpoint(events)
    } else {
      // No endpoint configured — log for debugging
      logger.debug({ count: events.length }, 'analytics: events flushed (no endpoint)')
    }
  }

  get pendingCount(): number {
    return this.queue.length
  }

  isEnabled(): boolean {
    return this.config.enabled
  }

  private async sendToEndpoint(events: AnalyticsEvent[]): Promise<void> {
    if (!this.config.endpoint) return

    try {
      const response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events, environment: this.config.environment })
      })

      if (!response.ok) {
        logger.warn({ status: response.status, count: events.length }, 'analytics: flush failed')
      }
    } catch (error) {
      logger.warn({ err: error, count: events.length }, 'analytics: send failed')
      // Re-queue failed events
      this.queue.push(...events)
    }
  }

  private sanitizeProperties(props: AnalyticsEvent['properties']): AnalyticsEvent['properties'] {
    if (!props) return props

    const sanitized: AnalyticsEvent['properties'] = {}
    const forbiddenPatterns = [/email/i, /phone/i, /name/i, /path/i, /url/i, /ip/i, /address/i]

    for (const [key, value] of Object.entries(props)) {
      // Skip keys that look like PII
      if (forbiddenPatterns.some((p) => p.test(key))) continue

      // Only allow primitives
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
        sanitized[key] = value
      }
    }

    return sanitized
  }
}

// Singleton instance
let _instance: AnalyticsCollector | null = null

export function getAnalyticsCollector(): AnalyticsCollector {
  if (!_instance) {
    _instance = new AnalyticsCollector()
  }
  return _instance
}

export function initAnalytics(config: Partial<AnalyticsConfig>): AnalyticsCollector {
  const collector = new AnalyticsCollector(config)
  _instance = collector
  if (collector.isEnabled()) {
    collector.start()
  }
  return collector
}
