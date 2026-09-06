'use strict'

const { spawnSync } = require('node:child_process')
const { writeFileSync, renameSync } = require('node:fs')
const { join } = require('node:path')

const mode = process.argv[2]

if (mode === 'hook' || mode === 'wrong-hook' || mode === 'permission-wait') {
  const hookEnv = mode === 'wrong-hook'
    ? { ...process.env, DONWELLS_AGENT_HOOK_TOKEN: 'wrong-token' }
    : process.env
  const emitted = spawnSync(
    process.execPath,
    [join(__dirname, 'agent-hook-emitter.cjs'), 'permission', 'fixture permission ✓'],
    { env: hookEnv, encoding: 'utf8' }
  )
  if (emitted.stdout) process.stdout.write(emitted.stdout)
  if (emitted.stderr) process.stderr.write(emitted.stderr)
  console.log(`DAEMON_TOKEN_VISIBLE=${process.env.DONWELLS_DAEMON_TOKEN ? 'yes' : 'no'}`)
  if (mode === 'permission-wait' && emitted.status === 0) {
    console.log('AGENT_READY')
    const keepAlive = setInterval(() => {}, 1_000)
    process.on('SIGINT', () => {
      clearInterval(keepAlive)
      process.exit(130)
    })
  } else {
    process.exitCode = emitted.status ?? 6
  }
} else if (mode === 'binding') {
  writeFileSync(process.argv[3] + '.tmp', JSON.stringify({ runId: process.env.DONWELLS_AGENT_HOOK_RUN_ID, sessionId: process.env.DONWELLS_AGENT_HOOK_SESSION_ID, token: process.env.DONWELLS_AGENT_HOOK_TOKEN }), { mode: 0o600 })
  renameSync(process.argv[3] + '.tmp', process.argv[3])
  setInterval(() => {}, 1_000)
} else if (mode === 'wait') {
  const markerPath = process.argv[3]
  console.log('AGENT_READY')
  const markerTimer = setTimeout(() => {
    if (markerPath) writeFileSync(markerPath, 'continued after interrupt', 'utf8')
  }, 1_500)
  const keepAlive = setInterval(() => {}, 1_000)
  process.on('SIGINT', () => {
    clearTimeout(markerTimer)
    clearInterval(keepAlive)
    console.log('AGENT_INTERRUPTED')
    process.exit(130)
  })
} else if (mode === 'input') {
  console.log('AGENT_READY')
  process.stdin.setEncoding('utf8')
  process.stdin.once('data', (data) => {
    console.log('AGENT_INPUT=' + JSON.stringify(data))
    process.exit(0)
  })
} else if (mode === 'finite') {
  console.log('AGENT_FINISHED')
} else {
  console.error('unknown fixture mode')
  process.exitCode = 2
}
