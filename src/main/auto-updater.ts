import { autoUpdater } from 'electron-updater'
import { logger } from '@shared/logger'

/**
 * Auto-updater service for Donwells.ai.
 *
 * electron-updater reads `package.json`'s `build.publish` config to find
 * release assets. It is fully opt-in: without a publish config, every API
 * call returns "update not available" silently.
 *
 * Usage (call from main process after app.whenReady):
 *   initAutoUpdater(window) — wires IPC + event forwarding to renderer
 */

let mainWindow: Electron.BrowserWindow | null = null
let initialized = false

/** Throttle update checks to at most once per 30 minutes. */
const CHECK_INTERVAL_MS = 30 * 60 * 1000
let lastCheck = 0

export function initAutoUpdater(window: Electron.BrowserWindow): void {
  if (initialized) return
  initialized = true
  mainWindow = window

  // Default: silent. Opt into verbose logs via env.
  autoUpdater.logger = logger

  // Only auto-download if user has opted in via settings.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    logger.info('auto-updater: checking for updates')
    send('autoUpdater:checking', undefined)
  })

  autoUpdater.on('update-available', (info) => {
    logger.info({ version: info.version }, 'auto-updater: update available')
    send('autoUpdater:update-available', { version: info.version, releaseNotes: info.releaseNotes as string | undefined })
  })

  autoUpdater.on('update-not-available', () => {
    logger.debug('auto-updater: up to date')
    send('autoUpdater:update-not-available', undefined)
  })

  autoUpdater.on('download-progress', (progress) => {
    logger.debug({ percent: progress.percent }, 'auto-updater: download progress')
    send('autoUpdater:download-progress', { percent: progress.percent, bytesPerSecond: progress.bytesPerSecond })
  })

  autoUpdater.on('update-downloaded', (info) => {
    logger.info({ version: info.version }, 'auto-updater: update downloaded, ready to install')
    send('autoUpdater:update-downloaded', { version: info.version })
  })

  autoUpdater.on('error', (error) => {
    logger.error({ err: error }, 'auto-updater: error')
    send('autoUpdater:error', { message: error instanceof Error ? error.message : String(error) })
  })
}

/** Check for updates (throttled to once per 30 min). Returns true if a check was triggered. */
export async function checkForUpdates(): Promise<boolean> {
  if (!initialized) return false
  const now = Date.now()
  if (now - lastCheck < CHECK_INTERVAL_MS) {
    logger.debug('auto-updater: check throttled')
    return false
  }
  lastCheck = now
  try {
    await autoUpdater.checkForUpdates()
    return true
  } catch (error) {
    logger.error({ err: error }, 'auto-updater: check failed')
    return false
  }
}

/** Download a previously-detected update. */
export async function downloadUpdate(): Promise<void> {
  logger.info('auto-updater: starting download')
  await autoUpdater.downloadUpdate()
}

/** Quit and install the downloaded update. */
export function quitAndInstall(): void {
  logger.info('auto-updater: quit and install')
  autoUpdater.quitAndInstall()
}

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel as any, payload)
  }
}
