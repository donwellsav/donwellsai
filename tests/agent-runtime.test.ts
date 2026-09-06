import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentStartResult, RunningAgent } from '../src/shared/agent-runtime'
import { agentForWorkspace, agentNeedsAttention, agentPresentation } from '../src/shared/agent-presentation'
import { AgentRegistry } from '../src/main/agents/registry'
import {
  AgentRuntime,
  type AgentRuntimeDaemonContract,
  validateAgentWorkspacePath
} from '../src/main/agent-runtime'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function workspace(): { root: string; child: string } {
  const root = mkdtempSync(join(tmpdir(), 'donwells-agent-workspace-'))
  const child = join(root, 'child')
  mkdirSync(child)
  directories.push(root)
  return { root, child }
}

function liveRun(workspacePath: string, command = '/bin/echo finite'): RunningAgent {
  const now = new Date().toISOString()
  return {
    id: 'run-1',
    sessionId: 'session-1',
    workspacePath,
    command,
    startedAt: now,
    updatedAt: now,
    liveness: 'live',
    activity: 'working',
    hook: {
      support: 'unavailable',
      events: [],
      reason: 'test command has no provider adapter',
      connected: false
    }
  }
}

describe('agent runtime workspace authority', () => {
  it('accepts registered local descendants and rejects escapes, symlinks, and remote roots', () => {
    const registered = workspace()
    const outside = workspace()
    const escape = join(registered.root, 'escape')
    symlinkSync(outside.root, escape, 'dir')

    expect(validateAgentWorkspacePath(registered.child, [
      { path: registered.root, host: { kind: 'local' } }
    ])).toBe(realpathSync.native(registered.child))
    expect(() => validateAgentWorkspacePath(outside.root, [
      { path: registered.root, host: { kind: 'local' } }
    ])).toThrow(/not inside a registered local workspace/)
    expect(() => validateAgentWorkspacePath(escape, [
      { path: registered.root, host: { kind: 'local' } }
    ])).toThrow(/not inside a registered local workspace/)
    expect(() => validateAgentWorkspacePath('ssh://host/worktree', [
      { path: '/worktree', host: { kind: 'remote', id: 'host' } }
    ])).toThrow(/remote workspace hosts are unsupported/)
  })

  it('forwards a validated finite run and marks cached liveness unverifiable after contact loss', async () => {
    const registered = workspace()
    const run = liveRun(registered.child)
    let contactLost = false
    const starts: string[] = []
    const daemon: AgentRuntimeDaemonContract = {
      startAgent: async (cwd, command): Promise<AgentStartResult> => {
        starts.push(`${cwd}\0${command}`)
        return {
          run,
          session: {
            id: run.sessionId,
            worktreePath: run.workspacePath,
            title: 'child',
            createdAt: run.startedAt,
            exited: false
          }
        }
      },
      listAgents: async () => {
        if (contactLost) throw new Error('daemon contact lost')
        return [run]
      },
      interruptAgent: async () => run,
      stopAgent: async () => run,
      dismissAgent: async () => {}
    }
    const runtime = new AgentRuntime(daemon, {
      registeredWorkspaces: () => [{ path: registered.root, host: { kind: 'local' } }],
      registry: new AgentRegistry({ env: { PATH: '' }, platform: process.platform })
    })

    await expect(runtime.start(registered.child, '/bin/echo finite')).resolves.toMatchObject({
      run: { sessionId: run.sessionId, liveness: 'live' }
    })
    expect(starts).toEqual([`${realpathSync.native(registered.child)}\0/bin/echo finite`])
    await expect(runtime.list()).resolves.toMatchObject([{ liveness: 'live' }])
    contactLost = true
    await expect(runtime.list()).resolves.toMatchObject([{ liveness: 'unverifiable' }])
    runtime.observeDismissed(run.sessionId)
    await expect(runtime.list()).rejects.toThrow('daemon contact lost')
  })

  it('fails before daemon launch when a selected preset executable is unavailable', async () => {
    const registered = workspace()
    let started = false
    const daemon: AgentRuntimeDaemonContract = {
      startAgent: async () => {
        started = true
        throw new Error('must not launch')
      },
      listAgents: async () => [],
      interruptAgent: async () => liveRun(registered.root),
      stopAgent: async () => liveRun(registered.root),
      dismissAgent: async () => {}
    }
    const runtime = new AgentRuntime(daemon, {
      registeredWorkspaces: () => [{ path: registered.root, host: { kind: 'local' } }],
      registry: new AgentRegistry({ env: { PATH: '' }, platform: process.platform })
    })

    await expect(runtime.start(registered.root, 'codex')).rejects.toThrow(/executable is unavailable/)
    expect(started).toBe(false)
  })
})

describe('agent presentation authority', () => {
  it('never presents attention or uncertain states as working', () => {
    const working = liveRun('/workspace')
    expect(agentPresentation(working)).toMatchObject({ status: 'working', tone: 'working', needsAttention: false, inProgress: true })
    expect(agentPresentation({ ...working, hook: { ...working.hook, connected: false } })).toMatchObject({ label: 'Running', description: 'Process is running; task activity is not reported by this agent.' })

    const waiting: RunningAgent = { ...working, activity: 'waiting' }
    const permission: RunningAgent = { ...working, activity: 'permission' }
    expect(agentPresentation(waiting)).toMatchObject({ status: 'waiting', tone: 'attention', needsAttention: true, inProgress: true })
    expect(agentPresentation(permission)).toMatchObject({ status: 'permission', label: 'Permission needed', tone: 'attention', needsAttention: true })

    const unverifiable: RunningAgent = { ...working, liveness: 'unverifiable' }
    expect(agentPresentation(unverifiable)).toMatchObject({ status: 'unverifiable', tone: 'attention', needsAttention: true, inProgress: false })

    const exited: RunningAgent = { ...working, liveness: 'exited' }
    expect(agentPresentation(exited)).toMatchObject({ status: 'exited', tone: 'done', needsAttention: false, inProgress: false })

    const failed: RunningAgent = { ...exited, activity: 'failed', exitCode: 1 }
    expect(agentPresentation(failed)).toMatchObject({ status: 'failed', tone: 'failed', needsAttention: true, inProgress: false })
    expect(agentNeedsAttention(failed)).toBe(true)
  })

  it('prefers a live workspace session over newer retained outcomes', () => {
    const live: RunningAgent = { ...liveRun('/workspace'), updatedAt: '2026-09-05T01:00:00.000Z' }
    const completed: RunningAgent = {
      ...liveRun('/workspace'),
      id: 'completed',
      sessionId: 'completed-session',
      updatedAt: '2026-09-05T02:00:00.000Z',
      liveness: 'exited',
      activity: 'completed'
    }
    expect(agentForWorkspace('/workspace', {
      [live.sessionId]: live,
      [completed.sessionId]: completed
    })).toBe(live)
  })
})
