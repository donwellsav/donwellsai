import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, fsyncSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import { link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { isObject } from '@shared/command-catalog'
import { parseProjectMemoryDocument, type ProjectMemoryProjectDocument, type ProjectMemoryRevision } from '@shared/project-memory'
import { parseProjectHandoff, type ProjectHandoff } from '@shared/project-handoff'
import { INTEGRATED_PROJECT_TOOLS } from '@shared/project-doctor'
import { redactDesignCaptureSecrets } from '@shared/design-capture'
import { validateProjectName } from '@shared/project-creation'
import type { ProjectKitApi, ProjectKitPreview, ProjectKitReport } from '@shared/project-export'
import type { PersistedState, Repo } from '@shared/types'
import { restoreWorkspaceLayout } from '../renderer/src/workspace-layout'
import { ProjectMemoryStore } from './project-memory-store'
import { ProjectHandoffStore } from './project-handoff'
import { resolveProjectToolScope } from './project-tools'
import { ProcessExecutionError, runProcess } from '@shared/child-process/run-process'
import { sanitizedProcessEnv } from '@shared/child-process/process-environment'
import { WorktreeFiles } from './worktree-files'
import { idFromPath, type Store } from './store'
import type { ProjectDoctor } from './project-doctor'

const MAX_BYTES = 32 * 1024 * 1024
const PORTABLE_ROOT = '/project'
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
type SavedWorkspace = NonNullable<PersistedState['workspaceSession']>['repos'][string]
type PortablePane = { key: string; kind: SavedWorkspace['panes'][string][number]['kind'] }
type Payload = {
  memory: ProjectMemoryProjectDocument
  handoffs: ProjectHandoff[]
  artifacts: Array<{ path: string; content: string }>
  layout: { panes: PortablePane[]; docking: unknown }
  tools: ProjectKitPreview['tools']
}
type Kit = { schemaVersion: 1; archiveId: string; sourceName: string; sourceProjectKey: string; createdAt: string; checksums: Record<keyof Payload, string>; payload: Payload }
const sections = ['memory', 'handoffs', 'artifacts', 'layout', 'tools'] as const
const warnings = ['Imported evidence and handoffs are historical; verify against this checkout before reuse.', 'Code, document and native session indexes must be rebuilt. No derived caches are included.', 'Tool executables, models, reference roots, agent sessions and credentials require local setup. All project tools start disabled.']

function artifactPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024 || !value || /[\\\x00-\x1f\x7f:]/.test(value) || value.split('/').some(part => !part || part === '..' || part.startsWith('.')) || /(?:^|\/)(?:node_modules|credentials?|secrets?|cookies?|auth|env|environment)(?:[./]|$)/i.test(value) || /\.(?:pem|key|p12|pfx|sqlite|db)$/i.test(value)) throw new Error('Select a relative, non-secret text artifact path')
  return value
}
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!isObject(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error('Invalid project kit fields')
}
function safeText(value: string): string {
  return redactDesignCaptureSecrets(value).replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
}
function portableRevision<T extends ProjectMemoryRevision>(revision: T): T {
  return { ...revision, title: safeText(revision.title), content: safeText(revision.content), tags: revision.tags.map(safeText), provenance: { harness: revision.provenance.harness, workspace: PORTABLE_ROOT, sourceSession: null, sourceRef: null } }
}

/** Bounded regular-file reads, including a post-read size check for concurrent growth. */
async function readBounded(path: string): Promise<Buffer> {
  if (!isAbsolute(path)) throw new Error('Choose an absolute local path')
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Project kit must be a regular file no larger than 32 MiB')
    const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_BYTES + 1))
    let length = 0
    while (length < bytes.length) { const read = await file.read(bytes, length, bytes.length - length); if (!read.bytesRead) break; length += read.bytesRead }
    if (length !== stat.size) throw new Error('Project kit changed while reading')
    return bytes.subarray(0, length)
  } finally { await file.close() }
}

