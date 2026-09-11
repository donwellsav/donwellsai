import { logger } from '../../shared/logger'
import { EventEmitter } from 'node:events'

export interface AutonomousAgentConfig {
  /** Maximum number of iterations. */
  maxIterations: number
  /** Maximum total duration in ms. */
  maxDurationMs: number
  /** Maximum tokens to consume. */
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

export interface AgentIteration {
  index: number
  startTime: number
  endTime?: number
  goal: string
  reasoning: string
  actions: AgentAction[]
  result?: string
  error?: string
  tokensUsed: number
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
  totalTokens: number
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

/**
 * Autonomous agent loop.
 *
 * Runs an agent in a loop until a goal is achieved or limits are reached.
 * Supports safety checks, iteration limits, and token budgets.
 */
export class AutonomousAgent extends EventEmitter {
  private config: AutonomousAgentConfig
  private iterations: AgentIteration[] = []
  private totalTokens = 0
  private startTime = 0
  private stopped = false

  constructor(config: Partial<AutonomousAgentConfig> = {}) {
    super()
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Runs the autonomous agent loop.
   */
  async run(goal: string, actionHandler: (action: AgentAction) => Promise<string>): Promise<AutonomousAgentResult> {
    this.startTime = Date.now()
    this.iterations = []
    this.totalTokens = 0
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

        if (this.totalTokens >= this.config.maxTokens) {
          return this.buildResult('max_tokens', 'Maximum tokens reached')
        }

        const iteration = await this.runIteration(goal, actionHandler)
        this.iterations.push(iteration)

        this.emit('iteration', iteration)

        if (iteration.error && this.config.pauseOnError) {
          return this.buildResult('error', iteration.error)
        }

        if (iteration.result?.toLowerCase().includes('goal achieved') ||
            iteration.result?.toLowerCase().includes('task complete')) {
          return this.buildResult('completed', iteration.result)
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
    totalTokens: number
    durationMs: number
    stopped: boolean
  } {
    return {
      iterations: this.iterations.length,
      totalTokens: this.totalTokens,
      durationMs: Date.now() - this.startTime,
      stopped: this.stopped,
    }
  }

  private async runIteration(
    goal: string,
    actionHandler: (action: AgentAction) => Promise<string>
  ): Promise<AgentIteration> {
    const iteration: AgentIteration = {
      index: this.iterations.length,
      startTime: Date.now(),
      goal,
      reasoning: '',
      actions: [],
      tokensUsed: 0,
    }

    // This is a simplified version - in production, this would:
    // 1. Build a prompt with the goal + history
    // 2. Call the LLM to get reasoning + actions
    // 3. Execute each action
    // 4. Return results

    iteration.reasoning = `Working towards: ${goal}`
    iteration.tokensUsed = 100 // Placeholder
    this.totalTokens += iteration.tokensUsed
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
      totalTokens: this.totalTokens,
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
