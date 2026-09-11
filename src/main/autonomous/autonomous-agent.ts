import { logger } from '../../shared/logger'
import { EventEmitter } from 'node:events'

export interface AutonomousAgentConfig {
  /** Maximum number of iterations. */
  maxIterations: number
  /** Maximum total duration in ms. */
  maxDurationMs: number
  /** Maximum tokens to consume (only enforced when usage is reported). */
  maxTokens: number
  /** Whether to require user approval before executing actions. */
  requireApproval: boolean
  /** Safety limits - actions that require explicit approval. */
  requireApprovalFor: string[]
  /** Whether to pause on errors. */
  pauseOnError: boolean
  /** Interval between iterations in ms. */
  iterationIntervalMs: number
}

/** One autonomous iteration handed to the injected job runner. */
export interface AutonomousJobRequest {
  prompt: string
  workspacePath: string
  command: string
  iteration: number
}

/** What a job runner reports back for one iteration. */
export interface AutonomousJobOutcome {
  output: string
  exitCode?: number
  /** Null when the provider does not surface usage — 'unavailable', never a guess. */
  tokensUsed: number | null
}

export type AutonomousJobRunner = (request: AutonomousJobRequest) => Promise<AutonomousJobOutcome>

/** Per-run job context: where to run, what to launch, and how to launch it. */
export interface AutonomousRunJob {
  workspacePath: string
  command: string
  runner: AutonomousJobRunner
}

export interface AgentIteration {
  index: number
  startTime: number
  endTime?: number
  goal: string
  reasoning: string
  actions: AgentAction[]
  result?: string
  error?: string
  goalAchieved?: boolean
  tokensUsed: number | null
}

export interface AgentAction {
  type: string
  description: string
  params: Record<string, unknown>
  approved: boolean
  result?: string
  error?: string
}

export interface AutonomousAgentResult {
  success: boolean
  iterations: AgentIteration[]
  /** Null while no iteration reported usage — displayed as unavailable. */
  totalTokens: number | null
  totalDurationMs: number
  finalResult: string
  stoppedReason?: 'completed' | 'max_iterations' | 'max_duration' | 'max_tokens' | 'error' | 'user_stopped'
}

const DEFAULT_CONFIG: AutonomousAgentConfig = {
  maxIterations: 50,
  maxDurationMs: 30 * 60 * 1000, // 30 minutes
  maxTokens: 500000,
  requireApproval: false,
  requireApprovalFor: ['shell', 'write', 'delete', 'network'],
  pauseOnError: true,
  iterationIntervalMs: 1000,
}

const MAX_REASONING_CHARS = 2000
const HISTORY_WINDOW = 5

export const AUTONOMOUS_MARKER_CONTRACT =
  'End your reply with exactly two lines:\nGOAL: achieved|not_achieved\nSUMMARY: <one line describing what you did>\n' +
  'If you need the host to run something for you, emit lines BEFORE the final markers:\nACTION: shell <single-line command>'

const MAX_ACTION_LINES_PER_ITERATION = 10

/**
 * Parses host-action requests from agent output. Only `ACTION: <type> <payload>`
 * lines count — anything else in the transcript is prose, not a request.
 */
export function parseActionLines(output: string): AgentAction[] {
  const actions: AgentAction[] = []
  const pattern = /^ACTION:\s*([A-Za-z_][A-Za-z0-9_-]*)\s+(.+)$/gim
  for (const match of output.matchAll(pattern)) {
    if (actions.length >= MAX_ACTION_LINES_PER_ITERATION) break
    const type = match[1].toLowerCase()
    const payload = match[2].trim()
    actions.push({
      type,
      description: payload.slice(0, 200),
      params: type === 'shell' ? { command: payload } : { payload },
      approved: false,
    })
  }
  return actions
}

/**
 * Parses the required completion markers from agent output.
 * Completion is only ever decided by this contract — never substring guessing.
 */
export function parseGoalMarker(output: string): { achieved: boolean; summary?: string } {
  const marker = /^GOAL:\s*(achieved|not_achieved)\b/mi.exec(output)
  const summary = /^SUMMARY:\s*(.+)$/mi.exec(output)
  return {
    achieved: marker?.[1]?.toLowerCase() === 'achieved',
    summary: summary?.[1]?.trim(),
  }
}

function buildIterationPrompt(goal: string, iterations: AgentIteration[]): string {
  const prior = iterations.slice(-HISTORY_WINDOW).filter(i => i.result !== undefined || i.error !== undefined)
  if (prior.length === 0) return `${goal}\n\n${AUTONOMOUS_MARKER_CONTRACT}`
  const history = prior
    .map(i => {
      const lines = [`Iteration ${i.index + 1}: ${i.error !== undefined ? `ERROR ${i.error}` : i.result}`]
      for (const action of i.actions) {
        const outcome =
          action.error !== undefined
            ? `error ${action.error}`
            : action.approved
              ? `done: ${action.result ?? ''}`
              : `not approved: ${action.result ?? 'the user did not approve'}`
        lines.push(`  ACTION ${action.type} "${action.description.slice(0, 80)}": ${outcome}`)
      }
      return lines.join('\n')
    })
    .join('\n')
  return `${goal}\n\nPrevious results:\n${history}\n\n${AUTONOMOUS_MARKER_CONTRACT}`
}

/**
 * Autonomous agent loop.
 *
 * Runs a configured agent command as a bounded daemon job per iteration
 * until the agent reports `GOAL: achieved` or a limit is reached.
 * Supports safety checks, iteration limits, and token budgets.
 */
