import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { AgentRuntime } from './agent-runtime'
import type { AgentExecutable, AgentStartResult, AgentTaskIntent, RunningAgent } from '@shared/agent-runtime'
import type { TerminalSession } from '@shared/types'
import { AttentionInboxService } from './attention-inbox-service'
import { AttentionInboxStore } from './attention-inbox-store'

function result(workspacePath: string, task?: AgentTaskIntent): AgentStartResult {
  const now = new Date().toISOString()
  const run: RunningAgent = {
    ...(task === undefined ? {} : { task }),
    id: 'run-1',
    sessionId: 'session-1',
    workspacePath,
    command: 'echo',
    startedAt: now,
    updatedAt: now,
    liveness: 'live',
    activity: 'starting',
    hook: { support: 'unavailable', events: [], reason: 'test', connected: false }
  }
  const session: TerminalSession = { id: 'session-1', worktreePath: workspacePath, title: 'echo', createdAt: now, exited: false }
  return { run, session }
}

/** A real executable on disk, so `openNative` exercises genuine resolution. */
function tool(directory: string, name: string): string {
  const path = join(directory, name)
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, 0o755)
  return path
}

function harness(workspace: string, _directory: string, onOpen: (launch: AgentExecutable, task?: AgentTaskIntent) => void) {
  return new AgentRuntime({
    openNativeTerminal: async (_cwd, launch, _cols, _rows, task) => {
      onOpen(launch, task)
      return result(workspace, task)
    },
    listAgents: async () => [],
    interruptAgent: async () => result(workspace).run,
    stopAgent: async () => result(workspace).run,
    dismissAgent: async () => undefined
  }, {
    registeredWorkspaces: () => [{ path: workspace, host: { kind: 'local' } }]
  })
}

describe('AgentRuntime native terminal opens', () => {
  it('rejects task-linked opens before task lookup or daemon launch', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'agent-runtime-'))
    try {
      const executable = tool(workspace, 'tool')
      let opens = 0
      const runtime = harness(workspace, workspace, () => { opens += 1 })
      await expect(runtime.openNative(workspace, { executable, args: [] }, { intent: 'implement task', files: ['src/a.ts'], externalId: 'TASK-1' }))
        .rejects.toMatchObject({ name: 'TaskLinkedAgentOpenError', code: 'TASK_LINKED_AGENT_REQUIRES_COORDINATOR' })
      expect(opens).toBe(0)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('passes the exact explicit argv and intent metadata through unchanged', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'agent-runtime-'))
    try {
      const executable = tool(workspace, 'tool')
      let sent: AgentExecutable | undefined
      let received: AgentTaskIntent | undefined
      const runtime = harness(workspace, workspace, (launch, task) => { sent = launch; received = task })
      const intent = { intent: 'review the change', files: ['src/a.ts', 'src/b.ts'], templateId: 'review' }
      await runtime.openNative(workspace, { executable, args: ['--resume', 'session-file'] }, intent)
      // The resume argument is exactly what the caller named — never rewritten,
      // and never replaced by a provider instance's stored command spec.
      expect(sent).toMatchObject({ executable, args: ['--resume', 'session-file'] })
      expect(received).toEqual(intent)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('refuses an executable that does not resolve, opening no terminal', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'agent-runtime-'))
    try {
      let opens = 0
      const runtime = harness(workspace, workspace, () => { opens += 1 })
      await expect(runtime.openNative(workspace, { executable: join(workspace, 'absent-tool'), args: [] }))
        .rejects.toThrow('Agent executable is unavailable')
      expect(opens).toBe(0)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

describe('run provider provenance in durable attention', () => {
  it('retains the admitted known driver instead of deriving identity from the command', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'agent-attention-'))
    try {
      const run = result(workspace).run
      run.command = '/opt/tools/native-agent'
      run.activity = 'waiting'
      run.provider = { driverId: 'claude', providerInstanceId: 'instance-work', providerInstanceRevision: 7, accountId: 'account-work', providerAccountRevision: 3 }
      const service = new AttentionInboxService(new AttentionInboxStore(workspace))
      service.observe(run)
      const event = new AttentionInboxStore(workspace).snapshot().events[0]
      expect(event).toMatchObject({ runId: run.id, providerId: 'claude', command: run.command, kind: 'waiting' })
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('preserves command metadata without inventing enum identity for native or custom-driver runs', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'agent-attention-'))
    try {
      const native = { ...result(workspace).run, command: 'claude', activity: 'waiting' as const }
      const custom = { ...native, id: 'run-custom', sessionId: 'session-custom', command: '/opt/tools/custom-agent', provider: { driverId: 'custom-command', providerInstanceId: 'instance-custom', providerInstanceRevision: 1, accountId: null, providerAccountRevision: null } }
      const service = new AttentionInboxService(new AttentionInboxStore(workspace))
      service.observe(native)
      service.observe(custom)
      const events = new AttentionInboxStore(workspace).snapshot().events
      expect(events.map(({ runId, command, providerId }) => ({ runId, command, providerId }))).toEqual([
        { runId: native.id, command: 'claude', providerId: undefined },
        { runId: custom.id, command: '/opt/tools/custom-agent', providerId: undefined }
      ])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
