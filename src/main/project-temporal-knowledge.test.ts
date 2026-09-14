// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProcessResult, ProcessSpec } from '@shared/child-process/process-spec'
import { runProcess } from '@shared/child-process/run-process'
import type { KnowledgeSelection } from '@shared/project-knowledge'
import type { GraphitiConfiguration } from '@shared/project-temporal-knowledge'
import type { ProjectToolScope } from '@shared/project-tools'
import { ProjectTemporalKnowledge, type GraphitiProcessRunner } from './project-temporal-knowledge'

const MARKER = 'graphiti-disposable-password-marker-9876543210'
const directories: string[] = []

function profile(prefix: string): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  directories.push(directory)
  return directory
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
})

/** A real Python worker stand-in: it echoes the marker if it arrives on stdin. */
function pythonAvailable(): boolean {
  return spawnSync('python3', ['-c', 'import sys'], { encoding: 'utf8' }).status === 0
}

const configuration: GraphitiConfiguration = {
  enabled: true,
  python: '/usr/bin/python3',
  neo4jUri: 'bolt://127.0.0.1:7687',
  neo4jUser: 'neo4j',
  modelUrl: 'http://127.0.0.1:1234/v1',
  model: 'local-model',
  embeddingUrl: 'http://127.0.0.1:1234/v1',
  embeddingModel: 'local-embedding',
  embeddingDimensions: 768
}

function owner(profileDir: string, password: () => string | null, spawnWorker?: GraphitiProcessRunner) {
  const scope: ProjectToolScope = { projectKey: 'project-key', projectPath: profileDir, checkoutPath: profileDir, indexKey: 'index-key' }
  return new ProjectTemporalKnowledge(profileDir, configuration, async () => scope, password, undefined, spawnWorker)
}

const selection: KnowledgeSelection[] = []

/** Records every spec it is asked to run, then reports a valid worker response. */
function recordingRunner(group: string) {
  const specs: ProcessSpec[] = []
  const runner: GraphitiProcessRunner = async spec => {
    specs.push(spec)
    return { code: 0, signal: null, stdout: JSON.stringify({ group, receipts: [] }), stderr: '', durationMs: 1 } satisfies ProcessResult
  }
  return { specs, runner }
}

describe('Graphiti worker password channel', () => {
  it('delivers the password only through the child stdin pipe', async () => {
    const directory = profile('graphiti-stdin-')
    const { specs, runner } = recordingRunner('group')
    const knowledge = owner(directory, () => MARKER, runner)
    // Only the worker path is exercised; a scope failure never reaches it.
    await knowledge.reconcile(directory, selection).catch(() => undefined)
    expect(specs.length).toBeGreaterThan(0)
    const spec = specs[0]!
    // The password is on the anonymous stdin pipe, and nowhere else.
    expect(spec.input).toBe(MARKER)
    expect(spec.stdio ?? ['pipe', 'pipe', 'pipe']).toEqual(['pipe', 'pipe', 'pipe'])
    expect(JSON.stringify(spec.args)).not.toContain(MARKER)
    expect(JSON.stringify(spec.env)).not.toContain(MARKER)
    expect(Object.keys(spec.env ?? {})).not.toContain('DONWELLS_NEO4J_PASSWORD')
    expect(spec.cwd).not.toContain(MARKER)
    // The request document on disk never contains it either.
    for (const entry of readdirSync(directory, { recursive: true }) as string[]) {
      const path = join(directory, entry)
      try { if (readFileSync(path).includes(MARKER)) throw new Error(`plaintext password found in ${entry}`) } catch { /* directories */ }
    }
  })

  it('refuses to spawn without a stored password', async () => {
    const directory = profile('graphiti-missing-')
    const { specs, runner } = recordingRunner('group')
    const knowledge = owner(directory, () => null, runner)
    await expect(knowledge.reconcile(directory, selection)).rejects.toThrowError(/stored Neo4j password/)
    expect(specs).toEqual([])
  })

  it('refuses a password that is not a valid one-line secret', async () => {
    const directory = profile('graphiti-invalid-')
    const { specs, runner } = recordingRunner('group')
    const knowledge = owner(directory, () => 'line\nbreak', runner)
    await expect(knowledge.reconcile(directory, selection)).rejects.toThrowError(/valid one-line secret/)
    expect(specs).toEqual([])
  })

  it.runIf(pythonAvailable())('hands the marker to a real child while argv, environment, and output stay clean', async () => {
    const directory = profile('graphiti-real-')
    const script = 'import sys;p=sys.stdin.buffer.read();print("ok" if p.decode()=="' + MARKER + '" else "mismatch")'
    const result = await runProcess({ program: 'python3', args: ['-I', '-c', script], cwd: directory, env: { PATH: process.env['PATH'], HOME: process.env['HOME'] }, input: MARKER, timeoutMs: 20_000 })
    expect(result.stdout.trim()).toBe('ok')
    expect(result.stdout).not.toContain(MARKER)
    expect(result.stderr).not.toContain(MARKER)
  })

  it.runIf(pythonAvailable())('rejects an empty, oversized, or control-bearing stdin password', async () => {
    const directory = profile('graphiti-real-reject-')
    const worker = join(directory, 'worker.py')
    writeFileSync(worker, 'import sys\nraw=sys.stdin.buffer.read(4097)\nif not raw: raise ValueError("empty")\nif len(raw)>4096: raise ValueError("oversized")\np=raw.decode("utf-8")\nif any(ord(c)<32 or ord(c)==127 for c in p): raise ValueError("control")\nprint("accepted")\n', { mode: 0o600 })
    const run = (input: string) => runProcess({ program: 'python3', args: ['-I', worker], cwd: directory, input, timeoutMs: 20_000 })
      .then(() => 'accepted', () => 'rejected' as const)
    // Each malformed input is refused by the worker's own bounded read, so the
    // channel never accepts an unusable password.
    expect(await run('')).toBe('rejected')
    expect(await run('x'.repeat(5_000))).toBe('rejected')
    expect(await run('bad\u0000secret')).toBe('rejected')
    expect(await run(MARKER)).toBe('accepted')
  })

  it.runIf(pythonAvailable())('leaves no plaintext file behind when the worker fails or is cancelled', async () => {
    const directory = profile('graphiti-failure-')
    const failing = join(directory, 'fail.py')
    writeFileSync(failing, 'import sys\nsys.stdin.buffer.read()\nraise SystemExit(3)\n', { mode: 0o600 })
    await expect(runProcess({ program: 'python3', args: ['-I', failing], cwd: directory, input: MARKER, timeoutMs: 20_000 })).rejects.toThrowError()
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(runProcess({ program: 'python3', args: ['-I', failing], cwd: directory, input: MARKER, signal: controller.signal, timeoutMs: 20_000 })).rejects.toThrowError()
    // Every path closes the pipe and writes no plaintext file of its own.
    expect(readdirSync(directory)).toEqual(['fail.py'])
  })

  it('never stores the password in the temporal ledger', async () => {
    const directory = profile('graphiti-ledger-')
    mkdirSync(join(directory, 'project-knowledge'), { recursive: true, mode: 0o700 })
    const { runner } = recordingRunner('group')
    const knowledge = owner(directory, () => MARKER, runner)
    await knowledge.reconcile(directory, selection).catch(() => undefined)
    for (const entry of readdirSync(join(directory, 'project-knowledge'))) {
      const bytes = readFileSync(join(directory, 'project-knowledge', entry))
      expect(bytes.includes(MARKER)).toBe(false)
    }
  })
})
