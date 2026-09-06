import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ProjectTools, resolveProjectToolScope, type ProjectToolDefinition } from '../../src/main/project-tools'
import { projectDocumentReference, readProjectDocument } from '../../src/main/project-documents'
import { GitWorktrees } from '../../src/main/git'
import { Store } from '../../src/main/store'

// Explicit external-engine acceptance only; production dependencies remain unchanged.
it.skipIf(!process.env.DONWELLS_QMD_PACKAGE)('runs isolated native QMD MCP servers through the project tool boundary', async () => {
  const qmd = process.env.DONWELLS_QMD_PACKAGE!
  expect(JSON.parse(readFileSync(join(qmd, 'package.json'), 'utf8')).version).toBe('2.8.3')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'donwells-qmd-services-')))
  const paths = [join(root, 'a'), join(root, 'b')]
  const cli = join(qmd, 'dist/cli/qmd.js')
  const environment = (path: string) => ({ INDEX_PATH: join(path, 'index.sqlite'), QMD_CONFIG_DIR: join(path, 'config'), XDG_CACHE_HOME: join(root, 'cache') })
  const resolveWorkspace = async (path: string) => {
    if (!paths.includes(path)) throw new Error('Unregistered checkout')
    return { path, projectPath: path }
  }
  const text = (value: unknown) => { if (typeof value !== 'string' || !value.trim() || value.length > 1000) throw new Error('Expected bounded text'); return value }
  const definition: ProjectToolDefinition = {
    id: 'qmd', version: '2.8.3', scope: 'checkout',
    launch: scope => ({ program: process.execPath, args: [cli, '--index', 'donwells', 'mcp'], env: environment(scope.checkoutPath) }),
    operations: {
      query: { tool: 'query', readOnly: true, parameters: { searches: value => [{ type: 'lex', query: text(value) }] }, targets: () => ({ collections: ['project'], rerank: false, limit: 5 }) },
      get: { tool: 'get', readOnly: true, parameters: { file: text }, targets: () => ({}) },
      multiGet: { tool: 'multi_get', readOnly: true, parameters: { pattern: text }, targets: () => ({}) }
    }
  }
  const tools = new ProjectTools(resolveWorkspace, [definition], 15000)
  const files = new GitWorktrees(new Store(join(root, 'profile')))
  try {
    for (const [index, path] of paths.entries()) {
      mkdirSync(path); mkdirSync(join(path, 'docs'))
      writeFileSync(join(path, 'docs', index === 0 ? 'first.md' : 'second.md'), `# Fixture\n${index === 0 ? 'copperorchard' : 'violetmeadow'}\n`)
      await files.addRepo(path)
    }
    await Promise.all(paths.map(path => promisify(execFile)(process.execPath, [cli, '--index', 'donwells', 'collection', 'add', join(path, 'docs'), '--name', 'project'], { env: { ...process.env, ...environment(path) }, timeout: 15000, maxBuffer: 1024 * 1024 })))
    // An untrusted checkout's local QMD configuration must not replace the app-owned index.
    mkdirSync(join(paths[0]!, '.qmd'))
    const localConfig = join(paths[0]!, '.qmd/index.yaml')
    const localBytes = JSON.stringify({ collections: { project: { path: join(paths[1]!, 'docs'), pattern: '**/*.md' } } })
    writeFileSync(localConfig, localBytes)
    await Promise.all(paths.map(path => tools.start(path, 'qmd')))
    const response = await tools.call(paths[0]!, 'qmd', 'query', { searches: 'copperorchard' }) as { structuredContent: { results: Array<{ file: string }> } }
    const first = JSON.stringify(response)
    expect(first).toContain('first.md')
    const resolveScope = (path: string) => resolveProjectToolScope(path, resolveWorkspace)
    const reference = projectDocumentReference(await resolveScope(paths[0]!), response.structuredContent.results[0]!.file, 'docs')
    const indexedSource = await readProjectDocument(paths[0]!, reference, resolveScope, files, 'docs')
    expect(indexedSource.content).toContain('copperorchard')
    writeFileSync(join(paths[0]!, 'docs/first.md'), '# Current source\nchanged-after-index\n')
    const currentSource = await readProjectDocument(paths[0]!, reference, resolveScope, files, 'docs')
    expect(currentSource.content).toContain('changed-after-index')
    expect(currentSource.revision).not.toBe(indexedSource.revision)
    expect(JSON.stringify(await tools.call(paths[1]!, 'qmd', 'query', { searches: 'copperorchard' }))).not.toContain('first.md')
    expect(JSON.stringify(await tools.call(paths[1]!, 'qmd', 'query', { searches: 'violetmeadow' }))).toContain('second.md')
    expect(readFileSync(localConfig, 'utf8')).toBe(localBytes)
    const configB = join(paths[1]!, 'config/donwells.yml')
    const beforeB = readFileSync(configB, 'utf8')
    const added = join(paths[0]!, 'references'); mkdirSync(added)
    writeFileSync(join(added, 'reference.md'), '# Additional reference\nAdditional document.\n')
    await promisify(execFile)(process.execPath, [cli, '--index', 'donwells', 'collection', 'add', added, '--name', 'added-to-a'], { cwd: paths[0], env: { ...process.env, ...environment(paths[0]!) }, timeout: 15000, maxBuffer: 1024 * 1024 })
    expect(readFileSync(configB, 'utf8')).toBe(beforeB)
    await expect(tools.call(paths[0]!, 'qmd', 'query', { searches: 'violetmeadow', collections: ['other'] })).rejects.toThrow('not permitted')
    await expect(tools.call(paths[0]!, 'qmd', 'get', { file: 'qmd://project/second.md' })).resolves.toMatchObject({ isError: true })
    const batch = JSON.stringify(await tools.call(paths[0]!, 'qmd', 'multiGet', { pattern: 'qmd://project/*.md' }))
    expect(batch).toContain('copperorchard')
    expect(batch).not.toContain('violetmeadow')
    await tools.stop(paths[0]!, 'qmd')
    expect(JSON.stringify(await tools.call(paths[1]!, 'qmd', 'query', { searches: 'violetmeadow' }))).toContain('second.md')
  } finally { await tools.close(); rmSync(root, { recursive: true, force: true }) }
}, 60000)
