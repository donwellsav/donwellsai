#!/usr/bin/env node
/**
 * Packaged-renderer gate.
 *
 * Every E2E spec in `e2e/` launches the app UNPACKAGED from `out/main/index.js`.
 * A library the renderer only needs from `node_modules` at runtime therefore
 * looks healthy in the whole existing suite and still yields a blank window in
 * the shipped app, because electron-builder installs `dependencies` a second
 * time beside the already-bundled renderer.
 *
 * This check closes that gap:
 *   1. package to a directory (`electron-builder --dir`, no signing, no publish)
 *   2. inventory the runtime `node_modules` that actually shipped inside app.asar
 *   3. launch the PACKAGED executable against a disposable profile and assert the
 *      React shell mounted: `#root` is not empty, the app-shell landmark is
 *      present, the error fallback did not render, and no uncaught renderer
 *      error was reported.
 *
 * Usage:
 *   node scripts/check-packaged-renderer.mjs                     package + inventory + launch
 *   node scripts/check-packaged-renderer.mjs --build             rebuild out/ and dist-cli first
 *   node scripts/check-packaged-renderer.mjs --skip-package      reuse the existing dist/
 *   node scripts/check-packaged-renderer.mjs --skip-launch       inventory only
 *   node scripts/check-packaged-renderer.mjs --expect absent     fail if a renderer-only dep shipped
 *   node scripts/check-packaged-renderer.mjs --smoke             also run the in-app DONWELLS_SMOKE probe
 *   node scripts/check-packaged-renderer.mjs --json report.json  write the machine-readable report
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

/**
 * Libraries with import evidence ONLY under `src/renderer/`. Vite bundles them
 * into `out/renderer`, so the packaged app must not carry a second copy.
 */
const RENDERER_ONLY_PACKAGES = [
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

/** Packages that must remain runtime dependencies because main/preload import them. */
const REQUIRED_RUNTIME_PACKAGES = ['@agentclientprotocol/sdk', '@sentry/electron', 'node-pty', 'pino']

const { values } = parseArgs({
  options: {
    build: { type: 'boolean', default: false },
    'skip-package': { type: 'boolean', default: false },
    'skip-launch': { type: 'boolean', default: false },
    smoke: { type: 'boolean', default: false },
    expect: { type: 'string', default: 'report' },
    json: { type: 'string' },
    timeout: { type: 'string', default: '60000' }
  }
})

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const builderConfig = JSON.parse(readFileSync(join(root, 'build/electron-builder.json'), 'utf8'))
const outputDir = resolve(root, builderConfig.directories?.output ?? 'dist')
const launchTimeout = Number(values.timeout)
if (!['report', 'present', 'absent'].includes(values.expect)) throw new Error(`--expect must be report, present or absent (got ${values.expect})`)

const report = { steps: [], rendererOnly: { expectedAbsent: RENDERER_ONLY_PACKAGES }, failures: [] }
const note = (message) => { report.steps.push(message); console.log(message) }
const fail = (message) => { report.failures.push(message); console.error(`FAIL: ${message}`) }

const run = (command, args, options = {}) => {
  console.log(`$ ${command} ${args.join(' ')}`)
  return execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options })
}

// ---------------------------------------------------------------------------
// 1. Build (optional) and package to a directory
// ---------------------------------------------------------------------------

if (values.build) {
  note('Building renderer/main/preload and the CLI')
  run(join(root, 'node_modules/.bin/electron-vite'), ['build'])
  run(process.execPath, [join(root, 'scripts/build-cli.mjs')])
}

for (const prerequisite of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html', 'dist-cli/cli/index.js']) {
  if (!existsSync(join(root, prerequisite))) {
    fail(`missing build artifact ${prerequisite}; run with --build`)
  }
}
if (report.failures.length > 0) {
  console.error('\nCannot package without a complete build.')
  process.exit(1)
}

const executableName = builderConfig.mac?.executableName ?? 'donwells'

