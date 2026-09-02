import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Git worktree admin fingerprint — subprocess-free change detector for a repo's
 * worktree admin area (mirrors upstream worktree-scan-fingerprint.md).
 *
 * Inputs: stat/readdir on the `.git` resolution chain, per-worktree admin files
 * (HEAD, gitdir, locked), packed-refs, and loose refs. A commit rewrites
 * refs/heads/<branch> (which git worktree list prints as HEAD oid) without
 * touching HEAD itself, so loose ref names AND mtimes are probed.
 * Any read failure means null: "cannot prove unchanged".
 */
export function readRepoWorktreeAdminFingerprint(repoPath: string): string | null {
  try {
    const parts: string[] = []

    // --- resolve the common git dir without a subprocess ---
    let dotGit = join(repoPath, '.git')
    let commonDir: string
    if (statSync(dotGit).isDirectory()) {
      commonDir = dotGit
    } else {
      // .git file → gitdir: pointer (worktree-registered repo)
      const pointer = readFileSync(dotGit, 'utf8').trim()
      const m = pointer.match(/^gitdir: (.+)$/)
      if (!m) return null
      const gitDir = realpathSync(m[1])
      const commondirFile = join(gitDir, 'commondir')
      if (existsSync(commondirFile)) {
        const rel = readFileSync(commondirFile, 'utf8').trim()
        commonDir = realpathSync(join(gitDir, rel))
      } else {
        commonDir = gitDir
      }
    }
    parts.push(`commondir=${statSync(commonDir).mtimeMs}`)
    parts.push(`worktrees=${readdirSafe(join(commonDir, 'worktrees'))?.join(',') ?? '∅'}`)

    // --- per-checkout probes: main + every linked worktree under commonDir/worktrees ---
    const checkouts: string[] = [repoPath]
    const wtRoot = join(commonDir, 'worktrees')
    const linked = readdirSafe(wtRoot)
    if (linked) for (const name of linked) checkouts.push(join(wtRoot, name))

    for (const co of checkouts) {
      // HEAD of the checkout: main reads .git/HEAD directly; linked read admin HEAD
      const headPath = co === repoPath ? join(commonDir, 'HEAD') : join(co, 'HEAD')
      if (existsSync(headPath)) {
        const st = statSync(headPath)
        parts.push(`head:${co}=${st.mtimeMs}:${st.size}`)
        // follow symref target only when relative under refs/ (hand-edited HEAD can't steer outside)
        const head = readFileSync(headPath, 'utf8').trim()
        const sym = head.match(/^ref: (refs\/.+)$/)
        if (sym) parts.push(`looseref:${sym[1]}=${looseRefStamp(commonDir, sym[1])}`)
      }
      // linked worktree admin: gitdir pointer + lock marker
      if (co !== repoPath) {
        const gitdirPath = join(co, 'gitdir')
        if (existsSync(gitdirPath)) {
          const st = statSync(gitdirPath)
          parts.push(`gitdir:${co}=${st.mtimeMs}:${st.size}`)
        }
        parts.push(`locked:${co}=${existsSync(join(co, 'locked'))}`)
      }
    }

    // --- shared ref store: packed-refs + loose ref names (dir listing only) ---
    const packed = join(commonDir, 'packed-refs')
    if (existsSync(packed)) {
      const st = statSync(packed)
      parts.push(`packed-refs=${st.mtimeMs}:${st.size}`)
    }
    parts.push(`lorefs=${refDirStamp(join(commonDir, 'refs'))}`)

    return parts.join('\u0000')
  } catch {
    return null
  }
}

/** Loose ref stamp: mtime of the ref file itself when it exists (a commit rewrites it). */
function looseRefStamp(commonDir: string, ref: string): string {
  const p = join(commonDir, ref)
  if (!existsSync(p)) return 'absent'
  const st = statSync(p)
  return `${st.mtimeMs}:${st.size}`
}

/** Recursive directory stamp: names + mtimes, one level deep enough for refs/{heads,tags}. */
function refDirStamp(dir: string): string {
  const names = readdirSafe(dir)
  if (!names) return '∅'
  const stamps = names
    .map((n) => {
      const p = join(dir, n)
      try {
        const st = statSync(p)
        return st.isDirectory() ? `${n}/${refDirStamp(p)}` : `${n}:${st.mtimeMs}`
      } catch {
        return n
      }
    })
    .sort()
  return stamps.join(',')
}

function readdirSafe(dir: string): string[] | null {
  try {
    return readdirSync(dir)
  } catch {
    return null
  }
}