// Headless smoke test: builds are run by `pnpm smoke` (build first, then this).
// Boots the built Electron app with temp userData + ORCA_LITE_SMOKE=1; the app
// runs the full main-side surface (git worktree lifecycle + PTY round-trip)
// against a real temp repo, prints smoke:ready then smoke:ok/fail, exits 0/1.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const electronBinary = join(
  root,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : process.platform === 'win32' ? 'electron.exe' : 'electron'
)

const userData = mkdtempSync(join(tmpdir(), 'orca-lite-smoke-'))

const exit = await new Promise((resolve) => {
  const app = spawn(electronBinary, [root], {
    env: { ...process.env, ORCA_LITE_USER_DATA: userData, ORCA_LITE_SMOKE: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  app.stdout.on('data', (d) => (out += String(d)))
  app.stderr.on('data', (d) => (out += String(d)))
  const timer = setTimeout(() => {
    console.error('smoke: timeout — no exit after 60s\n' + out.slice(-2000))
    app.kill()
    resolve(1)
  }, 60000)
  app.on('exit', (code) => {
    clearTimeout(timer)
    const hasReady = out.includes('smoke:ready')
    const ok = out.includes('smoke:ok')
    const fail = out.match(/smoke:fail (.*)/)
    console.log(out.trim())
    if (code !== 0 || !hasReady || !ok) {
      if (fail) console.error('\nSMOKE FAILED: ' + fail[1])
      else if (!hasReady) console.error('\nSMOKE FAILED: app never reached ready')
      resolve(1)
    } else {
      resolve(0)
    }
  })
})

rmSync(userData, { recursive: true, force: true })
process.exit(exit)