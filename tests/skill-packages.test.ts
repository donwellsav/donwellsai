import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillPackagesManager } from '../src/main/skills'
import { runProcess } from '../src/shared/child-process/run-process'

const fixturePackage = fileURLToPath(new URL('fixtures/skill-package', import.meta.url))
const fixtureConsumer = fileURLToPath(new URL('fixtures/skill-consumer.mjs', import.meta.url))
const temporaryDirectories: string[] = []

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `skill-packages-${label}-`))
  temporaryDirectories.push(directory)
  return directory
}

function managerFor(userData: string, workspace: string): SkillPackagesManager {
  const authorized = realpathSync(workspace)
  return new SkillPackagesManager(userData, {
    resolveWorkspace(requestedPath) {
      if (realpathSync(requestedPath) !== authorized) throw new Error('not registered')
      return authorized
    }
  })
}

function writePackage(root: string, reference: string, name = 'safe-skill'): void {
  mkdirSync(join(root, 'references'), { recursive: true })
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'SKILL.md'), `---\nname: ${name}\ndescription: Exercise a safe disposable package lifecycle.\nversion: "1.0.0"\n---\n\nRead references/policy.txt before acting.\n`)
  writeFileSync(join(root, 'references', 'policy.txt'), reference)
  writeFileSync(join(root, 'scripts', 'inert.mjs'), "process.stdout.write('only when explicitly run\\n')\n")
}

