import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { searchProjectCode } from '../src/main/project-code-search'
import { AgentRegistry } from '../src/main/agents/registry'
import { GitWorktrees } from '../src/main/git'
import { Store } from '../src/main/store'

it.skipIf(!new AgentRegistry().findExecutable('rg'))('streams scoped literal ripgrep matches with native ignores, limits and cancellation', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'donwells-code-search-')))
  const checkout = join(root, 'checkout'); mkdirSync(checkout)
  const scope = { checkoutPath: checkout, projectPath: checkout, projectKey: 'a'.repeat(64), indexKey: 'b'.repeat(64) }
  const resolveScope = async (path: string) => { if (path !== checkout) throw new Error('Unregistered'); return scope }
  const put = (path: string, text: string) => writeFileSync(join(checkout, path), text)
  try {
    execFileSync('git', ['init', '-q', checkout])
    mkdirSync(join(checkout, 'nested'))
    put('.gitignore', 'ignored.txt\n')
    put('nested/.gitignore', '*.log\n!keep.log\n')
    put('mémoire.txt', 'first\nneedle [.*] --glob secret\n')
    put('ignored.txt', 'needle\n'); put('.hidden.txt', 'needle\n')
    put('nested/drop.log', 'needle\n'); put('nested/keep.log', 'needle\n')
    put('binary.bin', '\0needle\0')
    writeFileSync(join(root, 'outside.txt'), 'needle outside-canary\n')
    symlinkSync(join(root, 'outside.txt'), join(checkout, 'linked.txt'))
    const seen: string[] = []
    const request = { query: 'needle', showHidden: false, includeIgnored: false }
    const result = await searchProjectCode(checkout, request, resolveScope, hit => seen.push(hit.path!))
    expect(result.hits.map(hit => hit.path).sort()).toEqual(['mémoire.txt', 'nested/keep.log'])
    expect(seen.sort()).toEqual(result.hits.map(hit => hit.path).sort())
    expect(result.hits.find(hit => hit.path === 'mémoire.txt')).toMatchObject({ line: 2, excerpt: 'needle [.*] --glob secret' })
    const all = await searchProjectCode(checkout, { ...request, showHidden: true, includeIgnored: true }, resolveScope)
    expect(all.hits.map(hit => hit.path).sort()).toEqual(['.hidden.txt', 'ignored.txt', 'mémoire.txt', 'nested/drop.log', 'nested/keep.log'])
    expect((await searchProjectCode(checkout, { ...request, showHidden: true }, resolveScope)).hits.map(hit => hit.path).sort()).toEqual(['.hidden.txt', 'mémoire.txt', 'nested/keep.log'])
    expect((await searchProjectCode(checkout, { ...request, includeIgnored: true }, resolveScope)).hits.map(hit => hit.path).sort()).toEqual(['ignored.txt', 'mémoire.txt', 'nested/drop.log', 'nested/keep.log'])
    expect((await searchProjectCode(checkout, { ...request, query: '[.*] --glob secret' }, resolveScope)).hits).toHaveLength(1)
    expect((await searchProjectCode(checkout, { ...request, query: 'not-present' }, resolveScope)).hits).toEqual([])
    const limited = await searchProjectCode(checkout, { ...request, maxResults: 1 }, resolveScope)
    expect(limited.hits).toHaveLength(1); expect(limited.truncated).toBe(true)
    const controller = new AbortController()
    await expect(searchProjectCode(checkout, request, resolveScope, () => controller.abort(), controller.signal)).rejects.toMatchObject({ kind: 'cancelled' })
    await expect(searchProjectCode(root, request, resolveScope)).rejects.toThrow('Unregistered')
    await expect(searchProjectCode(checkout, { ...request, query: '\0' }, resolveScope)).rejects.toThrow('query')
    let replaced = false, delivered = 0
    await expect(searchProjectCode(checkout, request, async path => ({ ...await resolveScope(path), indexKey: replaced ? 'c'.repeat(64) : scope.indexKey }), () => { delivered++; replaced = true })).rejects.toThrow('checkout changed')
    expect(delivered).toBe(1)
    const git = new GitWorktrees(new Store(join(root, 'profile')))
    await git.addRepo(checkout)
    expect((await git.searchWorkspaceContent(checkout, request)).hits).toHaveLength(2)
    await expect(git.searchWorkspaceContent(root, request)).rejects.toThrow('Unknown worktree')
    rmSync(join(checkout, 'mémoire.txt'))
    expect((await git.searchWorkspaceContent(checkout, request)).hits.map(hit => hit.path)).toEqual(['nested/keep.log'])
    const originalPath = process.env.PATH
    try {
      process.env.PATH = ''
      await expect(searchProjectCode(checkout, request, resolveScope)).rejects.toThrow('Content search unavailable')
    } finally { process.env.PATH = originalPath }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it.skipIf(!new AgentRegistry().findExecutable('ast-grep'))('searches native syntax without loading project configuration or matching comments', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'donwells-structural-')))
  const checkout = join(root, 'checkout'); mkdirSync(checkout)
  const scope = { checkoutPath: checkout, projectPath: checkout, projectKey: 'a'.repeat(64), indexKey: 'b'.repeat(64) }
  const resolveScope = async (path: string) => { if (path !== checkout) throw new Error('Unregistered'); return scope }
  try {
    execFileSync('git', ['init', '-q', checkout])
    writeFileSync(join(checkout, 'sgconfig.yml'), 'customLanguages: invalid-untrusted-project-config\n')
    writeFileSync(join(checkout, '.gitignore'), 'ignored.ts\n')
    writeFileSync(join(checkout, 'mémoire.ts'), '// console.log(1)\nconst text="console.log(2)";\nconsole.log(3);\n')
    writeFileSync(join(checkout, '.hidden.ts'), 'console.log(4);\n')
    writeFileSync(join(checkout, 'ignored.ts'), 'console.log(5);\n')
    writeFileSync(join(root, 'outside.ts'), 'console.log(6);\n')
    symlinkSync(join(root, 'outside.ts'), join(checkout, 'link.ts'))
    const request = { query: 'console.log($A)', language: 'typescript', showHidden: false, includeIgnored: false }
    const result = await searchProjectCode(checkout, request, resolveScope)
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]).toMatchObject({ path: 'mémoire.ts', line: 3, excerpt: 'console.log(3);' })
    const all = await searchProjectCode(checkout, { ...request, showHidden: true, includeIgnored: true }, resolveScope)
    expect(all.hits.map(hit => hit.path).sort()).toEqual(['.hidden.ts', 'ignored.ts', 'mémoire.ts'])
    expect((await searchProjectCode(checkout, { ...request, showHidden: true }, resolveScope)).hits.map(hit => hit.path).sort()).toEqual(['.hidden.ts', 'mémoire.ts'])
    expect((await searchProjectCode(checkout, { ...request, includeIgnored: true }, resolveScope)).hits.map(hit => hit.path).sort()).toEqual(['ignored.ts', 'mémoire.ts'])
    const controller = new AbortController()
    await expect(searchProjectCode(checkout, request, resolveScope, () => controller.abort(), controller.signal)).rejects.toMatchObject({ kind: 'cancelled' })
    await expect(searchProjectCode(checkout, { ...request, language: '--rewrite' }, resolveScope)).rejects.toThrow('language')
    expect((await searchProjectCode(checkout, { ...request, query: 'absent($A)' }, resolveScope)).hits).toEqual([])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
