// @vitest-environment node
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveNativeRuntimeAddonPath } from './native-addon-path'

describe('native runtime addon path', () => {
  const root = resolve(import.meta.dirname, '../..')

  it('resolves source, CLI output, and bundled main chunks to the repository resource', () => {
    const expected = join(root, 'resources', 'native', 'runtime-identity.node')
    expect(resolveNativeRuntimeAddonPath(join(root, 'src', 'main'), {})).toBe(expected)
    expect(resolveNativeRuntimeAddonPath(join(root, 'src', 'shared'), {})).toBe(expected)
    expect(resolveNativeRuntimeAddonPath(join(root, 'dist-cli', 'main'), {})).toBe(expected)
    expect(resolveNativeRuntimeAddonPath(join(root, 'dist-cli', 'shared'), {})).toBe(expected)
    expect(resolveNativeRuntimeAddonPath(join(root, 'out', 'main', 'chunks'), {})).toBe(expected)
  })

  it('uses the packaged resources directory without a development fallback', () => {
    const resourcesPath = join(root, 'packaged resources')
    expect(resolveNativeRuntimeAddonPath(join(root, 'out', 'main', 'chunks'), { resourcesPath, defaultApp: false }))
      .toBe(join(resourcesPath, 'native', 'runtime-identity.node'))
  })
})
