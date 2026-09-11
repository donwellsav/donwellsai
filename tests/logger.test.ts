import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { logger, createLogger } from '@shared/logger'

describe('logger', () => {
  it('is a pino logger instance', () => {
    expect(logger).toBeDefined()
    expect(typeof logger.info).toBe('function')
    expect(typeof logger.error).toBe('function')
    expect(typeof logger.debug).toBe('function')
    expect(typeof logger.warn).toBe('function')
  })

  it('creates child logger with bindings', () => {
    const child = createLogger({ sessionId: 'test-123', module: 'agent' })
    expect(child).toBeDefined()
    expect(typeof child.info).toBe('function')
    expect(child !== logger).toBe(true)
  })

  it('logs without throwing', () => {
    expect(() => logger.info('test message')).not.toThrow()
    expect(() => logger.info({ foo: 'bar' }, 'with context')).not.toThrow()
    expect(() => logger.error(new Error('test error'), 'error')).not.toThrow()
  })
})