// electron-builder nests the bundle (`dist/mac-arm64/<name>.app` on macOS,
// `dist/<platform>-unpacked/` elsewhere), so walk instead of guessing a depth.
const findDirectories = (directory, predicate, depth = 0) => {
  if (depth > 3) return []
  let entries = []
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.flatMap((entry) => {
    if (!entry.isDirectory()) return []
    const full = join(directory, entry.name)
    if (predicate(full, entry.name)) return [full]
    return findDirectories(full, predicate, depth + 1)
  })
}

const packagedApp = () => {
  if (!existsSync(outputDir)) return null
  for (const bundle of findDirectories(outputDir, (full, name) => name.endsWith('.app'))) {
    const executable = join(bundle, 'Contents/MacOS', executableName)
    if (existsSync(executable)) return { kind: 'darwin', bundle, executable, resources: join(bundle, 'Contents/Resources') }
  }
  for (const bundle of findDirectories(outputDir, (full, name) => name.endsWith('-unpacked'))) {
    const linux = join(bundle, executableName)
    if (existsSync(linux)) return { kind: 'linux', bundle, executable: linux, resources: join(bundle, 'resources') }
    const windows = join(bundle, `${executableName}.exe`)
    if (existsSync(windows)) return { kind: 'win32', bundle, executable: windows, resources: join(bundle, 'resources') }
  }
  return null
}

if (!values['skip-package']) {
  note('Packaging to a directory (no signing, no publish)')
  rmSync(outputDir, { recursive: true, force: true })
  run(join(root, 'node_modules/.bin/electron-builder'), ['--config', 'build/electron-builder.json', '--dir', '--publish', 'never'])
} else {
  note('Reusing the existing package (--skip-package)')
}

const packaged = packagedApp()
if (!packaged) {
  fail(`no packaged application found under ${outputDir}`)
  process.exit(1)
}
report.package = { kind: packaged.kind, bundle: packaged.bundle, executable: packaged.executable }
note(`Packaged application: ${packaged.bundle}`)

