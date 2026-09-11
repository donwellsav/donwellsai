// In-app smoke probe: when DONWELLS_SMOKE=1, main runs this after window load.
// It exercises the real main-side surface the IPC handlers call — GitWorktrees
// (addRepo/createWorktree/list/removeWorktree) and PtyManager (spawn → write →
// data round-trip → close → remove) — against a real temp git repo, then prints
// `smoke:ok <details>` / `smoke:fail <reason>` and exits 0/1.
import { logger } from '@shared/logger'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@shared/child-process/run-process'
import type { GitWorktrees } from './git'
import { PtyManager } from './pty'
import { screen, type BrowserWindow } from 'electron'
import { restoreWindowBounds } from './window-bounds'

async function runGit(cwd: string, args: string[]): Promise<void> {
  await runProcess({ program: 'git', args, cwd, timeoutMs: 10_000, maxOutputBytes: 1024 * 1024 })
}

export async function runSmokeProbe(git: GitWorktrees, window: BrowserWindow): Promise<boolean> {
  const root = mkdtempSync(join(tmpdir(), 'donwells-probe-'))
  const repo = join(root, 'proj')
  const results: string[] = []
  let pty: PtyManager | null = null
  let smokeSessionId: string | null = null
  try {
    const saved = { x: -100000, y: -100000, width: 1000, height: 700 }
    const expected = restoreWindowBounds(saved, screen.getDisplayMatching(saved).workArea)
    const actual = window.getBounds()
    if (Object.entries(expected).some(([key, value]) => actual[key as keyof typeof actual] !== value)) {
      throw new Error('Saved window bounds were not restored on screen: ' + JSON.stringify({ expected, actual }))
    }
    results.push('window-bounds-restore')
    mkdirSync(repo, { recursive: true })
    await runGit(repo, ['init', '-b', 'main'])
    await runGit(repo, ['config', 'user.email', 'smoke@donwells.ai'])
    await runGit(repo, ['config', 'user.name', 'donwells.ai Smoke'])
    writeFileSync(join(repo, 'readme.md'), '# probe\n')
    await runGit(repo, ['add', '.'])
    await runGit(repo, ['commit', '-m', 'init'])

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
    pty = new PtyManager({
      data: (id, d) => events.data(id, d),
      exit: (id, c) => events.exit(id, c),
      title: (id, t) => events.title(id, t)
    })
    const manager = pty
    const session = manager.open(feat.path, 80, 24)
    smokeSessionId = session.id
    let acc = ''
    const outputReceived = Promise.withResolvers<void>()
    events.data = (id, d) => {
      if (id !== session.id) return
      acc += d
      if (acc.includes('PROBE_OK')) outputReceived.resolve()
    }
    const outputDeadline = setTimeout(outputReceived.resolve, 5000)
    manager.write(session.id, 'echo PROBE_OK\n')
    await outputReceived.promise
    clearTimeout(outputDeadline)
    if (!acc.includes('PROBE_OK')) throw new Error('terminal output never arrived: ' + JSON.stringify(acc.slice(0, 300)))
    results.push('terminal-data')
    await manager.close(session.id)
    smokeSessionId = null
    if (manager.has(session.id)) throw new Error('closeTerminal did not release session')
    results.push('terminal-close')

    // 4. removeWorktree
    const after = await git.removeWorktree(repo, feat.path)
    if (after.worktrees.some((w) => w.branch === 'feature/x')) throw new Error('removeWorktree failed')
    results.push('removeWorktree')

    const memoryRequest = { workspacePath: repo, kind: 'convention', title: 'Recovery smoke', content: 'Saved exactly once', tags: [], attribution: { harness: 'human' } }
    const memoryDraft = { workspacePath: repo, entry: null, draft: { ...memoryRequest, tags: '', sourceRef: '' } }
    await window.webContents.executeJavaScript(`window.donwells.guiDraftsWrite('memory-editor', ${JSON.stringify(JSON.stringify([['editor', memoryDraft]]))})`)
    await window.webContents.executeJavaScript(`window.donwells.projectMemoryCreate(${JSON.stringify(memoryRequest)})`)
    await window.webContents.executeJavaScript(`window.donwells.guiDraftsWrite('smoke-recovery', JSON.stringify([['fixture', {text: 'unsent draft', destination: 'fixture-session'}]]))`)
    const reloaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Renderer did not recover after crash')), 10000)
      window.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve() })
    })
    window.webContents.forcefullyCrashRenderer()
    await reloaded
    const recovered: Array<[string, string]> = await window.webContents.executeJavaScript('window.donwells.guiDraftsRead()')
    const retained = recovered.find(([name]) => name === 'smoke-recovery')
    if (!retained || JSON.parse(retained[1])[0][1].text !== 'unsent draft') throw new Error('Renderer crash lost the authored draft')
    if (JSON.parse(recovered.find(([name]) => name === 'memory-editor')?.[1] ?? '[]').length) throw new Error('Acknowledged memory draft returned after renderer crash')
    await window.webContents.executeJavaScript(`window.donwells.guiDraftsWrite('smoke-recovery', '[]')`)
    results.push('renderer-crash-draft-recovery')
    results.push('acknowledged-draft-not-replayed')
    logger.info({ results }, 'smoke:ok')
    return true
  } catch (err) {
    logger.error({ err }, 'smoke:fail')
    return false
  } finally {
    if (pty && smokeSessionId && pty.has(smokeSessionId)) {
      try {
        await pty.close(smokeSessionId)
      } catch (error) {
        logger.warn({ error }, 'smoke:cleanup-fail')
        return false
      }
    }
    rmSync(root, { recursive: true, force: true })
  }
}