export class AutonomousAgent extends EventEmitter {
  private config: AutonomousAgentConfig
  private iterations: AgentIteration[] = []
  private tokenSum: number | null = null
  private startTime = 0
  private stopped = false

  constructor(config: Partial<AutonomousAgentConfig> = {}) {
    super()
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Runs the autonomous agent loop. Without a job context the run stops
   * immediately with an explicit error — no simulated iterations.
   */
  async run(
    goal: string,
    actionHandler: (action: AgentAction) => Promise<string>,
    job?: AutonomousRunJob
  ): Promise<AutonomousAgentResult> {
    this.startTime = Date.now()
    this.iterations = []
    this.tokenSum = null
    this.stopped = false

    logger.info({ goal, maxIterations: this.config.maxIterations }, 'autonomous-agent: started')

    try {
      while (!this.stopped) {
        // Check limits
        if (this.iterations.length >= this.config.maxIterations) {
          return this.buildResult('max_iterations', 'Maximum iterations reached')
        }

        if (Date.now() - this.startTime >= this.config.maxDurationMs) {
          return this.buildResult('max_duration', 'Maximum duration reached')
        }

        if (this.tokenSum !== null && this.tokenSum >= this.config.maxTokens) {
          return this.buildResult('max_tokens', 'Maximum tokens reached')
        }

        const iteration = await this.runIteration(goal, job, actionHandler)
        this.iterations.push(iteration)

        this.emit('iteration', iteration)

        if (iteration.error && this.config.pauseOnError) {
          return this.buildResult('error', iteration.error)
        }

        if (iteration.goalAchieved) {
          return this.buildResult('completed', iteration.result ?? 'Goal achieved')
        }

        // Brief pause between iterations
        await new Promise(resolve => setTimeout(resolve, this.config.iterationIntervalMs))
      }

      return this.buildResult('user_stopped', 'Agent stopped by user')
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error({ err: error, iterations: this.iterations.length }, 'autonomous-agent: error')
      return this.buildResult('error', errorMessage)
    }
  }

  /**
   * Stops the agent loop.
   */
  stop(): void {
    this.stopped = true
    this.emit('stopped')
  }

  /**
   * Gets current agent state.
   */
  getState(): {
    iterations: number
    totalTokens: number | null
    durationMs: number
    stopped: boolean
  } {
    return {
      iterations: this.iterations.length,
      totalTokens: this.tokenSum,
      durationMs: Date.now() - this.startTime,
      stopped: this.stopped,
    }
  }

  private async runIteration(
    goal: string,
    job: AutonomousRunJob | undefined,
    actionHandler: (action: AgentAction) => Promise<string>
  ): Promise<AgentIteration> {
    const iteration: AgentIteration = {
      index: this.iterations.length,
      startTime: Date.now(),
      goal,
      reasoning: '',
      actions: [],
      tokensUsed: null,
    }

    if (!job) {
      iteration.error = 'Autonomous job runner is not configured'
      iteration.endTime = Date.now()
      return iteration
    }

    try {
      const outcome = await job.runner({
        prompt: buildIterationPrompt(goal, this.iterations),
        workspacePath: job.workspacePath,
        command: job.command,
        iteration: iteration.index,
      })

      const marker = parseGoalMarker(outcome.output)
      iteration.reasoning = outcome.output.trim().slice(0, MAX_REASONING_CHARS)
      iteration.result = marker.summary ?? iteration.reasoning
      iteration.goalAchieved = marker.achieved
      iteration.tokensUsed = outcome.tokensUsed
      if (outcome.tokensUsed !== null) {
        this.tokenSum = (this.tokenSum ?? 0) + outcome.tokensUsed
      }
      if (outcome.exitCode !== undefined && outcome.exitCode !== 0) {
        iteration.error = `Agent job exited with code ${outcome.exitCode}`
      }
      if (!iteration.error) {
        iteration.actions = parseActionLines(outcome.output)
        for (const action of iteration.actions) {
          if (this.stopped) {
            action.error = 'Stopped before the action was handled'
            break
          }
          const gated =
            this.config.requireApproval && this.config.requireApprovalFor.includes(action.type)
          action.approved = !gated
          try {
            action.result = await actionHandler(action)
          } catch (error) {
            action.error = error instanceof Error ? error.message : String(error)
            action.approved = false
          }
        }
      }
    } catch (error) {
      iteration.error = error instanceof Error ? error.message : String(error)
      logger.error({ err: error, iteration: iteration.index }, 'autonomous-agent: iteration failed')
    }

    iteration.endTime = Date.now()
    return iteration
  }

  private buildResult(
    stoppedReason: AutonomousAgentResult['stoppedReason'],
    finalResult: string
  ): AutonomousAgentResult {
    const result: AutonomousAgentResult = {
      success: stoppedReason === 'completed',
      iterations: this.iterations,
      totalTokens: this.tokenSum,
      totalDurationMs: Date.now() - this.startTime,
      finalResult,
      stoppedReason,
    }

    logger.info(
      {
        success: result.success,
        iterations: result.iterations.length,
        tokens: result.totalTokens,
        duration: result.totalDurationMs,
        reason: stoppedReason,
      },
      'autonomous-agent: finished'
    )

    this.emit('completed', result)
    return result
  }
}

/**
 * Creates an autonomous agent.
 */
export function createAutonomousAgent(config?: Partial<AutonomousAgentConfig>): AutonomousAgent {
  return new AutonomousAgent(config)
}
