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

// ---------------------------------------------------------------------------
// Provider-isolated environments (Stage 3, managed/none launches)
//
// A managed or `none` provider child starts from an ALLOWLIST, never from the
// parent environment with known credential keys removed: a key name nobody
// thought to add to a denylist would otherwise survive, and the child would
// inherit an auth store, home directory, or credential helper it was never
// authorized to read. Everything outside the allowlist simply does not exist
// for the child.
//
// The child's home and every config/data/cache root it derives from it point at
// one private per-launch directory, so the driver's own fallback auth files
// (`~/.codex/auth.json`, `~/.claude/.credentials.json`, keychain-adjacent
// helper config, ...) resolve inside that empty directory rather than in the
// user's real home, and the `credentialMode: 'external'` path keeps its
// inherited external authentication because it never builds one of these.
// ---------------------------------------------------------------------------

/**
 * The complete set of variables a managed/none provider child may inherit.
 *
 * Deliberately absent: every home-directory and user-profile variable
 * (`HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, ...), every driver auth or
 * config variable (`OPENAI_API_KEY`, `ANTHROPIC_*`, `*_TOKEN`, `OPENCODE_CONFIG_DIR`,
 * `HERMES_HOME`, `DSH_HOME`, ...), and the app's own private keys. Those are
 * either supplied by the isolated root or by the broker's exact overlay.
 */
export const PROVIDER_ISOLATION_ALLOWLIST: readonly string[] = [
  // Process basics the C runtime and a shell need; none of them name a store.
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'TERM',
  'COLORTERM',
  'TMPDIR',
  'SHELL',
  'USER',
  'LOGNAME',
  'NUMBER_OF_PROCESSORS',
  // Windows needs its own system roots to start a process at all; the user
  // profile roots are intentionally excluded above.
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'PROCESSOR_ARCHITECTURE',
  'TEMP',
  'TMP'
]

/**
 * Home and config roots the isolated child is given, all inside one private
 * per-launch directory. A driver that honors any of the XDG names, or the
 * platform-native equivalents, therefore writes only inside the isolated root.
 */
export const PROVIDER_ISOLATION_ROOT_VARIABLES: readonly string[] = [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'TMPDIR',
  'TEMP',
  'TMP'
]

export type IsolatedProviderEnvironmentInput = Readonly<{
  /** Private per-launch directory (`0700`) that becomes the child's home. */
  isolationRoot: string
  /** Parent environment; only allowlisted names are read from it. */
  inherited?: NodeJS.ProcessEnv
  /** Driver-declared variables already pointed inside the isolated root. */
  driverEnvironment?: NodeJS.ProcessEnv
  /**
   * The exact broker result for a managed launch. These are the only values
   * that may carry credential material, and each one is overwritten rather than
   * merged, so an inherited value can never win.
   */
  credentialEnvironment?: Readonly<Record<string, string>>
}>

/**
 * Builds the complete child environment for a managed/none provider launch.
 *
 * Every credential value arrives through `credentialEnvironment` (the broker's
 * exact result) and is written last, so nothing inherited can shadow or survive
 * alongside it. `none` passes no credential environment and still gets the same
 * isolation, because "no credential" means "no auth material available to this
 * child at all", not "the parent's auth material is fine".
 */
export function isolatedProviderEnvironment(input: IsolatedProviderEnvironmentInput): NodeJS.ProcessEnv {
  const root = input.isolationRoot
  if (typeof root !== 'string' || root.length === 0 || root.includes('\0')) {
    throw new Error('an isolated provider environment requires a private isolation root')
  }
  const inherited = input.inherited ?? process.env
  const environment: NodeJS.ProcessEnv = {}
  for (const key of PROVIDER_ISOLATION_ALLOWLIST) {
    const value = inherited[key]
    if (value !== undefined) environment[key] = value
  }
  const configRoot = join(root, 'config')
  const dataRoot = join(root, 'data')
  const stateRoot = join(root, 'state')
  const cacheRoot = join(root, 'cache')
  environment['HOME'] = root
  environment['USERPROFILE'] = root
  environment['APPDATA'] = configRoot
  environment['LOCALAPPDATA'] = dataRoot
  environment['XDG_CONFIG_HOME'] = configRoot
  environment['XDG_DATA_HOME'] = dataRoot
  environment['XDG_CACHE_HOME'] = cacheRoot
  environment['XDG_STATE_HOME'] = stateRoot
  environment['XDG_RUNTIME_DIR'] = stateRoot
  environment['TMPDIR'] = stateRoot
  environment['TEMP'] = stateRoot
  environment['TMP'] = stateRoot
  for (const [key, value] of Object.entries(input.driverEnvironment ?? {})) {
    if (value === undefined) continue
    environment[key] = value
  }
  for (const [key, value] of Object.entries(input.credentialEnvironment ?? {})) {
    environment[key] = value
  }
  return environment
}