const archive = join(packaged.resources, 'app.asar')
if (!existsSync(archive)) {
  fail(`packaged app has no app.asar at ${archive}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 2. Inventory the runtime node_modules that actually shipped
// ---------------------------------------------------------------------------

const asar = require(require.resolve('@electron/asar', { paths: [require.resolve('electron-builder')] }))
const entries = asar.listPackage(archive).map((name) => (name.startsWith('/') ? name.slice(1) : name))
const runtimePackages = new Map()
for (const entry of entries) {
  const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)(?:\/|$)/.exec(entry)
  if (!match) continue
  const name = match[1]
  const record = runtimePackages.get(name) ?? { name, bytes: 0, files: 0 }
  let size = 0
  try {
    const stat = asar.statFile(archive, entry)
    if (typeof stat?.size === 'number') size = stat.size
  } catch {
    size = 0
  }
  record.bytes += size
  record.files += 1
  runtimePackages.set(name, record)
}

const shipped = [...runtimePackages.values()].sort((a, b) => b.bytes - a.bytes)
const shippedNames = new Set(shipped.map((entry) => entry.name))
const leaked = RENDERER_ONLY_PACKAGES.filter((name) => shippedNames.has(name))
const missingRequired = REQUIRED_RUNTIME_PACKAGES.filter((name) => !shippedNames.has(name))

report.runtimePackages = shipped.map(({ name, bytes, files }) => ({ name, bytes, mb: Number((bytes / 1048576).toFixed(2)), files }))
report.rendererOnlyShipped = leaked.map((name) => ({ name, mb: report.runtimePackages.find((entry) => entry.name === name)?.mb ?? 0 }))
report.runtimeNodeModulesMb = Number((shipped.reduce((total, entry) => total + entry.bytes, 0) / 1048576).toFixed(2))

const bundleBytes = (() => {
  try {
    return Number(execFileSync('du', ['-sk', packaged.bundle], { encoding: 'utf8' }).trim().split(/\s+/)[0]) * 1024
  } catch {
    return null
  }
})()
report.packagedAppBytes = bundleBytes
report.packagedAppMb = bundleBytes === null ? null : Number((bundleBytes / 1048576).toFixed(1))
report.appAsarBytes = statSync(archive).size
report.appAsarMb = Number((report.appAsarBytes / 1048576).toFixed(1))

note('')
note(`Runtime node_modules shipped in app.asar: ${shipped.length} packages, ${report.runtimeNodeModulesMb} MB`)
note(`Packaged application size: ${report.packagedAppMb} MB (app.asar ${report.appAsarMb} MB)`)
note('')
note('Largest shipped runtime packages:')
for (const entry of report.runtimePackages.slice(0, 12)) note(`  ${String(entry.mb).padStart(8)} MB  ${entry.name}`)
note('')
if (leaked.length === 0) {
  note('No renderer-only package ships in the packaged app.')
} else {
  note(`Renderer-only packages still shipped (${leaked.length} of ${RENDERER_ONLY_PACKAGES.length}):`)
  for (const entry of report.rendererOnlyShipped) note(`  ${String(entry.mb).padStart(8)} MB  ${entry.name}`)
  note(`  total ${Number(report.rendererOnlyShipped.reduce((total, entry) => total + entry.mb, 0).toFixed(2))} MB`)
}
if (missingRequired.length > 0) fail(`required runtime package missing from the packaged app: ${missingRequired.join(', ')}`)

if (values.expect === 'absent' && leaked.length > 0) fail(`--expect absent but ${leaked.length} renderer-only packages shipped`)
if (values.expect === 'present' && leaked.length !== RENDERER_ONLY_PACKAGES.length) {
  fail(`--expect present but only ${leaked.length} of ${RENDERER_ONLY_PACKAGES.length} renderer-only packages shipped`)
}

// ---------------------------------------------------------------------------
// 3. Launch the PACKAGED executable and assert the renderer actually booted
// ---------------------------------------------------------------------------

const disposableProfile = (seedSmokeWindowState = false) => {
  // The runtime file-security layer rejects a non-canonical directory, and
  // os.tmpdir() is a symlink on macOS (`/var` -> `/private/var`).
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'donwells-packaged-check-'), { encoding: 'utf8' }))
  // DaemonClient validates this directory before it can create its runtime files.
  mkdirSync(join(directory, 'terminal-daemon'), { recursive: true, mode: 0o700 })
  const repository = join(directory, 'fixture-repository')
  mkdirSync(repository, { recursive: true, mode: 0o700 })
  execFileSync('git', ['init', '--quiet', repository])
  writeFileSync(join(repository, 'readme.md'), '# packaged renderer fixture\n', { mode: 0o600 })
  // A seeded project makes the workspace shell mount instead of the landing page.
  writeFileSync(join(directory, 'donwells-data.json'), JSON.stringify({
    schemaVersion: 2,
    repos: [{ id: 'packaged-check-repo', path: repository, addedAt: new Date().toISOString() }],
    settings: {},
    // The in-app smoke probe asserts the window was restored to the off-screen
    // rectangle it hardcodes, so its profile must have persisted that state.
    ...(seedSmokeWindowState ? { windowState: { x: -100000, y: -100000, width: 1000, height: 700, maximized: false } } : {})
  }, null, 2), { mode: 0o600 })
  return directory
}

/**
 * The app is an Electron GUI, but an agent shell (and any CI wrapper that runs
 * inside another Electron app) may export ELECTRON_RUN_AS_NODE=1 for its own
 * child processes. Inherited, it makes Electron start as plain Node, so
 * `require('electron')` is undefined and the app dies before any window exists
 * -- a launch failure that looks exactly like a broken package. Strip it.
 */
const launchEnvironment = (userData) => {
  const environment = { ...process.env, DONWELLS_USER_DATA: userData, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
  delete environment['ELECTRON_RUN_AS_NODE']
  return environment
}

if (!values['skip-launch']) {
  const userData = disposableProfile()
  const { _electron: electron } = await import('@playwright/test')
  let application = null
  try {
    note('')
    note('Launching the packaged executable against a disposable profile')
    application = await electron.launch({
      executablePath: packaged.executable,
      env: launchEnvironment(userData)
    })
    const page = await application.firstWindow()

    const uncaught = []
    const consoleErrors = []
    page.on('pageerror', (error) => uncaught.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })

    // The full shell only mounts once the store has loaded and React has
    // rendered WorkspaceShell, so its landmark is proof the renderer ran.
    let shellMounted = true
    try {
      await page.getByRole('navigation', { name: 'Workspace navigation' }).waitFor({ state: 'visible', timeout: launchTimeout })
    } catch {
      shellMounted = false
    }

    const observed = await page.evaluate(() => ({
      rootChildren: document.getElementById('root')?.childElementCount ?? -1,
      appShell: document.querySelectorAll('.workspace-frame').length,
      bodyText: (document.body?.innerText ?? '').trim().length,
      errorFallback: document.body?.innerText?.includes('Something went wrong') ?? false,
      initializationError: document.body?.innerText?.includes('Workspace could not be loaded') ?? false,
      loading: document.body?.innerText?.includes('Loading donwells.ai') ?? false,
      preloadBridge: typeof window.donwells === 'object' && window.donwells !== null,
      title: document.title
    }))
    report.renderer = { ...observed, shellMounted, uncaught, consoleErrors }

    note(`  document.title            ${observed.title}`)
    note(`  #root children            ${observed.rootChildren}`)
    note(`  .workspace-frame          ${observed.appShell}`)
    note(`  body innerText length     ${observed.bodyText}`)
    note(`  window.donwells (preload) ${observed.preloadBridge}`)
    note(`  uncaught renderer errors  ${uncaught.length}`)

    if (observed.rootChildren <= 0) fail('renderer root element #root is empty (blank window)')
    if (observed.appShell === 0) fail('renderer never mounted the workspace shell (blank or failed window)')
    if (!shellMounted) fail('workspace shell landmark never became visible')
    if (observed.bodyText === 0) fail('renderer body is blank')
    if (observed.errorFallback) fail('renderer rendered the ErrorBoundary fallback ("Something went wrong")')
    if (observed.initializationError) fail('renderer reported "Workspace could not be loaded"')
    if (!observed.preloadBridge) fail('preload bridge window.donwells is missing')
    for (const message of uncaught) fail(`uncaught renderer error: ${message}`)
    for (const message of consoleErrors) note(`  renderer console error: ${message}`)
  } finally {
    if (application) await application.close().catch(() => undefined)
    rmSync(userData, { recursive: true, force: true })
  }
} else {
  note('Skipping packaged launch (--skip-launch)')
}

