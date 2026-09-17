import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { AgentRuntime, TaskLinkedAgentOpenError } from './agent-runtime'
import type { AgentExecutable, AgentStartResult, AgentTaskIntent, RunningAgent } from '@shared/agent-runtime'
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

/** A real executable on disk, so `openNative` exercises genuine resolution. */
function tool(directory: string, name: string): string {
  const path = join(directory, name)
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, 0o755)
  return path
}

function harness(workspace: string, directory: string, onOpen: (launch: AgentExecutable, task?: AgentTaskIntent) => void) {
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
