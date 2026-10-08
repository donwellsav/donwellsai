/**
 * Performance monitoring for Donwells.ai.
 *
 * Tracks IPC latency and memory usage.
 * Integrates with the structured logger for output.
 */
import { logger } from './logger'

let perfEnabled = false
const MAX_SAMPLES = 1000
const ipcSamples: number[] = []

export function initPerfMonitor(enabled = false): void {
  perfEnabled = enabled || process.env['DONWELLS_PERF'] === '1'
  if (perfEnabled) {
    logger.info('perf-monitor: enabled')
  }
}

/** Time an IPC call. Returns a finish function. */
export function startIpcTimer(method: string): () => void {
  if (!perfEnabled) return () => {}
  const start = performance.now()
  return () => {
    const duration = performance.now() - start
    ipcSamples.push(duration)
    if (ipcSamples.length > MAX_SAMPLES) ipcSamples.shift()
    if (duration > 1000) {
      logger.warn({ method, duration: Math.round(duration) }, 'perf: slow IPC')
    }
  }
}

/** Get current performance stats. */
export function getPerfStats(): {
  ipcCalls: number
  ipcAvg: number
  ipcP95: number
  memoryMB: number | null
} {
  const sorted = (arr: number[]) => [...arr].sort((a, b) => a - b)
  const avg = (arr: number[]) => arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length
  const p95 = (arr: number[]) => {
    if (arr.length === 0) return 0
    const s = sorted(arr)
    return s[Math.floor(s.length * 0.95)]
  }

  return {
    ipcCalls: ipcSamples.length,
    ipcAvg: Math.round(avg(ipcSamples)),
    ipcP95: Math.round(p95(ipcSamples)),
    memoryMB: typeof process !== 'undefined' && process.memoryUsage
      ? Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
      : null,
  }
}
