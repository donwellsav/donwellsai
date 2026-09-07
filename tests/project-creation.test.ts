import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitWorktrees } from '../src/main/git'
import { createProject, ProjectCreationError } from '../src/main/project-creation'
import { Store } from '../src/main/store'
import { APP_WORKFLOW_FILES, projectCreationTargetPath } from '../src/shared/project-creation'
import type { RepoSummary } from '../src/shared/types'

const cleanup: string[] = []

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

function tempParent(): string {
  const path = mkdtempSync(join(tmpdir(), 'donwells-project-create-'))
  cleanup.push(path)
  return path
}

function summaryFor(path: string, kind: 'git' | 'folder'): RepoSummary {
  return {
    repo: { id: `repo:${path}`, path, kind, addedAt: '2026-09-05T00:00:00.000Z' },
    worktrees: [{ id: `repo:${path}`, path, branch: kind === 'git' ? 'main' : '', isMain: true }],
    lineage: {},
    defaultBranch: kind === 'git' ? 'main' : ''
  }
}

describe('projectCreationTargetPath', () => {
  it('uses the path syntax of the selected parent location', () => {
    expect(projectCreationTargetPath('/Users/me/projects', 'demo')).toBe('/Users/me/projects/demo')
    expect(projectCreationTargetPath('/Users/me/projects\\', 'demo')).toBe('/Users/me/projects\\/demo')
    expect(projectCreationTargetPath('C:\\Users\\me', 'demo')).toBe('C:\\Users\\me\\demo')
    expect(projectCreationTargetPath('C:/Users/me', 'demo')).toBe('C:/Users/me/demo')
  })
})

describe('createProject', () => {
  it('creates the reviewed versioned workflow exclusively and rejects unknown workflow versions', async () => {
    const parentPath = tempParent()
    const result = await createProject({ parentPath, name: 'app', initializeGit: false, workflow: 'app-workflow-v1' }, async (path) => summaryFor(path, 'folder'))
    for (const [path, content] of Object.entries(APP_WORKFLOW_FILES)) {
      expect(readFileSync(join(result.repo.path, path), 'utf8')).toBe(content)
    }
    expect(existsSync(join(result.repo.path, 'AGENTS.md'))).toBe(false)
    writeFileSync(join(result.repo.path, 'SPEC.md'), 'User specification')
    await expect(createProject({ parentPath, name: 'app', initializeGit: false, workflow: 'app-workflow-v1' }, async (path) => summaryFor(path, 'folder'))).rejects.toMatchObject({ stage: 'folder' })
    expect(readFileSync(join(result.repo.path, 'SPEC.md'), 'utf8')).toBe('User specification')
    await expect(createProject({ parentPath, name: 'unknown', initializeGit: false, workflow: 'other' as 'app-workflow-v1' }, async (path) => summaryFor(path, 'folder'))).rejects.toMatchObject({ stage: 'validation' })
    expect(existsSync(join(parentPath, 'unknown'))).toBe(false)
  })

  it('creates a plain folder exclusively and registers only after the folder exists', async () => {
    const parentPath = tempParent()
    const expectedPath = join(parentPath, 'notes')
    let registrationPath: string | undefined

    const result = await createProject(
      { parentPath, name: 'notes', initializeGit: false },
      async (createdPath) => {
        registrationPath = createdPath
        expect(existsSync(createdPath)).toBe(true)
        expect(existsSync(join(createdPath, '.git'))).toBe(false)
        return summaryFor(createdPath, 'folder')
      }
    )

    expect(registrationPath).toBe(expectedPath)
    expect(result.repo.path).toBe(expectedPath)
  })

  it('never overwrites or registers an existing path', async () => {
    const parentPath = tempParent()
    const projectPath = join(parentPath, 'existing')
    mkdirSync(projectPath)
    writeFileSync(join(projectPath, 'keep.txt'), 'user data')
    let registered = false

    await expect(createProject(
      { parentPath, name: 'existing', initializeGit: false },
      async (createdPath) => {
        registered = true
        return summaryFor(createdPath, 'folder')
      }
    )).rejects.toMatchObject({ stage: 'folder', projectPath })

    expect(registered).toBe(false)
    expect(readFileSync(join(projectPath, 'keep.txt'), 'utf8')).toBe('user data')
  })

  it.each(['..', '.', '../escape', 'nested/project', 'nested\\project', 'CON', 'name.'])(
    'rejects unsafe cross-platform project name %s before touching disk',
    async (name) => {
      const parentPath = tempParent()
      let registered = false

      await expect(createProject(
        { parentPath, name, initializeGit: false },
        async (createdPath) => {
          registered = true
          return summaryFor(createdPath, 'folder')
        }
      )).rejects.toMatchObject({ stage: 'validation' })

      expect(registered).toBe(false)
      expect(readdirSync(parentPath)).toEqual([])
    }
  )

  it('initializes and registers a real unborn main-branch repository without Git identity', async () => {
    const parentPath = tempParent()
    const git = new GitWorktrees(new Store(join(parentPath, 'state')))
    const result = await createProject(
      { parentPath, name: 'git-project', initializeGit: true },
      async (createdPath) => {
        expect(existsSync(join(createdPath, '.git'))).toBe(true)
        expect(execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: createdPath, encoding: 'utf8' }).trim()).toBe('main')
        expect(() => execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: createdPath, stdio: 'ignore' })).toThrow()
        expect(() => execFileSync('git', ['config', '--local', '--get', 'user.name'], { cwd: createdPath, stdio: 'ignore' })).toThrow()
        expect(() => execFileSync('git', ['config', '--local', '--get', 'user.email'], { cwd: createdPath, stdio: 'ignore' })).toThrow()
        return git.addRepo(createdPath)
      }
    )

    expect(result.repo.kind).toBe('git')
    expect(result.defaultBranch).toBe('main')
    expect(result.worktrees).toMatchObject([{ branch: 'main', isMain: true }])
  })

  it('preserves the created directory and reports its path when registration fails', async () => {
    const parentPath = tempParent()
    const projectPath = join(parentPath, 'unregistered')
    const failure = createProject(
      { parentPath, name: 'unregistered', initializeGit: true },
      async () => { throw new Error('store is unavailable') }
    )

    await expect(failure).rejects.toSatisfy((cause: unknown) =>
      cause instanceof ProjectCreationError
      && cause.stage === 'registration'
      && cause.projectPath === projectPath
      && cause.message.includes(projectPath)
      && cause.message.includes('left in place')
    )
    expect(existsSync(projectPath)).toBe(true)
    expect(existsSync(join(projectPath, '.git'))).toBe(true)
  })
})
