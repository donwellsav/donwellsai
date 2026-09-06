import type { Session } from 'electron'

export const BROWSER_PARTITION = 'persist:donwells-browser'

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
