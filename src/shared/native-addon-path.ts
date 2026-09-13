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
  if (typeof options.resourcesPath === 'string' && options.resourcesPath.length > 0 && options.defaultApp !== true) {
    return join(options.resourcesPath, 'native', 'runtime-identity.node')
  }
  return join(packageRoot(moduleDirectory), 'resources', 'native', 'runtime-identity.node')
}
