import { describe, expect, it } from 'vitest'
import {
  AutonomousAgent,
  parseActionLines,
  parseGoalMarker,
  type AgentAction,
  type AutonomousAgentConfig,
  type AutonomousJobOutcome,
  type AutonomousJobRequest
} from '../src/main/autonomous/autonomous-agent'

const JOB_CONTEXT = { workspacePath: '/tmp/workspace', command: 'my-agent' }
const handler = async (): Promise<string> => 'ok'

function makeRun(
  outcome: (callNumber: number) => AutonomousJobOutcome | Promise<AutonomousJobOutcome>,
  config: Partial<AutonomousAgentConfig> = {}
): { agent: AutonomousAgent; calls: AutonomousJobRequest[]; job: typeof JOB_CONTEXT & { runner: (r: AutonomousJobRequest) => Promise<AutonomousJobOutcome> } } {
  const calls: AutonomousJobRequest[] = []
  const agent = new AutonomousAgent({
    maxIterations: 5,
    pauseOnError: true,
    iterationIntervalMs: 0,
    ...config
  })
  const job = {
    ...JOB_CONTEXT,
    runner: async (request: AutonomousJobRequest): Promise<AutonomousJobOutcome> => {
      calls.push(request)
      return outcome(calls.length)
    }
  }
  return { agent, calls, job }
}

describe('autonomous agent real job loop (R2.1)', () => {
  it('stops honestly without a job context — no simulated iterations', async () => {
    const agent = new AutonomousAgent({ iterationIntervalMs: 0 })
    const result = await agent.run('ship it', handler)
    expect(result.stoppedReason).toBe('error')
    expect(result.finalResult).toBe('Autonomous job runner is not configured')
    expect(result.iterations).toHaveLength(1)
    expect(result.iterations[0].reasoning).toBe('')
    expect(result.iterations[0].tokensUsed).toBeNull()
  })

  it('completes only via the GOAL marker and returns the SUMMARY', async () => {
    const { agent, job } = makeRun(() => ({
      output: 'some work happened\nGOAL: achieved\nSUMMARY: done one',
      exitCode: 0,
      tokensUsed: null
    }))
    const result = await agent.run('finish the task', handler, job)
    expect(result.stoppedReason).toBe('completed')
    expect(result.success).toBe(true)
    expect(result.finalResult).toBe('done one')
    expect(result.totalTokens).toBeNull()
  })

  it('feeds prior results into the next prompt and stops at max iterations', async () => {
    const { agent, calls, job } = makeRun(
      n => ({
        output: `turn ${n}\nGOAL: not_achieved\nSUMMARY: done one`,
        exitCode: 0,
        tokensUsed: null
      }),
      { maxIterations: 2 }
    )
    const result = await agent.run('big goal', handler, job)
    expect(result.stoppedReason).toBe('max_iterations')
    expect(calls).toHaveLength(2)
    expect(calls[0].prompt).toContain('big goal')
    expect(calls[1].prompt).toContain('big goal')
    expect(calls[1].prompt).toContain('done one')
  })

  it('treats a non-zero exit as an error stop', async () => {
    const { agent, job } = makeRun(() => ({
      output: 'boom\nGOAL: not_achieved\nSUMMARY: failed',
      exitCode: 1,
      tokensUsed: null
    }))
    const result = await agent.run('goal', handler, job)
    expect(result.stoppedReason).toBe('error')
    expect(result.finalResult).toBe('Agent job exited with code 1')
  })

  it('sums real token usage when reported', async () => {
    const { agent, job } = makeRun(
      () => ({
        output: 'GOAL: not_achieved\nSUMMARY: step',
        exitCode: 0,
        tokensUsed: 120
      }),
      { maxIterations: 2 }
    )
    const result = await agent.run('goal', handler, job)
    expect(result.totalTokens).toBe(240)
  })

  it('enforces the token budget only against measured usage', async () => {
    const { agent, calls, job } = makeRun(
      () => ({
        output: 'GOAL: not_achieved\nSUMMARY: step',
        exitCode: 0,
        tokensUsed: 120
      }),
      { maxIterations: 10, maxTokens: 150 }
    )
    const result = await agent.run('goal', handler, job)
    expect(result.stoppedReason).toBe('max_tokens')
    expect(calls).toHaveLength(2)
  })

  it('never enforces a token budget when usage is unavailable', async () => {
    const { agent, calls, job } = makeRun(
      () => ({
        output: 'GOAL: not_achieved\nSUMMARY: step',
        exitCode: 0,
        tokensUsed: null
      }),
      { maxIterations: 3, maxTokens: 1 }
    )
    const result = await agent.run('goal', handler, job)
    expect(result.stoppedReason).toBe('max_iterations')
    expect(calls).toHaveLength(3)
  })

  it('stops on user request mid-run', async () => {
    const agent = new AutonomousAgent({ maxIterations: 50, iterationIntervalMs: 0 })
    const job = {
      ...JOB_CONTEXT,
      runner: async () => {
        agent.stop()
        return { output: 'GOAL: not_achieved\nSUMMARY: partial', exitCode: 0, tokensUsed: null }
      }
    }
    const result = await agent.run('goal', handler, job)
    expect(result.stoppedReason).toBe('user_stopped')
  })

  it('surfaces runner exceptions as iteration errors', async () => {
    const agent = new AutonomousAgent({ iterationIntervalMs: 0 })
    const job = {
      ...JOB_CONTEXT,
      runner: async (): Promise<AutonomousJobOutcome> => {
        throw new Error('daemon offline')
      }
    }
    const result = await agent.run('goal', handler, job)
    expect(result.stoppedReason).toBe('error')
    expect(result.finalResult).toBe('daemon offline')
  })
})

