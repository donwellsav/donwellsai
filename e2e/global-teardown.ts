import { execFileSync } from 'node:child_process'

/**
 * Stop the disposable terminal daemons this run leaves behind.
 *
 * The daemon is deliberately detached and refuses to exit while it owns live
 * sessions, so closing the app does not reap it. That is correct for a real
 * profile - agents must outlive a GUI restart - but wrong for a test profile
 * whose directory is deleted moments later. Left alone, each run strands ~28
 * Electron daemons holding ~99 MB each; after a few runs the machine can no
 * longer spawn child processes and unrelated tests fail with `posix_spawnp`.
 *
 * Only daemons whose profile argument looks like this suite's disposable
 * `donwells-*-e2e-` directory are matched, so a developer's own running app and
 * its daemon are never touched. SIGKILL is used because these processes ignore
 * SIGTERM once their parent is gone.
 */
export default function globalTeardown(): void {
  if (process.platform === 'win32') return
  const pattern = 'terminal-daemon-entry\\.js .*donwells-[a-z-]*-e2e-'
  const matching = (): string[] => {
    try {
      return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

  const stranded = matching()
  if (stranded.length === 0) return
  console.log(`Stopping ${stranded.length} terminal daemon(s) stranded by this run.`)
  try {
    execFileSync('pkill', ['-9', '-f', pattern])
  } catch {
    // Nothing left to signal.
  }

  const survivors = matching()
  if (survivors.length > 0) throw new Error(`${survivors.length} terminal daemon(s) survived global teardown`)
}
