import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../../shared/logger'
import type { DaemonClient } from '../daemon-client'
import type { AutonomousJobOutcome, AutonomousJobRequest } from './autonomous-agent'

/** Daemon command cap: anything longer goes through a prompt file instead. */
const MAX_COMMAND_BYTES = 16 * 1024

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export interface DaemonJobRunnerOptions {
  /** Poll interval between job.result inspections. */
  pollIntervalMs?: number
  /** Hard deadline for a single iteration job. */
  maxPollMs?: number
}

/**
 * Runs each autonomous iteration as a finite daemon job.
 *
 * The agent command receives the prompt inline when it fits the 16KiB
 * command cap; otherwise the prompt is written under the workspace's
 * `.donwells/autonomous/` directory (0700 dir / 0600 file) and the
 * command reads it back. Token usage is surfaced as null until a real
 * provider usage source is wired (unavailable, never guessed).
 */
export function createDaemonJobRunner(
  terminals: DaemonClient,
  options: DaemonJobRunnerOptions = {}
): (request: AutonomousJobRequest) => Promise<AutonomousJobOutcome> {
  const pollIntervalMs = options.pollIntervalMs ?? 1000
  const maxPollMs = options.maxPollMs ?? 10 * 60 * 1000

  return async (request: AutonomousJobRequest): Promise<AutonomousJobOutcome> => {
    const inlineCommand = `${request.command} ${shellQuote(request.prompt)}`
    let command = inlineCommand

    if (Buffer.byteLength(inlineCommand, 'utf8') > MAX_COMMAND_BYTES) {
      const relDir = join('.donwells', 'autonomous', randomBytes(6).toString('hex'))
      const relPath = join(relDir, `prompt-${request.iteration + 1}.md`)
      mkdirSync(join(request.workspacePath, relDir), { recursive: true, mode: 0o700 })
      writeFileSync(join(request.workspacePath, relPath), request.prompt, { mode: 0o600 })
      command = `${request.command} $(cat ${shellQuote(relPath)})`
    }

    const session = await terminals.openJob(request.workspacePath, command)
    try {
      const deadline = Date.now() + maxPollMs
      for (;;) {
        const result = await terminals.jobResult(session.id)
        if (result.exited) {
          // DaemonJobResult carries {exited, exitCode, output, sequence} only — the finite-job
          // path has no per-run token meter. Provider usage is analyzed per session elsewhere
          // (project-analytics), never as a live job field, so 'unavailable' is the honest value.
          return { output: result.output, exitCode: result.exitCode, tokensUsed: null }
        }
        if (Date.now() >= deadline) {
          throw new Error(`Autonomous job exceeded ${maxPollMs}ms without exiting`)
        }
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
      }
    } finally {
      try {
        await terminals.close(session.id)
      } catch (err) {
        logger.error({ err, sessionId: session.id }, 'autonomous-runner: close failed')
      }
    }
  }
}