describe('parseGoalMarker', () => {
  it('reads achieved + summary', () => {
    expect(parseGoalMarker('GOAL: achieved\nSUMMARY: done')).toEqual({
      achieved: true,
      summary: 'done'
    })
  })

  it('reads not_achieved without a summary', () => {
    expect(parseGoalMarker('GOAL: not_achieved')).toEqual({ achieved: false, summary: undefined })
  })

  it('is case-insensitive on line anchors', () => {
    expect(parseGoalMarker('Goal: ACHIEVED\nSummary: Mixed')).toEqual({
      achieved: true,
      summary: 'Mixed'
    })
  })

  it('never reports completion for plain text', () => {
    expect(parseGoalMarker('we might have achieved the goal somewhere')).toEqual({
      achieved: false,
      summary: undefined
    })
  })

  it('does not treat not_achieved as achieved', () => {
    expect(parseGoalMarker('GOAL: not_achieved').achieved).toBe(false)
  })
})

describe('action routing (R2.3)', () => {
  const routingOutcome = (n: number): AutonomousJobOutcome => ({
    output:
      n === 1
        ? 'ACTION: shell echo hi\nGOAL: not_achieved\nSUMMARY: s'
        : 'GOAL: achieved\nSUMMARY: fin',
    exitCode: 0,
    tokensUsed: null
  })

  it('parses ACTION lines from real output, capped at ten', () => {
    const parsed = parseActionLines('ACTION: shell ls -la')
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({
      type: 'shell',
      description: 'ls -la',
      params: { command: 'ls -la' },
      approved: false
    })
    expect(parseActionLines('plain text')).toEqual([])
    const many = Array.from({ length: 11 }, (_, i) => `ACTION: shell cmd-${i}`).join('\n')
    expect(parseActionLines(many)).toHaveLength(10)
  })

  it('routes non-gated actions through the handler and feeds results back', async () => {
    const seen: AgentAction[] = []
    const record = async (action: AgentAction): Promise<string> => {
      seen.push({ ...action })
      return 'ok'
    }
    const { agent, calls, job } = makeRun(routingOutcome, { requireApproval: false })
    const result = await agent.run('ship it', record, job)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ type: 'shell', approved: true })
    expect(seen[0].params.command).toBe('echo hi')
    expect(result.iterations[0].actions[0].result).toBe('ok')
    expect(calls[1].prompt).toContain('ACTION shell')
    expect(calls[1].prompt).toContain('done: ok')
  })

  it('presents gated actions unapproved and honours an approval decision', async () => {
    let sawApproved: boolean | undefined
    const approve = async (action: AgentAction): Promise<string> => {
      sawApproved = action.approved
      action.approved = true
      return 'approved run'
    }
    const { agent, calls, job } = makeRun(routingOutcome, {
      requireApproval: true,
      requireApprovalFor: ['shell']
    })
    const result = await agent.run('ship it', approve, job)
    expect(sawApproved).toBe(false)
    expect(result.iterations[0].actions[0].approved).toBe(true)
    expect(calls[1].prompt).toContain('done: approved run')
  })

  it('keeps denied actions unapproved and says so in the next prompt', async () => {
    const deny = async (action: AgentAction): Promise<string> => {
      action.approved = false
      return 'the user did not approve'
    }
    const { agent, calls, job } = makeRun(routingOutcome, {
      requireApproval: true,
      requireApprovalFor: ['shell']
    })
    const result = await agent.run('ship it', deny, job)
    expect(result.iterations[0].actions[0].approved).toBe(false)
    expect(calls[1].prompt).toContain('not approved')
  })

  it('records handler failures on the action without failing the iteration', async () => {
    const thrower = async (): Promise<string> => {
      throw new Error('boom')
    }
    const { agent, calls, job } = makeRun(routingOutcome, { requireApproval: false })
    const result = await agent.run('ship it', thrower, job)
    expect(result.iterations[0].actions[0].error).toBe('boom')
    expect(result.iterations[0].actions[0].approved).toBe(false)
    expect(result.iterations[0].error).toBeUndefined()
    expect(result.stoppedReason).not.toBe('error')
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })
})
