import { test, expect } from '@playwright/test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

/**
 * Packaging invariant for renderer-bundled libraries.
 *
 * `electron.vite.config.ts` applies `externalizeDepsPlugin` to main and preload
 * only, so the renderer is a real Vite bundle: everything it imports is inlined
 * into `out/renderer`. electron-builder separately installs every entry of
 * `dependencies` into the packaged app. A library listed in `dependencies` but
 * imported only from `src/renderer/` therefore ships TWICE -- once bundled,
 * once as unreachable `node_modules` -- which measured 262.77 MB across 22
 * packages (app.asar 425.4 MB of an 849.8 MB app).
 *
 * Nothing in the E2E suite could see this: every spec launches the app
 * unpackaged from `out/main/index.js`, where the renderer bundle is the only
 * copy and the duplicate is invisible. These assertions need no packaging, so
 * they run in the normal suite and fail the moment a bundled library is
 * re-declared as a runtime dependency.
 *
 * The packaged counterpart -- package, inspect app.asar, launch the packaged
 * executable and assert the renderer boots -- is
 * `node scripts/check-packaged-renderer.mjs`.
 */

const ROOT = resolve(__dirname, '..')

/** Imported only under `src/renderer/`; Vite bundles them into `out/renderer`. */
const RENDERER_BUNDLED = [
  '@fontsource-variable/geist',
  '@fontsource-variable/geist-mono',
  '@pierre/diffs',
  '@xterm/addon-fit',
  '@xterm/addon-search',
  '@xterm/addon-web-links',
  '@xterm/addon-webgl',
  '@xterm/xterm',
  'dompurify',
  'flexlayout-react',
  'katex',
  'lucide-react',
  'marked',
  'marked-footnote',
  'marked-katex-extension',
  'mermaid',
  'monaco-editor',
  'pdfjs-dist',
  'react',
  'react-dom',
  'react-error-boundary',
  'zustand'
]

/** Imported from main/preload/CLI sources, so they must ship as real modules. */
const REQUIRED_RUNTIME = ['@agentclientprotocol/sdk', '@sentry/electron', 'node-pty', 'pino']

const manifest = () => JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

test.describe('packaging: renderer-bundled libraries stay out of dependencies', () => {
  test('no renderer-bundled library is declared as a runtime dependency', () => {
    const { dependencies = {} } = manifest()
    const shippedTwice = RENDERER_BUNDLED.filter((name) => name in dependencies)
    expect(
      shippedTwice,
      'These libraries are inlined into out/renderer by Vite, so declaring them in `dependencies` ' +
        'makes electron-builder ship a second, unreachable copy inside the packaged app. ' +
        'Keep them in `devDependencies`.'
    ).toEqual([])
  })

  test('renderer-bundled libraries are still declared so the bundle can resolve them', () => {
    const { devDependencies = {}, dependencies = {} } = manifest()
    const missing = RENDERER_BUNDLED.filter((name) => !(name in devDependencies) && !(name in dependencies))
    expect(missing, 'A renderer dependency was dropped instead of reclassified; the renderer bundle would fail to build.').toEqual([])
  })

  test('libraries reached from main, preload or the CLI remain runtime dependencies', () => {
    const { dependencies = {} } = manifest()
    const missing = REQUIRED_RUNTIME.filter((name) => !(name in dependencies))
    expect(
      missing,
      'These are imported outside the renderer bundle, so an externalized `require()` needs them installed ' +
        'in the packaged app. @sentry/electron is used from BOTH main and renderer and must stay here.'
    ).toEqual([])
  })

  test('the built renderer carries no bare module specifier for them', () => {
    const assets = join(ROOT, 'out/renderer/assets')
    test.skip(!existsSync(assets), 'out/renderer is not built; run `pnpm run build`')
    const bundles = readdirSync(assets)
      .filter((name) => name.endsWith('.js'))
      .map((name) => readFileSync(join(assets, name), 'utf8'))
    const script = bundles.join('\n')
    const externalized = RENDERER_BUNDLED.filter((name) =>
      new RegExp(`(?:from|import|require)\\s*\\(?\\s*["']${name.replace(/[/@.]/g, (character) => `\\${character}`)}(?:[/"'])`).test(script)
    )
    expect(externalized, 'A renderer import survived bundling as an external specifier; it would need node_modules at runtime.').toEqual([])
  })

  test('an existing packaged app does not carry them in its runtime node_modules', () => {
    const archive = [
      join(ROOT, 'dist/mac-arm64/donwells.app/Contents/Resources/app.asar'),
      join(ROOT, 'dist/linux-unpacked/resources/app.asar'),
      join(ROOT, 'dist/win-unpacked/resources/app.asar')
    ].find((candidate) => existsSync(candidate))
    test.skip(archive === undefined, 'no packaged app present; run `node scripts/check-packaged-renderer.mjs`')

    // Playwright compiles specs as CommonJS, so resolve from the manifest rather
    // than import.meta.url.
    const requireFromRoot = createRequire(join(ROOT, 'package.json'))
    const asar = requireFromRoot(
      requireFromRoot.resolve('@electron/asar', { paths: [requireFromRoot.resolve('electron-builder')] })
    ) as { listPackage: (path: string) => string[] }
    const installed = new Set(
      asar
        .listPackage(archive!)
        .map((name) => /^\/?node_modules\/((?:@[^/]+\/)?[^/]+)(?:\/|$)/.exec(name)?.[1])
        .filter((name): name is string => name !== undefined)
    )
    expect(RENDERER_BUNDLED.filter((name) => installed.has(name))).toEqual([])
  })
})
