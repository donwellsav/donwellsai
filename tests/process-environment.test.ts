import { expect, it } from 'vitest'
import { configureDesktopPath, sanitizedProcessEnv } from '../src/shared/child-process/process-environment'
import { AgentRegistry } from '../src/main/agents/registry'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

it('finds user CLI tools and their child interpreters after a Finder launch, preserving explicit precedence', () => {
  const home = mkdtempSync(join(tmpdir(), 'desktop-path-'))
  try {
    const bin = join(home, '.local/bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'desktop-path-check'), '#!/usr/bin/env sh\nprintf desktop-path-ok')
    chmodSync(join(bin, 'desktop-path-check'), 0o755)
    const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', DONWELLS_DAEMON_TOKEN: 'private' }
    configureDesktopPath(env, 'darwin', home)
    const configured = env.PATH
    configureDesktopPath(env, 'darwin', home)
    expect(env.PATH).toBe(configured)
    expect(env.PATH.startsWith('/usr/bin:/bin:/usr/sbin:/sbin:')).toBe(true)
    const childEnv = sanitizedProcessEnv(env)
    expect(childEnv.DONWELLS_DAEMON_TOKEN).toBeUndefined()
    const executable = new AgentRegistry({ env: childEnv }).findExecutable('desktop-path-check')
    expect(executable).toBe(join(bin, 'desktop-path-check'))
    expect(execFileSync(executable!, [], { env: childEnv, encoding: 'utf8' })).toBe('desktop-path-ok')
    for (const platform of ['linux', 'win32'] as const) {
      const untouched = { PATH: 'custom-path' }
      configureDesktopPath(untouched, platform, home)
      expect(untouched.PATH).toBe('custom-path')
    }
    const empty: NodeJS.ProcessEnv = {}
    configureDesktopPath(empty, 'darwin', home)
    expect(empty.PATH?.split(':')).toContain('/usr/bin')
    expect(empty.PATH?.split(':')).not.toContain('')
  } finally { rmSync(home, { recursive: true, force: true }) }
})