async function install(manager: SkillPackagesManager, workspace: string, sourcePath: string, providerId: 'codex' | 'claude' | 'opencode' = 'codex') {
  const plan = await manager.prepare({ workspacePath: workspace, providerId, source: { kind: 'local', path: sourcePath } })
  expect(plan.state).toBe('ready')
  return manager.apply({ planId: plan.id, confirmationToken: plan.confirmationToken })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('SkillPackagesManager', () => {
  it('materializes a complete package at a documented consumer path without executing scripts', async () => {
    const workspace = temporaryDirectory('workspace')
    const userData = temporaryDirectory('userdata')
    const marker = join(workspace, 'package-script-ran')
    const legacyDirectory = join(userData, 'skills')
    mkdirSync(legacyDirectory)
    writeFileSync(join(legacyDirectory, 'preserved.md'), '# Preserved legacy document\n')
    writeFileSync(join(legacyDirectory, '_index.json'), JSON.stringify([
      { name: 'preserved', source: 'https://example.test/old.md', installedAt: '2024-01-01T00:00:00.000Z', size: 28 }
    ]))
    const manager = managerFor(userData, workspace)

    const previousMarker = process.env.SKILL_FIXTURE_MARKER
    process.env.SKILL_FIXTURE_MARKER = marker
    let plan
    try {
      plan = await manager.prepare({
        workspacePath: workspace,
        providerId: 'codex',
        source: { kind: 'local', path: fixturePackage }
      })
    } finally {
      if (previousMarker === undefined) delete process.env.SKILL_FIXTURE_MARKER
      else process.env.SKILL_FIXTURE_MARKER = previousMarker
    }

    expect(plan.state).toBe('ready')
    expect(plan.target.consumerRoot).toBe(join(realpathSync(workspace), '.agents', 'skills'))
    expect(plan.target.packagePath).toBe(join(realpathSync(workspace), '.agents', 'skills', 'release-check'))
    expect(plan.source.revision).toBe(`sha256:${plan.source.contentHash}`)
    expect(plan.source.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(plan.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'assets/checklist.txt',
      'references/policy.txt',
      'scripts/collect.mjs'
    ])
    expect(plan.files.every((file) => file.action === 'create' && /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true)
    expect(plan.warnings).toContain('Package scripts are copied as inert files. The package manager never executes them.')
    expect(existsSync(marker)).toBe(false)

    const result = await manager.apply({ planId: plan.id, confirmationToken: plan.confirmationToken })
    expect(result.package?.health).toBe('ready')
    expect(readFileSync(join(workspace, '.agents', 'skills', 'release-check', 'references', 'policy.txt'), 'utf8')).toContain('clean build')
    expect(lstatSync(join(workspace, '.agents', 'skills', 'release-check', 'scripts', 'collect.mjs')).mode & 0o111).toBe(0)
    expect(existsSync(marker)).toBe(false)

    const consumer = await runProcess({
      program: process.platform === 'win32' ? process.execPath : fixtureConsumer,
      args: process.platform === 'win32' ? [fixtureConsumer, workspace, 'codex'] : [workspace, 'codex'],
      cwd: workspace,
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
      executionHost: { kind: 'local' }
    })
    expect(JSON.parse(consumer.stdout)).toEqual({
      provider: 'codex',
      root: join(realpathSync(workspace), '.agents', 'skills'),
      skills: [{
        name: 'release-check',
        path: join(realpathSync(workspace), '.agents', 'skills', 'release-check', 'SKILL.md')
      }]
    })

    const listed = await manager.list({ workspacePath: workspace, providerId: 'codex' })
    expect(listed.packages).toHaveLength(1)
    expect(listed.packages[0]?.health).toBe('ready')
    expect(listed.legacyDocuments).toEqual([
      {
        id: 'preserved.md',
        name: 'preserved',
        fileName: 'preserved.md',
        source: 'https://example.test/old.md',
        bytes: 28,
        preserved: true
      }
    ])
    const preview = await manager.read({
      kind: 'package',
      workspacePath: workspace,
      providerId: 'codex',
      name: 'release-check'
    })
    expect(preview.encoding).toBe('utf8')
    expect(preview.content).toContain('name: release-check')
    const legacy = await manager.read({ kind: 'legacy', id: 'preserved.md' })
    expect(legacy.content).toBe('# Preserved legacy document\n')
    expect(readFileSync(join(legacyDirectory, 'preserved.md'), 'utf8')).toBe('# Preserved legacy document\n')
  })

  it('blocks update and removal around user edits, then applies clean update and confirmed removal', async () => {
    const workspace = temporaryDirectory('workspace')
    const userData = temporaryDirectory('userdata')
    const source = temporaryDirectory('source')
    writePackage(source, 'revision one\n')
    const manager = managerFor(userData, workspace)
    await install(manager, workspace, source)
    const targetReference = join(workspace, '.agents', 'skills', 'safe-skill', 'references', 'policy.txt')

    writeFileSync(targetReference, 'user-authored edit\n')
    writeFileSync(join(source, 'references', 'policy.txt'), 'revision two\n')
    const blockedUpdate = await manager.prepareUpdate({ workspacePath: workspace, providerId: 'codex', name: 'safe-skill' })
    expect(blockedUpdate.state).toBe('blocked')
    expect(blockedUpdate.conflicts).toContainEqual(expect.objectContaining({
      path: 'references/policy.txt',
      kind: 'owned-file-modified'
    }))
    await expect(manager.apply({ planId: blockedUpdate.id, confirmationToken: blockedUpdate.confirmationToken })).rejects.toMatchObject({ code: 'plan-blocked' })
    expect(readFileSync(targetReference, 'utf8')).toBe('user-authored edit\n')

    const blockedRemoval = await manager.prepareRemove({ workspacePath: workspace, providerId: 'codex', name: 'safe-skill' })
    expect(blockedRemoval.state).toBe('blocked')
    expect(blockedRemoval.files).toContainEqual(expect.objectContaining({ path: 'references/policy.txt', action: 'protect' }))
    await expect(manager.remove({ planId: blockedRemoval.id, confirmationToken: blockedRemoval.confirmationToken })).rejects.toMatchObject({ code: 'plan-blocked' })
    expect(readFileSync(targetReference, 'utf8')).toBe('user-authored edit\n')

    writeFileSync(targetReference, 'revision one\n')
    const update = await manager.prepareUpdate({ workspacePath: workspace, providerId: 'codex', name: 'safe-skill' })
    expect(update.state).toBe('ready')
    expect(update.files).toContainEqual(expect.objectContaining({ path: 'references/policy.txt', action: 'update' }))
    const updated = await manager.apply({ planId: update.id, confirmationToken: update.confirmationToken })
    expect(updated.operation).toBe('update')
    expect(readFileSync(targetReference, 'utf8')).toBe('revision two\n')

    writeFileSync(targetReference, 'second user edit\n')
    const protectedRemoval = await manager.prepareRemove({ workspacePath: workspace, providerId: 'codex', name: 'safe-skill' })
    expect(protectedRemoval.state).toBe('blocked')
    expect(readFileSync(targetReference, 'utf8')).toBe('second user edit\n')
    writeFileSync(targetReference, 'revision two\n')

    const removal = await manager.prepareRemove({ workspacePath: workspace, providerId: 'codex', name: 'safe-skill' })
    expect(removal.state).toBe('ready')
    expect(removal.files.filter((file) => file.action === 'remove')).toHaveLength(3)
    const removed = await manager.remove({ planId: removal.id, confirmationToken: removal.confirmationToken })
    expect(removed.removed).toBe(true)
    expect(existsSync(join(workspace, '.agents', 'skills', 'safe-skill'))).toBe(false)
    expect(readFileSync(join(source, 'references', 'policy.txt'), 'utf8')).toBe('revision two\n')
    expect((await manager.list({ workspacePath: workspace, providerId: 'codex' })).packages).toEqual([])
  })

  it('fails closed for invalid names, source symlinks, target symlinks, collisions, and stale plans', async () => {
    const workspace = temporaryDirectory('workspace')
    const userData = temporaryDirectory('userdata')
    const manager = managerFor(userData, workspace)

    const traversalSource = temporaryDirectory('traversal-source')
    writePackage(traversalSource, 'policy\n', '../escape')
    await expect(manager.prepare({
      workspacePath: workspace,
      providerId: 'codex',
      source: { kind: 'local', path: traversalSource }
    })).rejects.toThrow('Skill name must be')

    if (process.platform !== 'win32') {
      const linkedSource = temporaryDirectory('linked-source')
      writePackage(linkedSource, 'policy\n')
      symlinkSync('/etc/hosts', join(linkedSource, 'references', 'outside.txt'))
      await expect(manager.prepare({
        workspacePath: workspace,
        providerId: 'codex',
        source: { kind: 'local', path: linkedSource }
      })).rejects.toThrow('Symbolic links are not allowed')
    }

    const source = temporaryDirectory('source')
    writePackage(source, 'source content\n')
    const collisionPath = join(workspace, '.agents', 'skills', 'safe-skill', 'SKILL.md')
    mkdirSync(dirname(collisionPath), { recursive: true })
    writeFileSync(collisionPath, 'user-owned collision\n')
    const collision = await manager.prepare({ workspacePath: workspace, providerId: 'codex', source: { kind: 'local', path: source } })
    expect(collision.state).toBe('blocked')
    expect(collision.conflicts[0]?.kind).toBe('existing-package')
    await expect(manager.apply({ planId: collision.id, confirmationToken: collision.confirmationToken })).rejects.toMatchObject({ code: 'plan-blocked' })
    expect(readFileSync(collisionPath, 'utf8')).toBe('user-owned collision\n')

    rmSync(join(workspace, '.agents'), { recursive: true })
    const stale = await manager.prepare({ workspacePath: workspace, providerId: 'codex', source: { kind: 'local', path: source } })
    mkdirSync(dirname(collisionPath), { recursive: true })
    writeFileSync(collisionPath, 'appeared after plan\n')
    await expect(manager.apply({ planId: stale.id, confirmationToken: stale.confirmationToken })).rejects.toMatchObject({ code: 'plan-stale' })
    expect(readFileSync(collisionPath, 'utf8')).toBe('appeared after plan\n')

    if (process.platform !== 'win32') {
      rmSync(join(workspace, '.agents'), { recursive: true })
      const outside = temporaryDirectory('outside')
      mkdirSync(join(workspace, '.agents'))
      symlinkSync(outside, join(workspace, '.agents', 'skills'))
      const unsafe = await manager.prepare({ workspacePath: workspace, providerId: 'codex', source: { kind: 'local', path: source } })
      expect(unsafe.state).toBe('blocked')
      expect(unsafe.conflicts).toContainEqual(expect.objectContaining({ kind: 'unsafe-path' }))
      await expect(manager.apply({ planId: unsafe.id, confirmationToken: unsafe.confirmationToken })).rejects.toMatchObject({ code: 'plan-blocked' })
      expect(readdirSync(outside)).toEqual([])
    }
  })

  it('rejects an unregistered target workspace', async () => {
    const workspace = temporaryDirectory('workspace')
    const otherWorkspace = temporaryDirectory('other-workspace')
    const userData = temporaryDirectory('userdata')
    const manager = managerFor(userData, workspace)

    await expect(manager.prepare({
      workspacePath: otherWorkspace,
      providerId: 'codex',
      source: { kind: 'local', path: fixturePackage }
    })).rejects.toMatchObject({ code: 'unauthorized-workspace' })
    expect(existsSync(join(otherWorkspace, '.agents'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('rolls updates and removals back when the ownership registry cannot commit', async () => {
    const workspace = temporaryDirectory('workspace')
    const userData = temporaryDirectory('userdata')
    const source = temporaryDirectory('source')
    writePackage(source, 'before transaction\n')
    const manager = managerFor(userData, workspace)
    await install(manager, workspace, source)
    const targetReference = join(workspace, '.agents', 'skills', 'safe-skill', 'references', 'policy.txt')
    writeFileSync(join(source, 'references', 'policy.txt'), 'after transaction\n')
    const update = await manager.prepareUpdate({ workspacePath: workspace, providerId: 'codex', name: 'safe-skill' })
    expect(update.state).toBe('ready')

    chmodSync(userData, 0o500)
    try {
      await expect(manager.apply({ planId: update.id, confirmationToken: update.confirmationToken })).rejects.toBeTruthy()
    } finally {
      chmodSync(userData, 0o700)
    }
    expect(readFileSync(targetReference, 'utf8')).toBe('before transaction\n')
    expect((await manager.list({ workspacePath: workspace, providerId: 'codex' })).packages[0]?.health).toBe('ready')
    const removal = await manager.prepareRemove({ workspacePath: workspace, providerId: 'codex', name: 'safe-skill' })
    expect(removal.state).toBe('ready')
    chmodSync(userData, 0o500)
    try {
      await expect(manager.remove({ planId: removal.id, confirmationToken: removal.confirmationToken })).rejects.toBeTruthy()
    } finally {
      chmodSync(userData, 0o700)
    }
    expect(readFileSync(targetReference, 'utf8')).toBe('before transaction\n')
    expect((await manager.list({ workspacePath: workspace, providerId: 'codex' })).packages[0]?.health).toBe('ready')
    expect(readdirSync(join(workspace, '.agents', 'skills'))).toEqual(['safe-skill'])
  })
})
