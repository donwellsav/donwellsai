import { createHash } from 'node:crypto'
import type { Session } from 'electron'

/** Input is the registered, canonical checkout returned by the main-process resolver. */
export function browserPartition(checkoutPath: string): string {
  const identity = process.platform === 'win32' ? checkoutPath.toLowerCase() : checkoutPath
  return 'persist:donwells-checkout-' + createHash('sha256').update(identity).digest('hex')
}

export function allowedNavigation(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

export function configureBrowserPermissions(browserSession: Session): void {
  // No browser capability is supported without an explicit app-level approval flow.
  browserSession.setPermissionCheckHandler(() => false)
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  browserSession.setDevicePermissionHandler(() => false)
}
