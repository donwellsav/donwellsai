import { execFileSync } from 'node:child_process'
import { lstatSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Stop the disposable terminal daemons this run leaves behind, and clear the
 * sockets they orphaned.
 *
 * The daemon is deliberately detached and refuses to exit while it owns live
 * sessions, so closing the app does not reap it. That is correct for a real
 * profile - agents must outlive a GUI restart - but wrong for a test profile
 * whose directory is deleted moments later. Left alone, each run strands ~24
 * Electron daemons holding ~99 MB each; after a few runs the machine can no
 * longer spawn child processes and unrelated tests fail with `posix_spawnp`.
 *
 * Killing a daemon does not unlink its socket, so the runtime directory also
 * accumulates dead `.sock` entries. Those eventually collide with new binds -
 * one suite run failed six tests with `EACCES` on a fresh socket path - so they
 * are cleared here, but only when no live process still holds them.
 *
 * Only daemons whose profile argument looks like this suite's disposable
 * `donwells-*-e2e-` directory are matched, so a developer's own running app and
 * its daemon are never touched. SIGKILL is required because these processes
 * ignore SIGTERM once orphaned.
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
  if (stranded.length > 0) {
    console.log(`Stopping ${stranded.length} terminal daemon(s) stranded by this run.`)
    try {
      execFileSync('pkill', ['-9', '-f', pattern])
    } catch {
      // Nothing left to signal.
    }
    const survivors = matching()
    if (survivors.length > 0) throw new Error(`${survivors.length} terminal daemon(s) survived global teardown`)
  }

  const cleared = clearOrphanedSockets()
  if (cleared > 0) console.log(`Cleared ${cleared} orphaned terminal socket(s).`)
}

/**
 * Remove socket files under this suite's runtime directories that no process
 * holds. A live instance - including a developer's own - keeps its socket.
 */
function clearOrphanedSockets(): number {
  let cleared = 0
  // The daemon's runtime base is /tmp on macOS and Linux; os.tmpdir() is the
  // per-user directory and does not contain it, so both are searched.
  const bases = [...new Set(['/tmp', tmpdir()])]
  for (const directory of bases.flatMap((base) => {
    let names: string[]
    try {
      names = readdirSync(base)
    } catch {
      return []
    }
    return names.filter((name) => name.startsWith('donwells-')).map((name) => join(base, name))
  })) {
    let names: string[]
    try {
      names = readdirSync(directory)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.includes('.sock')) continue
      const candidate = join(directory, name)
      try {
        if (!lstatSync(candidate).isSocket()) continue
      } catch {
        continue
      }
      try {
        // Prints a pid and exits 0 while some process still holds it.
        execFileSync('lsof', ['-t', candidate], { stdio: 'pipe' })
        continue
      } catch (cause) {
        // Only an exit status means "nobody holds it". If lsof itself is missing,
        // restricted, or fails for another reason, we have learned nothing, and
        // unlinking could take a live instance's socket with it.
        const status = (cause as NodeJS.ErrnoException & { status?: number }).status
        if (typeof status !== 'number') continue
      }
      rmSync(candidate, { force: true })
      cleared += 1
    }
  }
  return cleared
}
