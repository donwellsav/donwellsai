// In-app smoke probe: when DONWELLS_SMOKE=1, main runs this after window load.
// It exercises the real main-side surface the IPC handlers call — GitWorktrees
// (addRepo/createWorktree/list/removeWorktree) and PtyManager (spawn → write →
// data round-trip → close → remove) — against a real temp git repo, then prints
// `smoke:ok <details>` / `smoke:fail <reason>` and exits 0/1.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { GitWorktrees } from './git'
import { PtyManager } from './pty'

export async function runSmokeProbe(git: GitWorktrees): Promise<boolean> {
  const root = mkdtempSync(join(tmpdir(), 'donwells-probe-'))
  const repo = join(root, 'proj')
  const results: string[] = []
  try {
    mkdirSync(repo, { recursive: true })
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'pipe' })
    execFileSync('git', ['config', 'user.email', 'smoke@donwells.ai'], { cwd: repo, stdio: 'pipe' })
    execFileSync('git', ['config', 'user.name', 'donwells.ai Smoke'], { cwd: repo, stdio: 'pipe' })
    writeFileSync(join(repo, 'readme.md'), '# probe\n')
    execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'pipe' })

    // 1. addRepo
    const summary = await git.addRepo(repo)
    if (summary.worktrees.length !== 1 || !summary.worktrees[0]!.isMain)
      throw new Error('addRepo parse failed: ' + JSON.stringify(summary.worktrees))
    results.push('addRepo')

    // 2. createWorktree
    const created = await git.createWorktree(repo, { name: 'feature/x' })
    const feat = created.worktrees.find((w) => w.branch === 'feature/x')
    if (!feat) throw new Error('createWorktree failed')
    results.push('createWorktree')

    // 3. Terminal round-trip via a fresh PtyManager (same class the IPC uses)
    const events: { data: (id: string, d: string) => void; exit: (id: string, c: number) => void; title: (id: string, t: string) => void } = {
      data: () => {},
      exit: () => {},
      title: () => {}
    }
    const pty = new PtyManager({
      data: (id, d) => events.data(id, d),
      exit: (id, c) => events.exit(id, c),
      title: (id, t) => events.title(id, t)
    })
    const session = pty.open(feat.path, 80, 24)
    let acc = ''
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (acc.includes('PROBE_OK')) {
          clearInterval(timer)
          resolve()
        }
      }, 50)
      events.data = (id, d) => {
        if (id === session.id) acc += d
      }
      setTimeout(() => {
        clearInterval(timer)
        resolve()
      }, 5000)
      pty.write(session.id, 'echo PROBE_OK\n')
    })
    if (!acc.includes('PROBE_OK')) throw new Error('terminal output never arrived: ' + JSON.stringify(acc.slice(0, 300)))
    results.push('terminal-data')
    pty.close(session.id)
    if (pty.has(session.id)) throw new Error('closeTerminal did not release session')
    results.push('terminal-close')

    // 4. removeWorktree
    const after = await git.removeWorktree(repo, feat.path)
    if (after.worktrees.some((w) => w.branch === 'feature/x')) throw new Error('removeWorktree failed')
    results.push('removeWorktree')

    console.log('smoke:ok ' + results.join(' | '))
    return true
  } catch (err) {
    console.log('smoke:fail ' + (err instanceof Error ? err.message : String(err)))
    return false
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}