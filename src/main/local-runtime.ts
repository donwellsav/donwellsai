import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'

export type RuntimeIdentity = { socketPath: string; authToken: string; pid?: number }
export type LocalRuntimePaths = {
  runtimeDir: string
  runtimeFile: string
  socketDir: string
  socketPath: string
}

export function localRuntimePaths(
  userDataDir: string,
  kind: 'app' | 'terminal',
  platform: NodeJS.Platform = process.platform
): LocalRuntimePaths {
  const path = platform === 'win32' ? win32 : posix
  let profile = path.resolve(userDataDir)
  if (platform === process.platform) {
    try { profile = realpathSync(profile) } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    }
  }
  const runtimeDir = kind === 'terminal' ? path.join(profile, 'terminal-daemon') : profile
  const runtimeFile = path.join(runtimeDir, kind === 'terminal' ? 'runtime.json' : 'donwells-runtime.json')
  const profileKey = createHash('sha256')
    .update(platform === 'win32' ? profile.toLowerCase() : profile)
    .digest('hex')
    .slice(0, 24)
  if (platform === 'win32') {
    return { runtimeDir, runtimeFile, socketDir: runtimeDir,
      socketPath: String.raw`\\.\pipe\donwells-${kind}-` + profileKey }
  }
  const directoryName = 'donwells-' + kind + '-' + (process.getuid?.() ?? 'user')
  let socketDir = path.join(tmpdir(), directoryName)
  const fileName = profileKey + '.sock'
  // Darwin's sockaddr_un is the narrowest supported Unix endpoint.
  if (Buffer.byteLength(path.join(socketDir, fileName)) > 103) socketDir = path.join('/tmp', directoryName)
  return { runtimeDir, runtimeFile, socketDir, socketPath: path.join(socketDir, fileName) }
}

/** Missing or invalid discovery is unverifiable, never evidence of process death. */
export function readRuntimeIdentity(runtimeFile: string): RuntimeIdentity | null {
  try {
    const stat = lstatSync(runtimeFile)
    if (!stat.isFile() || stat.size > 64 * 1024) return null
    const parsed: unknown = JSON.parse(readFileSync(runtimeFile, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    if (!('socketPath' in parsed) || typeof parsed.socketPath !== 'string' || !parsed.socketPath) return null
    if (!('authToken' in parsed) || typeof parsed.authToken !== 'string' || !parsed.authToken) return null
    const pid = 'pid' in parsed && typeof parsed.pid === 'number' && Number.isSafeInteger(parsed.pid) && parsed.pid > 0
      ? parsed.pid : undefined
    return { socketPath: parsed.socketPath, authToken: parsed.authToken, pid }
  } catch {
    return null
  }
}

export function readTerminalRuntime(userDataDir: string): RuntimeIdentity | null {
  const current = localRuntimePaths(userDataDir, 'terminal').runtimeFile
  return readRuntimeIdentity(existsSync(current) ? current : join(userDataDir, 'terminal-runtime.json'))
}
