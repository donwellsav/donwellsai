import { describe, expect, it } from 'vitest'
import {
  AutonomousAgent,
  parseGoalMarker,
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
