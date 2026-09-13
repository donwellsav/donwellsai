import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export type NativeAddonPathOptions = {
  resourcesPath?: string
  defaultApp?: boolean
}

function packageRoot(moduleDirectory: string): string {
  let current = resolve(moduleDirectory)
  while (true) {
    if (existsSync(join(current, 'package.json'))) return current
    const parent = dirname(current)
    if (parent === current) throw new Error('could not locate the donwells package root for the native runtime addon')
    current = parent
  }
}

export function resolveNativeRuntimeAddonPath(moduleDirectory: string, options: NativeAddonPathOptions = {}): string {
  if (typeof options.resourcesPath === 'string' && options.resourcesPath.length > 0) {
    const packagedPath = join(options.resourcesPath, 'native', 'runtime-identity.node')
    // A detached packaged daemon runs with ELECTRON_RUN_AS_NODE=1, which
    // makes Electron report defaultApp=true even though resourcesPath points
    // at the real app bundle. Prefer that shipped resource when present;
    // development Electron resources do not contain the addon and fall back
    // to the source package root below.
    if (options.defaultApp !== true || existsSync(packagedPath)) return packagedPath
  }
  return join(packageRoot(moduleDirectory), 'resources', 'native', 'runtime-identity.node')
}
