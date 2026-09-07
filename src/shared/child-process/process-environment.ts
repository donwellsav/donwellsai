import { homedir } from 'node:os'
import { join } from 'node:path'

/** Finder does not inherit the user's terminal PATH. Preserve explicit tool precedence. */
export function configureDesktopPath(env = process.env, platform = process.platform, home = homedir()): void {
  if (platform !== 'darwin') return
  // ponytail: standard CLI install locations only; custom locations still use an explicit PATH or executable.
  env.PATH = [...new Set([
    ...(env.PATH ?? '').split(':').filter(Boolean),
    join(home, '.local/bin'), join(home, '.bun/bin'), join(home, '.kimi-code/bin'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'
  ])].join(':')
}

const PRIVATE_PROCESS_KEYS: Record<string, true> = {
  DONWELLS_DAEMON_TOKEN: true,
  ELECTRON_RUN_AS_NODE: true
}

/** Strip inherited app authority and the outer terminal integration before spawning. */
export function sanitizedProcessEnv(
  source: NodeJS.ProcessEnv = process.env,
  additions: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {}
  const outerProgram = source.TERM_PROGRAM?.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
  const outerPrefix = outerProgram ? `${outerProgram}_` : undefined
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && PRIVATE_PROCESS_KEYS[key] !== true &&
      (!outerPrefix || !key.startsWith(outerPrefix))) clean[key] = value
  }
  for (const [key, value] of Object.entries(additions)) {
    if (value === undefined) delete clean[key]
    else clean[key] = value
  }
  return clean
}