// ---------------------------------------------------------------------------
// 4. Optional: the in-app smoke probe (main process, node-pty, daemon, CLI)
// ---------------------------------------------------------------------------

if (values.smoke) {
  const userData = disposableProfile(true)
  try {
    note('')
    note('Running the in-app DONWELLS_SMOKE probe against the packaged executable')
    const result = await new Promise((resolvePromise) => {
      const child = spawn(packaged.executable, [], {
        env: { ...launchEnvironment(userData), DONWELLS_SMOKE: '1', DONWELLS_LOG_LEVEL: 'info' },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let output = ''
      child.stdout.on('data', (chunk) => { output += chunk })
      child.stderr.on('data', (chunk) => { output += chunk })
      const timer = setTimeout(() => child.kill('SIGKILL'), 180000)
      child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, output }) })
    })
    report.smoke = { exitCode: result.code, ready: result.output.includes('smoke:ready'), ok: result.output.includes('smoke:ok') }
    note(`  exit code ${result.code}, smoke:ready ${report.smoke.ready}, smoke:ok ${report.smoke.ok}`)
    if (result.code !== 0 || !report.smoke.ok) {
      fail(`in-app smoke probe did not pass (exit ${result.code})`)
      note(result.output.split('\n').filter((line) => /smoke|error|fatal/i.test(line)).slice(-20).join('\n'))
    }
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (values.json) {
  const target = resolve(root, values.json)
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`)
  note('')
  note(`Report written to ${target}`)
}

note('')
if (report.failures.length === 0) {
  note('check-packaged-renderer: OK')
  process.exit(0)
}
console.error(`\ncheck-packaged-renderer: ${report.failures.length} failure(s)`)
for (const message of report.failures) console.error(`  - ${message}`)
process.exit(1)
