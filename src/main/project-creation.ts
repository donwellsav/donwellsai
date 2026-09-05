import { mkdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { runProcess } from '@shared/child-process/run-process'
import { sanitizedProcessEnv } from '@shared/child-process/process-environment'
import {
  validateProjectCreationRequest,
  type CreateProjectRequest
} from '@shared/project-creation'
import type { RepoSummary } from '@shared/types'

export type ProjectRegistration = (createdPath: string) => Promise<RepoSummary>
export type ProjectCreationStage = 'validation' | 'folder' | 'git' | 'registration'

export class ProjectCreationError extends Error {
  constructor(
    message: string,
    readonly stage: ProjectCreationStage,
    readonly projectPath?: string,
    options: { cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ProjectCreationError'
  }
}

function causeMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message.trim()
  return String(cause)
}

function isNodeError(cause: unknown, code: string): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === code
}

async function initializeGitRepository(projectPath: string): Promise<void> {
  const processOptions = {
    program: 'git',
    cwd: projectPath,
    env: sanitizedProcessEnv(),
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024
  } as const
  // Git 2.25 predates `git init -b`. Set the unborn branch with commands available there.
  await runProcess({ ...processOptions, args: ['init'] })
  await runProcess({ ...processOptions, args: ['symbolic-ref', 'HEAD', 'refs/heads/main'] })
}

/**
 * Create an exclusive, empty project directory, optionally initialize an unborn
 * Git repository, then register the finished directory. Failures never delete
 * the directory or any partial Git data because it may already contain user data.
 */
export async function createProject(
  input: CreateProjectRequest,
  registerProject: ProjectRegistration
): Promise<RepoSummary> {
  const validation = validateProjectCreationRequest(input)
  if (!validation.ok) throw new ProjectCreationError(validation.error, 'validation')

  const { parentPath, name, initializeGit } = validation.request
  if (!isAbsolute(parentPath)) {
    throw new ProjectCreationError('Location must be an absolute folder path for this operating system.', 'validation')
  }

  const resolvedParentPath = resolve(parentPath)
  const projectPath = join(resolvedParentPath, name)
  let parentStats
  try {
    parentStats = await stat(resolvedParentPath)
  } catch (cause) {
    throw new ProjectCreationError(
      `Cannot create project at “${projectPath}”: location “${resolvedParentPath}” is not available. ${causeMessage(cause)}`,
      'folder',
      projectPath,
      { cause }
    )
  }
  if (!parentStats.isDirectory()) {
    throw new ProjectCreationError(
      `Cannot create project at “${projectPath}”: location “${resolvedParentPath}” is not a folder.`,
      'folder',
      projectPath
    )
  }

  try {
    await mkdir(projectPath)
  } catch (cause) {
    if (isNodeError(cause, 'EEXIST')) {
      throw new ProjectCreationError(
        `A file or folder already exists at “${projectPath}”. Choose another name or location; nothing was changed.`,
        'folder',
        projectPath,
        { cause }
      )
    }
    throw new ProjectCreationError(
      `Could not create project folder at “${projectPath}”: ${causeMessage(cause)}`,
      'folder',
      projectPath,
      { cause }
    )
  }

  if (initializeGit) {
    try {
      await initializeGitRepository(projectPath)
    } catch (cause) {
      throw new ProjectCreationError(
        `Project folder was created at “${projectPath}”, but Git initialization failed: ${causeMessage(cause)} The folder was left in place.`,
        'git',
        projectPath,
        { cause }
      )
    }
  }

  try {
    return await registerProject(projectPath)
  } catch (cause) {
    throw new ProjectCreationError(
      `Project was created at “${projectPath}”, but it could not be registered: ${causeMessage(cause)} The folder was left in place.`,
      'registration',
      projectPath,
      { cause }
    )
  }
}
