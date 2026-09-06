import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir, cpus, release, totalmem } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { GitWorktrees } from '../../src/main/git'
import { Store } from '../../src/main/store'
import { AgentRegistry } from '../../src/main/agents/registry'

// Explicit large-fixture qualification; ordinary unit runs do not create 100k files.
it.skipIf(!process.env.DONWELLS_CODE_SEARCH_EVIDENCE)('measures registered-checkout search and cancellation on 100k deterministic files', async () => {
  const evidence = resolve(process.env.DONWELLS_CODE_SEARCH_EVIDENCE!)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'donwells-search-scale-')))
  const checkout = join(root, 'checkout'); mkdirSync(checkout)
  const binary = new AgentRegistry().findExecutable('rg')!
  expect(binary).toBeTruthy()
  const report: Record<string, unknown> = {
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceDirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    runnerSha256: createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex'),
    adapterSha256: createHash('sha256').update(readFileSync('src/main/project-code-search.ts')).digest('hex'),
    platform: process.platform, arch: process.arch, osRelease: release(), cpu: cpus()[0]?.model, memoryBytes: totalmem(),
    rg: binary, rgSha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
    rgVersion: execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(),
    cacheCondition: 'Fresh fixture, filesystem cache not evicted; first request and repeated warm requests in one service process. Not cold-launch qualification.',
    resourceCondition: 'Other user processes left running; thermal state and model residency not controlled.',
    fixture: { seed: 16161, files: 100000, groups: 100, filesPerGroup: 1000, bytesPerFile: 1024, distribution: 'Per group: 700 visible TypeScript, 100 ignored text, 100 hidden text, 100 binary files. One scopedneedle match at line 2 in each file; binary has NUL prefix. Exactly one rareonlyneedle at group-73/619.ts line 3. Nested ignore files excluded from the 100000 payload count.' }
  }
  try {
    execFileSync('git', ['init', '-q', checkout])
    const digest = createHash('sha256')
    let seed = 16161
    const generation = performance.now()
    for (let group = 0; group < 100; group++) {
      const dir = join(checkout, `group-${group}`); mkdirSync(dir)
      writeFileSync(join(dir, '.gitignore'), '*.ignored.txt\n')
      for (let file = 0; file < 1000; file++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        const name = file < 700 ? `${file}.ts` : file < 800 ? `${file}.ignored.txt` : file < 900 ? `.hidden-${file}.txt` : `${file}.bin`
        const content = `${file >= 900 ? '\0' : '/'} fixture ${seed}\nscopedneedle ${group}:${file}\n${group === 73 && file === 619 ? 'rareonlyneedle\n' : ''}`.padEnd(1024, 'x')
        writeFileSync(join(dir, name), content)
        digest.update(`group-${group}/${name}\0`).update(content)
      }
    }
    report.fixtureSha256 = digest.digest('hex'); report.generationMs = performance.now() - generation
    const git = new GitWorktrees(new Store(join(root, 'profile')))
    await git.addRepo(checkout)
    const first: number[] = [], rare: number[] = [], cancellation: number[] = []
    const request = { query: 'scopedneedle', showHidden: false, includeIgnored: false, maxResults: 1 }
    for (let sample = 0; sample < 30; sample++) {
      const start = performance.now()
      const result = await git.searchWorkspaceContent(checkout, request, hit => {
        first.push(performance.now() - start)
        expect(hit.path).toMatch(/\.ts$/); expect(hit.line).toBe(2)
      })
      expect(result.hits).toHaveLength(1); expect(result.truncated).toBe(true)
      const controller = new AbortController()
      let stoppedAt = 0
      await expect(git.searchWorkspaceContent(checkout, request, () => {
        stoppedAt = performance.now(); controller.abort()
      }, controller.signal)).rejects.toMatchObject({ kind: 'cancelled' })
      expect(stoppedAt).toBeGreaterThan(0)
      cancellation.push(performance.now() - stoppedAt)
      const rareStart = performance.now()
      const rareResult = await git.searchWorkspaceContent(checkout, { ...request, query: 'rareonlyneedle' }, hit => {
        rare.push(performance.now() - rareStart)
        expect(hit.path).toBe('group-73/619.ts'); expect(hit.line).toBe(3)
      })
      expect(rareResult.hits).toHaveLength(1); expect(rareResult.truncated).toBe(false)
    }
    const stats = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return { count: values.length, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1]!, samplesMs: values } }
    const warm = stats(first.slice(1)), sparse = stats(rare.slice(1)), cancelled = stats(cancellation)
    report.firstRequestMs = first[0]; report.warmFirstResult = warm; report.cancellation = cancelled
    report.firstSparseRequestMs = rare[0]; report.warmSparseFirstResult = sparse
    report.gates = { warmFirstResult: warm.p95Ms < 300, sparseFirstResult: sparse.p95Ms < 300, cancellation: cancelled.p95Ms < 250 }
    expect(warm.p95Ms).toBeLessThan(300); expect(sparse.p95Ms).toBeLessThan(300); expect(cancelled.p95Ms).toBeLessThan(250)
  } catch (error) { report.error = String(error); throw error }
  finally {
    rmSync(root, { recursive: true, force: true }); report.fixtureRemoved = true
    writeFileSync(evidence, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  }
}, 180000)
