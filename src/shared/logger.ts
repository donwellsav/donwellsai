import pino from 'pino'

// A sandboxed Electron renderer has no `process` global. Probe once, lazily.
const nodeProcess: NodeJS.Process | undefined = typeof process !== 'undefined' ? process : undefined
const processEnv: NodeJS.ProcessEnv = nodeProcess?.env ?? {}
const IS_ELECTRON_MAIN = (nodeProcess as { type?: string } | undefined)?.type === 'browser'
const IS_RUN_AS_NODE = processEnv['ELECTRON_RUN_AS_NODE'] === '1'
// pino transports need worker threads; unavailable in renderers, so they log synchronously.
const IS_NODE_CONTEXT = nodeProcess !== undefined

const logLevel = (() => {
  // 1. Explicit env override
  const envLevel = processEnv['DONWELLS_LOG_LEVEL']
  if (envLevel) return envLevel
  // 2. Production vs development
  if (processEnv['NODE_ENV'] === 'production') return 'info'
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
  transport: IS_NODE_CONTEXT && !IS_ELECTRON_MAIN && !IS_RUN_AS_NODE && isDev
    ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      }
    : undefined,
  base: {
    app: 'donwells',
    version: processEnv['npm_package_version'],
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
