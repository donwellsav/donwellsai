import { expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { app } from 'electron'
import { appResourcesRoot } from '../src/main/app-resources'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: vi.fn() } }))

it('uses the build location for development and Resources for packaged launches', () => {
  const original = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  try {
    for (const launch of [process.cwd(), resolve('out/main')]) {
      vi.mocked(app.getAppPath).mockReturnValue(launch)
      expect(appResourcesRoot()).toBe(process.cwd())
    }
    Object.defineProperty(app, 'isPackaged', { value: true, configurable: true })
    Object.defineProperty(process, 'resourcesPath', { value: '/fixture/app/Contents/Resources', configurable: true })
    expect(appResourcesRoot()).toBe('/fixture/app/Contents/Resources')
  } finally {
    Object.defineProperty(app, 'isPackaged', { value: false, configurable: true })
    if (original) Object.defineProperty(process, 'resourcesPath', original)
    else Reflect.deleteProperty(process, 'resourcesPath')
  }
})
