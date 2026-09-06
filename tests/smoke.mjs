import { appendTail, cleanupOwnedSmokeDaemon } from './helpers/smoke-processes.mjs'
// Headless smoke test: builds are run by `pnpm smoke` (build first, then this).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const electronBinary = join(
  root,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'darwin'
    ? 'Electron.app/Contents/MacOS/Electron'
    : process.platform === 'win32'
      ? 'electron.exe'
      : 'electron'
)
const userData = mkdtempSync(join(tmpdir(), 'donwells-smoke-'))

const exitResult = Promise.withResolvers()
const app = spawn(electronBinary, [root], {
  env: { ...process.env, DONWELLS_USER_DATA: userData, DONWELLS_SMOKE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
  windowsHide: true
})
let out = ''
app.stdout.on('data', (chunk) => { out = appendTail(out, chunk) })
app.stderr.on('data', (chunk) => { out = appendTail(out, chunk) })
const appTimer = setTimeout(() => {
  console.error('smoke: timeout — no exit after 60s\n' + out.slice(-2000))
  app.kill()
  exitResult.resolve(1)
}, 60000)
app.once('error', (error) => {
  clearTimeout(appTimer)
  console.error('smoke: app spawn failed: ' + error.message)
  exitResult.resolve(1)
})
app.once('exit', (code) => {
  clearTimeout(appTimer)
  const hasReady = out.includes('smoke:ready')
  const ok = out.includes('smoke:ok')
  const fail = out.match(/smoke:fail (.*)/)
  console.log(out.trim())
  if (code !== 0 || !hasReady || !ok) {
    if (fail) console.error('\nSMOKE FAILED: ' + fail[1])
    else if (!hasReady) console.error('\nSMOKE FAILED: app never reached ready')
    exitResult.resolve(1)
  } else {
    exitResult.resolve(0)
  }
})
const exit = await exitResult.promise

const safeToRemoveProfile = await cleanupOwnedSmokeDaemon(userData)
if (safeToRemoveProfile) {
  rmSync(userData, { recursive: true, force: true })
} else {
  console.error('smoke: cleanup refused; daemon ownership or idleness was not proven: ' + userData)
}
process.exit(exit === 0 && safeToRemoveProfile ? 0 : 1)
