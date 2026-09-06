import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, statSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitWorktrees } from '../src/main/git'
import { Store } from '../src/main/store'
import { PREVIEW_BYTE_LIMIT } from '../src/main/worktree-files'
import { ProjectHandoffService } from '../src/main/project-handoff'
import type { RunningAgent } from '../src/shared/types'
import { configureAgentMemory } from '../src/main/agents/project-memory-config'

function sh(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd })
}

function makeRepo(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'donwells-write-'))
  const path = join(root, 'repo')
  mkdirSync(path)
  sh(path, 'init', '-b', 'main')
  sh(path, 'config', 'user.email', 't@t')
  sh(path, 'config', 'user.name', 't')
  writeFileSync(join(path, 'f.txt'), 'one\n')
  sh(path, 'add', '.')
  sh(path, 'commit', '-m', 'init')
  return { root, path }
}

const cleanup: string[] = []
afterEach(() => { for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true }) })

async function repoContext(): Promise<{ git: GitWorktrees; path: string }> {
  const { root, path } = makeRepo()
  cleanup.push(root)
  const storeDir = mkdtempSync(join(tmpdir(), 'donwells-write-store-'))
  cleanup.push(storeDir)
  const store = new Store(storeDir)
  const git = new GitWorktrees(store)
  await git.addRepo(path)
  return { git, path }
}

