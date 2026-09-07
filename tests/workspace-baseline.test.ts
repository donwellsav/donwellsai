import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateOptions } from './acceptance/workspace-baseline.mjs'
import { assertMatchingDirectory, externalResourcesIdentity } from './helpers/package-evidence.mjs'
import { cleanSmokeAppShutdown } from './helpers/smoke-processes.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('requires a packaged app and keeps evidence separate from the disposable profile, resolving executable aliases', () => {
  const root = mkdtempSync(join(tmpdir(), 'donwells-baseline-check-')); roots.push(root)
  const executable = join(root, 'Fixture.app/Contents/MacOS/donwells')
  mkdirSync(join(root, 'Fixture.app/Contents/MacOS'), { recursive: true })
  mkdirSync(join(root, 'Fixture.app/Contents/Resources'))
  writeFileSync(executable, '')
  const options = { app: executable, profile: join(root, 'profile'), evidence: join(root, 'evidence') }
  expect(() => validateOptions({})).toThrow('--app is required')
  expect(() => validateOptions(options)).toThrow()
  writeFileSync(join(root, 'Fixture.app/Contents/Resources/app.asar'), '')
  expect(validateOptions(options).app).toBe(realpathSync(executable))
  expect(() => validateOptions({ ...options, evidence: options.profile })).toThrow('separate directories')
  expect(() => validateOptions({ ...options, evidence: join(options.profile, 'nested') })).toThrow()
  const alias = join(root, 'app-alias'); symlinkSync(executable, alias)
  expect(validateOptions({ ...options, app: alias }).app).toBe(realpathSync(executable))
  mkdirSync(options.profile)
  expect(() => validateOptions(options)).toThrow('already exists')
})

it('binds external resource file names and content and rejects stale shipped files', () => {
  const root = mkdtempSync(join(tmpdir(), 'donwells-package-evidence-')); roots.push(root)
  const source = join(root, 'source'), shipped = join(root, 'shipped')
  mkdirSync(source); mkdirSync(shipped)
  writeFileSync(join(source, 'current.js'), 'current'); writeFileSync(join(shipped, 'current.js'), 'current')
  expect(assertMatchingDirectory(source, shipped)).toEqual(['current.js'])
  const before = externalResourcesIdentity(root, [{ to: 'shipped' }])
  writeFileSync(join(shipped, 'stale.js'), 'stale')
  expect(() => assertMatchingDirectory(source, shipped)).toThrow('file list differs')
  expect(externalResourcesIdentity(root, [{ to: 'shipped' }])).not.toEqual(before)
  symlinkSync(join(shipped, 'current.js'), join(shipped, 'linked.js'))
  expect(() => externalResourcesIdentity(root, [{ to: 'shipped' }])).toThrow('symlink is not allowed')
})

it('accepts only a clean app shutdown receipt', () => {
  expect(cleanSmokeAppShutdown({ forcedTermination: false, exitCode: 0, signal: null })).toBe(true)
  for (const receipt of [{ forcedTermination: true, exitCode: 0, signal: null }, { forcedTermination: false, exitCode: 1, signal: null }, { forcedTermination: false, exitCode: null, signal: 'SIGTERM' }, { forcedTermination: false, exitCode: 0, signal: null, closeError: 'failed' }]) expect(cleanSmokeAppShutdown(receipt)).toBe(false)
})
