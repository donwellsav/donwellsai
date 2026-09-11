import pino from 'pino'

const IS_ELECTRON_MAIN = (process as { type?: string }).type === 'browser'
const IS_RUN_AS_NODE = process.env['ELECTRON_RUN_AS_NODE'] === '1'

const logLevel = (() => {
  // 1. Explicit env override
  const envLevel = process.env['DONWELLS_LOG_LEVEL']
  if (envLevel) return envLevel
  // 2. Production vs development
  if (process.env['NODE_ENV'] === 'production') return 'info'
  return 'debug'
})()

const isDev = logLevel === 'debug' || logLevel === 'trace'

/**
 * Shared structured logger for Donwells.ai.
 *
 * Main process (`process.type === 'browser'`): writes JSON to stderr + file.
 * Renderer process: writes pretty-printed to console.
 * Worker threads: passthrough JSON.
 *
 * Usage:
 *   import { logger } from '@shared/logger'
 *   logger.info({ sessionId }, 'agent started')
 *   logger.error({ err }, 'agent crashed')
 */
const logger = pino({
  level: logLevel,
  transport: IS_ELECTRON_MAIN || IS_RUN_AS_NODE
    ? undefined
    : isDev
      ? {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        }
      : undefined,
  base: {
    app: 'donwells',
    version: typeof process !== 'undefined' ? process.env['npm_package_version'] : undefined,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
  },
})

/** Create a child logger with bound context (e.g. per-session or per-module). */
export const createLogger = (bindings: pino.Bindings): pino.Logger =>
  logger.child(bindings)

export { logger }
export default logger