describe('GitWorktrees.writeFile', () => {
  it('configures native memory without replacing user servers and keeps a private backup', async () => {
    const { git, path } = await repoContext()
    mkdirSync(join(path, '.omp'))
    const original = JSON.stringify({ mcpServers: { personal: { command: 'user-server' } }, unknown: ['keep'] })
    writeFileSync(join(path, '.omp/mcp.json'), original)
    const options = { files: git, workspacePath: path, provider: 'omp', userDataDir: path, executable: '/native/Electron', cliPath: '/native/cli/donwells.mjs' }
    const result = await configureAgentMemory(options)
    expect(readFileSync(result.backupPath!, 'utf8')).toBe(original)
    const config = JSON.parse(readFileSync(join(path, '.omp/mcp.json'), 'utf8'))
    expect(config.unknown).toEqual(['keep'])
    expect(config.mcpServers.personal).toEqual({ command: 'user-server' })
    expect(config.mcpServers['donwells-project-memory'].args).toContain(path)
    expect((await configureAgentMemory(options)).changed).toBe(false)
    config.mcpServers['donwells-project-memory'].command = 'user-edited'
    writeFileSync(join(path, '.omp/mcp.json'), JSON.stringify(config))
    await expect(configureAgentMemory(options)).rejects.toThrow(/already has a different/)
    expect(JSON.parse(readFileSync(join(path, '.omp/mcp.json'), 'utf8')).mcpServers['donwells-project-memory'].command).toBe('user-edited')
  })

  it('creates a scoped DSH launch patch and refuses to overwrite an edited patch', async () => {
    const { git, path } = await repoContext()
    const options = { files: git, workspacePath: path, provider: 'deepseek-harness', userDataDir: path, executable: '/native/Electron', cliPath: '/native/cli/donwells.mjs' }
    const result = await configureAgentMemory(options)
    expect(result.launchArgs).toEqual(['--patch', join(path, result.path)])
    const patch = JSON.parse(readFileSync(join(path, result.path), 'utf8'))
    expect(patch[0].insert[0].config.args).toContain(path)
    expect(patch[0].insert[0].name).toBe('@deepseek-ai/dsh-mcp-client')
    expect(patch[0].insert[0].config.env).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      ...Object.fromEntries(['RUN_ID', 'SESSION_ID', 'TOKEN'].map(suffix => {
        const name = `DONWELLS_AGENT_HOOK_${suffix}`
        return [name, { __jsExpr: `process.env.${name} ?? ""` }]
      }))
    })
    expect((await configureAgentMemory(options)).changed).toBe(false)
    writeFileSync(join(path, result.path), '[]')
    await expect(configureAgentMemory(options)).rejects.toThrow(/left unchanged/)
    expect(readFileSync(join(path, result.path), 'utf8')).toBe('[]')
    await expect(configureAgentMemory({ ...options, workspacePath: '/tmp' })).rejects.toThrow()
  })

  it('prepares native Hermes setup with a selected profile and per-session workspace binding', async () => {
    const { git, path } = await repoContext()
    const options = { files: git, workspacePath: path, provider: 'hermes', userDataDir: path, executable: '/native/Electron', cliPath: '/native/cli/donwells.mjs', launchArgs: ['--tui', '--profile', 'work'] }
    const result = await configureAgentMemory(options)
    expect(result.changed).toBe(false)
    expect(result.setupArgs?.slice(0, 5)).toEqual(['--profile', 'work', 'mcp', 'add', 'donwells-project-memory'])
    expect(result.setupArgs).toContain('${workspaceFolder}')
    expect(result.setupArgs?.filter(arg => arg === '--env')).toHaveLength(1)
    expect(result.setupArgs?.slice(result.setupArgs.indexOf('--env') + 1, result.setupArgs.indexOf('--args'))).toHaveLength(4)
    expect(result.setupArgs).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(result.setupArgs).toContain('DONWELLS_AGENT_HOOK_TOKEN=${DONWELLS_AGENT_HOOK_TOKEN}')
    expect(result.setupArgs).toContain('DONWELLS_AGENT_HOOK_SESSION_ID=${DONWELLS_AGENT_HOOK_SESSION_ID}')
    expect(result.setupArgs).toContain('DONWELLS_AGENT_HOOK_RUN_ID=${DONWELLS_AGENT_HOOK_RUN_ID}')
    expect((await configureAgentMemory({ ...options, launchArgs: ['--profile=other'] })).setupArgs?.slice(0, 2)).toEqual(['--profile', 'other'])
    await expect(configureAgentMemory({ ...options, launchArgs: ['--profile'] })).rejects.toThrow(/profile/)
  })

  it('captures staged, unstaged and binary untracked source changes for handoffs', async () => {
    const { git, path } = await repoContext()
    const clean = await git.handoffSource(path)
    expect(clean.sourceRevision).toMatch(/^[a-f0-9]{40}$/)
    expect(clean.changedFiles).toEqual([])
    writeFileSync(join(path, 'f.txt'), 'changed')
    const unstaged = await git.handoffSource(path)
    expect(unstaged.contentFingerprint).not.toBe(clean.contentFingerprint)
    expect(unstaged.changedFiles).toEqual(['f.txt'])
    sh(path, 'add', 'f.txt')
    const staged = await git.handoffSource(path)
    expect(staged.contentFingerprint).not.toBe(unstaged.contentFingerprint)
    writeFileSync(join(path, 'image.bin'), Buffer.from([0, 1, 2]))
    const binary = await git.handoffSource(path)
    writeFileSync(join(path, 'image.bin'), Buffer.from([0, 1, 3]))
    expect((await git.handoffSource(path)).contentFingerprint).not.toBe(binary.contentFingerprint)
    expect((await git.handoffSource(path)).changedFiles).toContain('image.bin')
  })

  it('binds handoffs to real sessions and rejects stale source before accepting', async () => {
    const { git, path } = await repoContext()
    const profile = mkdtempSync(join(tmpdir(), 'donwells-handoff-service-')); cleanup.push(profile)
    let sessions = [
      { sessionId: 'source', workspacePath: path, liveness: 'exited' },
      { sessionId: 'receiver', workspacePath: path, liveness: 'live' },
      { sessionId: 'foreign', workspacePath: '/foreign', liveness: 'live' }
    ] as RunningAgent[]
    const resolveScope = async (checkoutPath: string) => {
      if (![path, '/foreign'].includes(checkoutPath)) throw new Error('Unregistered workspace')
      return { checkoutPath, projectPath: checkoutPath, projectKey: (checkoutPath === path ? 'a' : 'b').repeat(64), indexKey: 'c'.repeat(64) }
    }
    const service = new ProjectHandoffService(profile, resolveScope, git, { list: async () => sessions })
    const draft = { taskId: null, fromSessionId: 'source', toAgent: 'hermes', goal: 'Finish preview', summary: 'Layout ready', openQuestions: [], nextSteps: ['Check focus'], evidenceIds: [] }
    await expect(service.projectHandoffCreate(path, { ...draft, fromSessionId: 'missing' })).rejects.toThrow('available agent')
    await expect(service.projectHandoffCreate(path, { ...draft, projectKey: 'b'.repeat(64) } as typeof draft)).rejects.toThrow('draft fields')
    const handoff = await service.projectHandoffCreate(path, draft)
    expect((await service.projectHandoffGet(path, handoff.id)).stale).toBe(false)
    await expect(service.projectHandoffGet('/foreign', handoff.id)).rejects.toThrow('not found')
    await expect(service.projectHandoffAccept(path, handoff.id, 1, 'foreign', 'claim')).rejects.toThrow('another project')
    writeFileSync(join(path, 'f.txt'), 'new edit')
    expect((await service.projectHandoffGet(path, handoff.id)).stale).toBe(true)
    await expect(service.projectHandoffAccept(path, handoff.id, 1, 'receiver', 'claim')).rejects.toThrow('source changed')
    writeFileSync(join(path, 'f.txt'), 'one\n')
    sessions = sessions.filter(session => session.sessionId !== 'source')
    const accepted = await service.projectHandoffAccept(path, handoff.id, 1, 'receiver', 'claim')
    expect(accepted.acceptedBySessionId).toBe('receiver')
    writeFileSync(join(path, 'f.txt'), 'later edit')
    expect(await service.projectHandoffAccept(path, handoff.id, 1, 'receiver', 'claim')).toEqual(accepted)
    expect(await service.projectHandoffList(path)).toHaveLength(1)
    const credential = { runId: 'run', sessionId: 'receiver', token: 'fixture-secret' }
    const authenticate = async (value: typeof credential) => {
      if (value.token !== credential.token) throw new Error('Invalid credential')
      return sessions.find(run => run.sessionId === value.sessionId)!
    }
    await expect(service.receive(authenticate, { ...credential, token: 'wrong' }, path, handoff.id, 2)).rejects.toThrow('Invalid credential')
    await expect(service.receive(authenticate, credential, path, handoff.id, 2)).rejects.toThrow('source changed')
    writeFileSync(join(path, 'f.txt'), 'one\n')
    await expect(service.receive(authenticate, { ...credential, sessionId: 'foreign' }, path, handoff.id, 2)).rejects.toThrow('another project')
    const delivered = await service.receive(authenticate, credential, path, handoff.id, 2)
    expect(delivered).toMatchObject({ delivery: 'uncertain', revision: 3 })
    expect((await service.projectHandoffGet(path, handoff.id)).handoff).toEqual(delivered)
    await expect(service.receive(authenticate, credential, path, handoff.id, 3)).rejects.toThrow('not ready')
    await expect(service.acknowledge(authenticate, credential, path, handoff.id, 2)).rejects.toThrow('pending delivery')
    const confirmed = await service.acknowledge(authenticate, credential, path, handoff.id, 3)
    expect(confirmed).toMatchObject({ delivery: 'confirmed', revision: 4 })
    expect(await service.acknowledge(authenticate, credential, path, handoff.id, 3)).toEqual(confirmed)
    const exported = await service.projectHandoffExport(path)
    expect(exported.count).toBe(1)
    const document = JSON.parse(readFileSync(exported.path, 'utf8'))
    expect(document.handoffs).toEqual([confirmed])
    expect(document.projectKey).toBe('a'.repeat(64))
    expect(readFileSync(exported.path, 'utf8')).not.toContain('fixture-secret')
    if (process.platform !== 'win32') expect(statSync(exported.path).mode & 0o777).toBe(0o600)
    const foreign = await service.projectHandoffExport('/foreign')
    expect(JSON.parse(readFileSync(foreign.path, 'utf8')).handoffs).toEqual([])
    expect((await service.projectHandoffExport(path)).path).not.toBe(exported.path)

  })

  it('round-trips new and existing files inside the worktree', async () => {
    const { git, path } = await repoContext()
    mkdirSync(join(path, 'src'))
    await git.writeFile(path, 'src/new.ts', 'export const x = 1\n')
    expect(readFileSync(join(path, 'src', 'new.ts'), 'utf8')).toBe('export const x = 1\n')
    await git.writeFile(path, 'f.txt', 'two\n')
    const read = await git.readFile(path, 'f.txt')
    expect(read.content).toBe('two\n')
    expect(read.bytes).toBe(4)
    expect(read.revision).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it('refuses traversal outside the worktree, for read and write alike', async () => {
    const { git, path } = await repoContext()
    await expect(git.writeFile(path, '../escape.txt', 'x')).rejects.toThrow('escapes worktree')
    await expect(git.readFile(path, '../../../etc/passwd')).rejects.toThrow('escapes worktree')
    await expect(git.writeFile('/tmp', '/abs.txt', 'x')).rejects.toThrow()
  })

  it('rejects a path whose parent directory does not exist', async () => {
    const { git, path } = await repoContext()
    await expect(git.writeFile(path, 'nope/deep/file.ts', 'x')).rejects.toThrow('No such directory')
  })
  // regression: unawaited verifyWorktreePath let ops run on unregistered paths
  it('worktree verification gates every operation', async () => {
    const { git } = await repoContext()
    await expect(git.status('/tmp')).rejects.toThrow('Unknown worktree')
    await expect(git.listAllFiles('/tmp')).rejects.toThrow('Unknown worktree')
    await expect(git.commit('/tmp', 'x')).rejects.toThrow('Unknown worktree')
    await expect(git.diff('/tmp', 'a')).rejects.toThrow('Unknown worktree')
  })

  it('rejects a stale guarded write and returns a fresh revision after saving', async () => {
    const { git, path } = await repoContext()
    const initial = await git.readFile(path, 'f.txt')
    expect(initial.revision).toBeDefined()
    writeFileSync(join(path, 'f.txt'), 'external\n')

    await expect(git.writeFile(path, 'f.txt', 'editor\n', initial.revision)).rejects.toThrow(
      'Write conflict: f.txt changed on disk'
    )
    expect(readFileSync(join(path, 'f.txt'), 'utf8')).toBe('external\n')

    const current = await git.readFile(path, 'f.txt')
    const saved = await git.writeFile(path, 'f.txt', 'editor\n', current.revision)
    expect(saved.revision).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(saved.revision).not.toBe(current.revision)
  })

  it('serializes competing guarded writes so only one revision wins', async () => {
    const { git, path } = await repoContext()
    const revision = (await git.readFile(path, 'f.txt')).revision
    const results = await Promise.allSettled([
      git.writeFile(path, 'f.txt', 'first\n', revision),
      git.writeFile(path, 'f.txt', 'second\n', revision)
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected?.status === 'rejected' ? String(rejected.reason) : '').toContain('Write conflict:')
    expect(['first\n', 'second\n']).toContain(readFileSync(join(path, 'f.txt'), 'utf8'))
  })

  it('never issues revisions for partial snapshots or accepts them for guarded writes', async () => {
    const { git, path } = await repoContext()
    writeFileSync(join(path, 'large.txt'), Buffer.alloc(512 * 1024 + 1, 97))
    const preview = await git.readFile(path, 'large.txt')
    expect(preview.truncated).toBe(true)
    expect(preview.content).toHaveLength(512 * 1024)
    expect(preview.revision).toBeUndefined()
    await expect(git.writeFile(path, 'large.txt', 'unsafe', `sha256:${'0'.repeat(64)}`)).rejects.toThrow(
      'partial or truncated'
    )
    await expect(git.writeFile(path, 'large.txt', 'agent whole-file write')).resolves.toMatchObject({
      content: 'agent whole-file write',
      truncated: false
    })
  })

  it('flags NUL and invalid UTF-8 content without exposing a writable text revision', async () => {
    const { git, path } = await repoContext()
    const unsupportedFiles: Array<{ fileName: string; bytes: Buffer }> = [
      { fileName: 'nul.txt', bytes: Buffer.from([0x61, 0x00, 0x62]) },
      { fileName: 'invalid.md', bytes: Buffer.from([0x66, 0x80, 0x6f]) }
    ]

    for (const { fileName, bytes } of unsupportedFiles) {
      writeFileSync(join(path, fileName), bytes)
      const preview = await git.readFile(path, fileName)
      expect(preview).toMatchObject({ content: '', truncated: false, bytes: bytes.length, binary: true })
      expect(preview.revision).toBeUndefined()
      await expect(git.writeFile(path, fileName, 'replacement text')).rejects.toThrow(
        'Refusing to overwrite binary or unsupported text file'
      )
      expect(readFileSync(join(path, fileName))).toEqual(bytes)
    }
  })

  it('scans beyond the preview boundary before replacing an existing file', async () => {
    const { git, path } = await repoContext()
    const bytes = Buffer.alloc(PREVIEW_BYTE_LIMIT + 128, 0x61)
    bytes[PREVIEW_BYTE_LIMIT + 64] = 0
    writeFileSync(join(path, 'late-binary.txt'), bytes)

    const preview = await git.readFile(path, 'late-binary.txt')
    expect(preview.truncated).toBe(true)
    expect(preview.binary).toBeUndefined()
    await expect(git.writeFile(path, 'late-binary.txt', 'replacement text')).rejects.toThrow(
      'Refusing to overwrite binary or unsupported text file'
    )
    expect(readFileSync(join(path, 'late-binary.txt'))).toEqual(bytes)
  })

  it('accepts valid multi-byte UTF-8 split across binary scan chunks', async () => {
    const { git, path } = await repoContext()
    const bytes = Buffer.concat([Buffer.alloc(64 * 1024 - 1, 0x61), Buffer.from('🙂 tail\n')])
    writeFileSync(join(path, 'unicode.txt'), bytes)

    const saved = await git.writeFile(path, 'unicode.txt', 'replacement\n')
    expect(saved.content).toBe('replacement\n')
    expect(saved.binary).toBeUndefined()
  })
})
