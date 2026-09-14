import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskExecutionSpecificationInput } from '@shared/task-authority'
import { DaemonTaskEvidencePort } from './task-evidence-port'

const directories: string[] = []
function tempDirectory(): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'task-evidence-')))
  directories.push(directory)
  return directory
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true })
})

const SPEC = (requiredArtifacts: ReadonlyArray<{ path: string; relationship: 'attached-reference' | 'observed-during-run' }>): TaskExecutionSpecificationInput => ({
  command: { program: 'node', args: ['run.js'] },
  target: { kind: 'local', root: '/repo', label: 'repo' },
  verification: { requiredArtifacts }
})

describe('daemon task evidence port', () => {
  it('resolves the canonical workspace and records pre-run artifact state', () => {
    const workspace = tempDirectory()
    writeFileSync(join(workspace, 'report.txt'), 'hello evidence')
    const port = new DaemonTaskEvidencePort()
    const observation = port.observePre(
      SPEC([{ path: 'report.txt', relationship: 'observed-during-run' }, { path: 'missing.txt', relationship: 'attached-reference' }]),
      workspace
    )
    expect(observation.workspaceRoot).toBe(realpathSync.native(workspace))
    expect(observation.canonicalResourceKey).toBe(workspace.toLowerCase())
    const report = observation.artifacts[0]!
    expect(report.existedBefore).toBe(true)
    expect(report.sha256Before).toBe(createHash('sha256').update('hello evidence').digest('hex'))
    expect(report.bytesBefore).toBe('hello evidence'.length)
    expect(observation.artifacts[1]!.existedBefore).toBe(false)
  })

  it('rejects required artifact paths that escape the workspace', () => {
    const workspace = tempDirectory()
    const port = new DaemonTaskEvidencePort()
    expect(() => port.observePre(SPEC([{ path: '../outside.txt', relationship: 'observed-during-run' }]), workspace)).toThrow(/escapes the reserved workspace/)
  })

  it('rejects non-local execution targets', () => {
    const workspace = tempDirectory()
    const port = new DaemonTaskEvidencePort()
    const spec: TaskExecutionSpecificationInput = {
      ...SPEC([]),
      target: { kind: 'remote', connectionId: 'conn-1', root: '/repo', label: 'repo' }
    }
    expect(() => port.observePre(spec, workspace)).toThrow(/local execution targets only/)
  })

  it('captures post-run digests with lineage to pre-run state', () => {
    const workspace = tempDirectory()
    writeFileSync(join(workspace, 'unchanged.txt'), 'same')
    writeFileSync(join(workspace, 'changed.txt'), 'before')
    const port = new DaemonTaskEvidencePort()
    const observation = port.observePre(
      SPEC([{ path: 'unchanged.txt', relationship: 'observed-during-run' }, { path: 'changed.txt', relationship: 'observed-during-run' }, { path: 'created.txt', relationship: 'attached-reference' }]),
      workspace
    )
    writeFileSync(join(workspace, 'changed.txt'), 'after')
    writeFileSync(join(workspace, 'created.txt'), 'new file')
    const capture = port.capturePost(observation, 'bounded output', false)
    const byName = (name: string) => capture.artifacts.find(artifact => artifact.path === name)!
    const unchanged = byName('unchanged.txt')
    expect(unchanged.sha256).toBe(createHash('sha256').update('same').digest('hex'))
    expect(unchanged.sourceFingerprint).toBe(unchanged.sha256)
    const changed = byName('changed.txt')
    expect(changed.sha256).toBe(createHash('sha256').update('after').digest('hex'))
    const created = byName('created.txt')
    expect(created.sourceFingerprint).toBeNull()
    expect(capture.outputDigest).toBe(createHash('sha256').update('bounded output').digest('hex'))
    expect(capture.outputBytes).toBe('bounded output'.length)
    expect(capture.outputTruncated).toBe(false)
  })

  it('omits artifacts that disappear or stay unhashable after the run', () => {
    const workspace = tempDirectory()
    writeFileSync(join(workspace, 'gone.txt'), 'temporary')
    const port = new DaemonTaskEvidencePort()
    const observation = port.observePre(SPEC([{ path: 'gone.txt', relationship: 'observed-during-run' }]), workspace)
    rmSync(join(workspace, 'gone.txt'))
    const capture = port.capturePost(observation, '', false)
    expect(capture.artifacts).toEqual([])
  })

  it('asserts the reserved canonical workspace before post-run reads', () => {
    const workspace = tempDirectory()
    const port = new DaemonTaskEvidencePort()
    const observation = port.observePre(SPEC([]), workspace)
    expect(() => port.assertReservedWorkspace(observation, observation.canonicalResourceKey)).not.toThrow()
    expect(() => port.assertReservedWorkspace(observation, 'someone-else')).toThrow(/reserved canonical resource key/)
  })
})
