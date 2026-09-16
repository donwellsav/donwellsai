// @vitest-environment node
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PtyManager } from './pty'
import { isolatedProviderEnvironment } from '@shared/child-process/process-environment'

/**
 * The PTY's exact-environment mode (Stage 3, managed/none provider launches).
 *
 * A managed launch's isolation contract is an allowlist. The PTY normally merges
 * sanitized additions over the daemon's own environment, which is right for an
 * interactive agent but would hand a managed child the real `HOME`, the app's
 * private authority, and every credential variable the driver can read. These
 * prove the child's environment is exactly what the isolation builder produced.
 */

const directories: string[] = []
const terminals: PtyManager[] = []

afterEach(() => {
  for (const terminal of terminals.splice(0)) {
    for (const session of terminal.list()) {
      try { terminal.close(session.id) } catch { /* already reaped */ }
    }
  }
  while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true })
})

function scratch(): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pty-isolation-')))
  directories.push(directory)
  return directory
}

/**
 * Runs one child under the given options and returns the environment the OS
 * actually handed it.
 *
 * The child writes its environment to a file, so the assertion reads one
 * complete document. Completion is awaited on the PTY's own exit signal rather
 * than a guessed duration: the daemon-side pump is what reports it, so there is
 * no wall-clock wait anywhere.
 */
async function childEnvironment(options: { exactEnv?: boolean }): Promise<NodeJS.ProcessEnv> {
  const directory = scratch()
  const out = join(directory, 'env.json')
  const script = join(directory, 'dump.cjs')
  writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env))`, { mode: 0o600 })

  const { promise, resolve } = Promise.withResolvers<void>()
  const terminal = new PtyManager({ data: () => undefined, exit: () => resolve(), title: () => undefined })
  terminals.push(terminal)

  const env = options.exactEnv === true
    ? { PATH: process.env['PATH'] ?? '/usr/bin:/bin', MARKER: 'exact-only' }
    : { MARKER: 'merged' }
  terminal.openAgent(directory, '', 80, 24, {
    id: 'probe-session',
    env,
    launch: { executable: process.execPath, args: [script] },
    ...(options.exactEnv === true ? { exactEnv: true } : {})
  })

  // The child has written its environment before it exits, and the exit signal
  // is the daemon's own completion event, so the file is complete here.
  await promise
  return JSON.parse(readFileSync(out, 'utf8')) as NodeJS.ProcessEnv
}

describe('PTY exact environment (managed provider isolation)', () => {
  it('gives an exact-env child ONLY the supplied variables', async () => {
    const child = await childEnvironment({ exactEnv: true })
    // The supplied variable is present; nothing else from the parent is.
    expect(child['MARKER']).toBe('exact-only')
    expect(child['HOME']).toBeUndefined()
    expect(child['DONWELLS_DAEMON_TOKEN']).toBeUndefined()
  })

  it('still merges sanitized additions for an ordinary interactive launch', async () => {
    const child = await childEnvironment({})
    expect(child['MARKER']).toBe('merged')
    // The interactive path keeps the parent environment, which is exactly what
    // an external-mode agent needs, so HOME survives there.
    expect(typeof child['HOME']).toBe('string')
    // The daemon's own authority is stripped in both modes.
    expect(child['DONWELLS_DAEMON_TOKEN']).toBeUndefined()
    expect(child['ELECTRON_RUN_AS_NODE']).toBeUndefined()
  })

  it('composes an isolated environment that excludes the parent home and credentials', () => {
    const root = scratch()
    const isolated = isolatedProviderEnvironment({
      isolationRoot: root,
      inherited: { ...process.env, OPENAI_API_KEY: 'sk-parent-must-not-survive' },
      credentialEnvironment: { SELECTED: 'only-this' }
    })
    // The child's home and every derived root point inside its own directory.
    expect(isolated['HOME']).toBe(root)
    expect(isolated['XDG_CONFIG_HOME']).toBe(join(root, 'config'))
    // An inherited credential variable is not carried, and the broker's exact
    // value is the only credential-shaped entry.
    expect(isolated['OPENAI_API_KEY']).toBeUndefined()
    expect(isolated['SELECTED']).toBe('only-this')
  })
})
