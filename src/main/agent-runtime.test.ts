import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { AgentRuntime, TaskLinkedAgentOpenError } from './agent-runtime'
import type { AgentStartResult, AgentTaskIntent, RunningAgent } from '@shared/agent-runtime'
import type { TerminalSession } from '@shared/types'

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

describe('AgentRuntime task intent fencing', () => {
  it('rejects task-linked opens before task lookup or daemon launch', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'agent-runtime-'))
    try {
      let launches = 0
      const runtime = new AgentRuntime({
        startAgent: async () => { launches += 1; return result(workspace) },
        listAgents: async () => [],
        interruptAgent: async () => result(workspace).run,
        stopAgent: async () => result(workspace).run,
        dismissAgent: async () => undefined
      }, {
        registeredWorkspaces: () => [{ path: workspace, host: { kind: 'local' } }]
      })
      await expect(runtime.start(workspace, 'echo', { intent: 'implement task', files: ['src/a.ts'], externalId: 'TASK-1' }))
        .rejects.toMatchObject({ name: 'TaskLinkedAgentOpenError', code: 'TASK_LINKED_AGENT_REQUIRES_COORDINATOR' })
      expect(launches).toBe(0)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('passes generic intent metadata and files through unchanged', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'agent-runtime-'))
    try {
      let received: AgentTaskIntent | undefined
      const runtime = new AgentRuntime({
        startAgent: async (_cwd, _command, _provider, _launch, _timeout, _ttl, task) => {
          received = task
          return result(workspace, task)
        },
        listAgents: async () => [],
        interruptAgent: async () => result(workspace).run,
        stopAgent: async () => result(workspace).run,
        dismissAgent: async () => undefined
      }, {
        registeredWorkspaces: () => [{ path: workspace, host: { kind: 'local' } }]
      })
      const intent = { intent: 'review the change', files: ['src/a.ts', 'src/b.ts'], templateId: 'review' }
      await runtime.start(workspace, 'echo', intent)
      expect(received).toEqual(intent)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