function parseKit(bytes: Buffer): Kit {
  let kit: unknown
  try { kit = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('Project kit contains invalid JSON') }
  exact(kit, ['schemaVersion', 'archiveId', 'sourceName', 'sourceProjectKey', 'createdAt', 'checksums', 'payload'])
  if (kit.schemaVersion !== 1 || typeof kit.archiveId !== 'string' || !/^[a-f0-9-]{36}$/.test(kit.archiveId) || typeof kit.sourceProjectKey !== 'string' || !/^[a-f0-9]{64}$/.test(kit.sourceProjectKey) || validateProjectName(kit.sourceName) || typeof kit.createdAt !== 'string' || !Number.isFinite(Date.parse(kit.createdAt))) throw new Error('Unsupported or invalid project kit manifest')
  exact(kit.payload, sections); exact(kit.checksums, sections)
  for (const key of sections) if (kit.checksums[key] !== hash(JSON.stringify(kit.payload[key]))) throw new Error('Project kit checksum mismatch: ' + key)
  const memory = parseProjectMemoryDocument({ schemaVersion: 1, projects: [kit.payload.memory] }).projects[0]!
  if (memory.projectKey !== kit.sourceProjectKey || memory.projectPath !== PORTABLE_ROOT) throw new Error('Project kit memory identity mismatch')
  if (!Array.isArray(kit.payload.handoffs) || kit.payload.handoffs.length > 2500) throw new Error('Project kit handoff limit exceeded')
  const handoffs = kit.payload.handoffs.map(parseProjectHandoff)
  if (new Set(handoffs.map(value => value.id)).size !== handoffs.length || handoffs.some(value => value.projectKey !== kit.sourceProjectKey || value.checkoutPath !== PORTABLE_ROOT)) throw new Error('Project kit handoff identity mismatch')
  if (!Array.isArray(kit.payload.artifacts) || kit.payload.artifacts.length > 100) throw new Error('Select at most 100 text artifacts')
  const artifacts = kit.payload.artifacts.map(value => {
    exact(value, ['path', 'content']); const path = artifactPath(value.path)
    if (typeof value.content !== 'string' || value.content.includes('\0') || Buffer.byteLength(value.content) > 512 * 1024) throw new Error('Artifact exceeds supported text size')
    return { path, content: value.content }
  })
  if (new Set(artifacts.map(value => value.path.normalize('NFC').toLocaleLowerCase('en-US'))).size !== artifacts.length) throw new Error('Duplicate artifact paths')
  if (artifacts.some(a => artifacts.some(b => a !== b && b.path.toLowerCase().startsWith(a.path.toLowerCase() + '/')))) throw new Error('Artifact file/directory collision')
  exact(kit.payload.layout, ['panes', 'docking'])
  if (!Array.isArray(kit.payload.layout.panes) || kit.payload.layout.panes.length > 64) throw new Error('Project kit panel limit exceeded')
  const panes = kit.payload.layout.panes.map(value => {
    exact(value, ['key', 'kind'])
    if (typeof value.key !== 'string' || !/^kit-pane-\d+$/.test(value.key) || !['terminal','explorer','git-status','browser','memory','recovery','search','computer'].includes(String(value.kind))) throw new Error('Invalid portable panel')
    return value as PortablePane
  })
  if (new Set(panes.map(value => value.key)).size !== panes.length) throw new Error('Duplicate portable panels')
  const docking = restoreWorkspaceLayout(kit.payload.layout.docking, panes).layout
  if (!Array.isArray(kit.payload.tools) || kit.payload.tools.length > 32) throw new Error('Invalid tool manifest')
  const tools = kit.payload.tools.map(value => {
    exact(value, ['id', 'version', 'configured', 'enabled'])
    if (typeof value.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.id) || typeof value.version !== 'string' || value.version.length > 128 || /[\x00-\x1f\x7f]/.test(value.version) || typeof value.configured !== 'boolean' || typeof value.enabled !== 'boolean') throw new Error('Invalid tool manifest entry')
    return value as ProjectKitPreview['tools'][number]
  })
  if (new Set(tools.map(value => value.id)).size !== tools.length) throw new Error('Duplicate tool identities')
  return { ...kit, payload: { memory, handoffs, artifacts, layout: { panes, docking }, tools } } as Kit
}
function preview(kit: Kit, digest: string): ProjectKitPreview {
  return { archiveId: kit.archiveId, sourceProjectKey: kit.sourceProjectKey, sourceName: kit.sourceName, sha256: digest, memories: kit.payload.memory.entries.length, revisions: kit.payload.memory.entries.reduce((n, entry) => n + entry.history.length, 0), handoffs: kit.payload.handoffs.length, artifacts: kit.payload.artifacts.map(value => value.path), tools: kit.payload.tools, warnings: [...warnings, ...kit.payload.tools.filter(value => !INTEGRATED_PROJECT_TOOLS.some(tool => tool.id === value.id && tool.version === value.version)).map(value => `Unsupported tool version: ${value.id} ${value.version}`)] }
}

export class ProjectExport implements ProjectKitApi {
  private files = new WorktreeFiles()
  constructor(private profile: string, private store: Store, private resolveWorkspace: (path: string) => Promise<{ path: string; projectPath: string }>, private doctor: Pick<ProjectDoctor, 'configuration'>, private onImported: () => void = () => {}) {}

  async projectKitExport(workspacePath: string, outputPath: string, selected: string[]) {
    if (!Array.isArray(selected) || selected.length > 100) throw new Error('Select at most 100 text artifacts')
    const scope = await resolveProjectToolScope(workspacePath, this.resolveWorkspace)
    const memory = new ProjectMemoryStore(this.profile).exportProject(scope)
    const handoffs = new ProjectHandoffStore(this.profile).list(scope.projectKey)
    const config = await this.doctor.configuration(workspacePath)
    const artifacts = []
    for (const input of selected) {
      const path = artifactPath(input), file = await this.files.readFile(scope.checkoutPath, path)
      if (file.binary || file.truncated) throw new Error('Artifact must be bounded UTF-8 text: ' + path)
      artifacts.push({ path, content: safeText(file.content) })
    }
    const repo = this.store.listRepos().find(value => value.path === scope.projectPath)!
    const saved = this.store.getWorkspaceSession()?.repos[repo.id]
    const original = (saved?.panes[scope.checkoutPath] ?? []).filter(pane => !['preview', 'diff'].includes(pane.kind)).slice(0, 64)
    const clean = restoreWorkspaceLayout(saved?.docking?.[scope.checkoutPath], original, saved?.layouts?.[scope.checkoutPath]).layout
    const keys = new Map(original.map((pane, index) => [pane.key, `kit-pane-${index}`]))
    const remap = (value: unknown): unknown => typeof value === 'string' ? keys.get(value) ?? value : Array.isArray(value) ? value.map(remap) : isObject(value) ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, remap(child)])) : value
    const panes = original.map(pane => ({ key: keys.get(pane.key)!, kind: pane.kind }))
    const payload: Payload = {
      memory: { projectKey: scope.projectKey, projectPath: PORTABLE_ROOT, entries: memory.entries.map(entry => ({ current: portableRevision(entry.current), history: entry.history.map(portableRevision) })) },
      handoffs: handoffs.map(value => ({ ...value, checkoutPath: PORTABLE_ROOT, goal: safeText(value.goal), summary: safeText(value.summary), openQuestions: value.openQuestions.map(safeText), nextSteps: value.nextSteps.map(safeText), fromSessionId: 'historical', acceptedBySessionId: value.acceptedBySessionId ? 'historical' : null, evidenceIds: [] })),
      artifacts, layout: { panes, docking: restoreWorkspaceLayout(remap(clean), panes).layout },
      tools: INTEGRATED_PROJECT_TOOLS.map(tool => ({ id: tool.id, version: tool.version, configured: tool.fields.some(field => Boolean(config[field])), enabled: !config.disabled.includes(tool.id) }))
    }
    const kit: Kit = { schemaVersion: 1, archiveId: randomUUID(), sourceName: basename(scope.projectPath), sourceProjectKey: scope.projectKey, createdAt: new Date().toISOString(), checksums: Object.fromEntries(sections.map(key => [key, hash(JSON.stringify(payload[key]))])) as Kit['checksums'], payload }
    const bytes = Buffer.from(JSON.stringify(kit) + '\n')
    if (bytes.length > MAX_BYTES) throw new Error('Selected project kit exceeds 32 MiB')
    parseKit(bytes)
    const current = await resolveProjectToolScope(workspacePath, this.resolveWorkspace)
    if (current.projectKey !== scope.projectKey || current.indexKey !== scope.indexKey) throw new Error('Project changed during export')
    if (!isAbsolute(outputPath)) throw new Error('Choose an absolute export path')
    const parent = await realpath(dirname(outputPath)), target = join(parent, basename(outputPath)), temp = join(parent, `.project-kit-${randomUUID()}.tmp`)
    try {
      const fd = openSync(temp, 'wx', 0o600)
      try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
      if (!(await readBounded(temp)).equals(bytes)) throw new Error('Project kit export verification failed')
      // A hard-link publication is atomic and refuses an existing destination; no overwrite window.
      await link(temp, target)
      return { ...preview(kit, hash(bytes)), path: target }
    } finally { await rm(temp, { force: true }) }
  }

  async projectKitPreview(path: string) { const bytes = await readBounded(path); return preview(parseKit(bytes), hash(bytes)) }

  async projectKitImport(path: string, destination: string, expectedSha256: string, sourceProjectKey: string) {
    const bytes = await readBounded(path), kit = parseKit(bytes)
    if (hash(bytes) !== expectedSha256 || kit.sourceProjectKey !== sourceProjectKey) throw new Error('Project kit changed or source identity was not confirmed')
    if (!isAbsolute(destination) || validateProjectName(basename(destination))) throw new Error('Choose a new absolute project directory')
    const parent = await realpath(dirname(destination)), target = join(parent, basename(destination))
    if (this.store.listRepos().some(repo => repo.path === target)) throw new Error('Restore destination is already registered')
    const git = await runProcess({ program: 'git', args: ['rev-parse', '--show-toplevel'], cwd: parent, env: sanitizedProcessEnv(), timeoutMs: 5000, maxOutputBytes: 4096 }).catch(error => { if (error instanceof ProcessExecutionError && error.kind === 'exit' && /not a git repository|not a git directory/i.test(error.result?.stderr ?? '')) return null; throw error })
    if (git) throw new Error('Choose a restore location outside an existing Git checkout')
    await mkdir(target, { mode: 0o700 }) // Exclusive: existing files, folders and symlinks are never merged.
    const scope = await resolveProjectToolScope(target, async () => ({ path: target, projectPath: target }))
    const report: ProjectKitReport = { ...preview(kit, hash(bytes)), projectPath: target, projectKey: scope.projectKey, restoredAt: new Date().toISOString() }
    const marker = join(target, '.donwells-restore-incomplete')
    const write = (path: string, value: unknown) => { const fd = openSync(path, 'wx', 0o600); try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd) } finally { closeSync(fd) } }
    write(marker, { archiveId: kit.archiveId, sourceProjectKey, projectKey: scope.projectKey })
    const memory = new ProjectMemoryStore(this.profile), handoffStore = new ProjectHandoffStore(this.profile)
    let importedMemory: ProjectMemoryProjectDocument | undefined, importedHandoffs: ProjectHandoff[] | undefined
    try {
      for (const artifact of kit.payload.artifacts) {
        const output = join(target, artifact.path)
        await mkdir(dirname(output), { recursive: true, mode: 0o700 })
        await this.files.createWorkspaceEntry(target, { path: artifact.path, kind: 'file', content: safeText(artifact.content) })
      }
      const configuration = join(this.profile, 'project-tools', 'configuration', scope.projectKey)
      await mkdir(configuration, { recursive: true, mode: 0o700 })
      write(join(configuration, 'tools.json'), { referenceRoots: [], disabled: INTEGRATED_PROJECT_TOOLS.map(tool => tool.id) })
      const reports = join(this.profile, 'project-kits'); await mkdir(reports, { recursive: true, mode: 0o700 })
      write(join(reports, scope.projectKey + '.json'), report)
      const mapped = { projectKey: scope.projectKey, projectPath: target, entries: kit.payload.memory.entries.map(entry => ({ current: { ...portableRevision(entry.current), id: randomUUID(), provenance: { ...portableRevision(entry.current).provenance, workspace: target } }, history: entry.history.map(value => ({ ...portableRevision(value), provenance: { ...portableRevision(value).provenance, workspace: target } })) })) }
      memory.importProject(mapped); importedMemory = mapped
      const mappedHandoffs = kit.payload.handoffs.map(value => parseProjectHandoff({ ...value, id: randomUUID(), projectKey: scope.projectKey, checkoutPath: target, contentFingerprint: 'sha256:' + '0'.repeat(64), goal: safeText(value.goal), summary: safeText(value.summary), openQuestions: value.openQuestions.map(safeText), nextSteps: value.nextSteps.map(safeText), evidenceIds: [], fromSessionId: 'historical', state: 'superseded', delivery: 'not-sent', acceptedBySessionId: null }))
      handoffStore.importProject(scope.projectKey, mappedHandoffs); importedHandoffs = mappedHandoffs
      const repo: Repo = { id: idFromPath(target), path: target, kind: 'folder', addedAt: report.restoredAt }
      const panes = kit.payload.layout.panes
      const workspace: SavedWorkspace = { panes: { [target]: panes }, activePane: { [target]: panes[0]?.key ?? '' }, activeTerminal: {}, terminalOrder: {}, layouts: {}, docking: { [target]: kit.payload.layout.docking }, activeWorktreePath: target }
      unlinkSync(marker)
      this.onImported()
      this.store.addImportedRepo(repo, workspace)
      return { repo, report }
    } catch (error) {
      if (importedHandoffs) handoffStore.removeImportedProject(scope.projectKey, importedHandoffs)
      if (importedMemory) memory.removeImportedProject(importedMemory)
      try { write(marker, { archiveId: kit.archiveId, sourceProjectKey, projectKey: scope.projectKey }) } catch { /* Original marker still present. */ }
      throw new Error('Restore did not finish. The new directory and incomplete marker were preserved; existing projects were not changed.', { cause: error })
    }
  }

  async projectKitReport(workspacePath: string): Promise<ProjectKitReport | null> {
    const scope = await resolveProjectToolScope(workspacePath, this.resolveWorkspace), path = join(this.profile, 'project-kits', scope.projectKey + '.json')
    if (!await lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })) return null
    return JSON.parse((await readBounded(path)).toString('utf8')) as ProjectKitReport
  }
}
