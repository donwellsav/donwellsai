import { randomUUID, createHash } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { redactDesignCaptureSecrets } from '@shared/design-capture'
import { projectEnvironmentId, type EnvironmentResultReview } from '@shared/project-environment'
import type { GitWorktrees } from './git'
import type { ProjectEnvironments } from './project-environments'
import { artifactPath } from './project-export'
import { ensureEnvironmentArtifactParents } from './environment-artifact-files'

const revision = (text: string) => 'sha256:' + createHash('sha256').update(text).digest('hex')
const text = (value: unknown): string => {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 512 * 1024 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || redactDesignCaptureSecrets(value) !== value) throw new Error('Select bounded non-secret text files for environment transfer')
  return value
}
export class ProjectEnvironmentResults {
  private readonly path: string
  private readonly active = new Set<string>()
  constructor(userDataDir: string, private readonly environments: ProjectEnvironments, private readonly files: Pick<GitWorktrees, 'readFile' | 'writeFile' | 'createWorkspaceEntry' | 'deleteWorkspaceEntry' | 'handoffSource'>) {
    mkdirSync(userDataDir, { recursive: true, mode: 0o700 }); this.path = join(userDataDir, 'environment-results.sqlite')
    try { closeSync(openSync(this.path, 'wx', 0o600)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const file = lstatSync(this.path)
    if (!file.isFile() || file.isSymbolicLink() || file.mode & 0o077 || process.getuid && file.uid !== process.getuid()) throw new Error('Environment results store must be private and owned')
    this.db(db => db.exec('CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, record TEXT NOT NULL)'))
  }
  private db<T>(fn: (db: DatabaseSync) => T): T { const db = new DatabaseSync(this.path); try { db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE'); const result = fn(db); db.exec('COMMIT'); return result } finally { db.close() } }
  private save(review: EnvironmentResultReview): void { this.db(db => db.prepare('INSERT INTO reviews VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(review.id, JSON.stringify(review))) }
  async get(workspacePath: string, id: string): Promise<EnvironmentResultReview> {
    const row = this.db(db => db.prepare('SELECT record FROM reviews WHERE id=?').get(projectEnvironmentId(id)))
    if (!row) throw new Error('Environment review was not found')
    const review = JSON.parse(String(row.record)) as EnvironmentResultReview
    const environment = await this.environments.get(workspacePath, review.environmentId, review.generation)
    if (review.workspacePath !== environment.checkoutPath) throw new Error('Environment review belongs to another checkout')
    return review
  }
  async list(workspacePath: string, environmentId: string, generation: number): Promise<EnvironmentResultReview[]> {
    const environment = await this.environments.get(workspacePath, environmentId, generation)
    return this.db(db => db.prepare('SELECT record FROM reviews').all().map(row => JSON.parse(String(row.record)) as EnvironmentResultReview).filter(review => review.environmentId === environmentId && review.generation === generation && review.workspacePath === environment.checkoutPath))
  }
  async capture(workspacePath: string, environmentId: string, generation: number, selected: string[]): Promise<EnvironmentResultReview> {
    const environment = await this.environments.get(workspacePath, environmentId, generation)
    if (!Array.isArray(selected) || !selected.length || selected.length > 100) throw new Error('Select 1–100 text files')
    const paths = selected.map(artifactPath)
    if (new Set(paths.map(path => path.normalize('NFC').toLowerCase())).size !== paths.length) throw new Error('Duplicate result paths')
    const review: EnvironmentResultReview = { id: randomUUID(), environmentId, generation, workspacePath: environment.checkoutPath, baseGitRevision: (await this.files.handoffSource(workspacePath)).sourceRevision, files: [] }
    let bytes = 0
    for (const path of paths) {
      const stat = await lstat(join(environment.checkoutPath, path)).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
      if (!stat) { review.files.push({ path, baseRevision: null, baseContent: null, state: 'pending' }); continue }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.mode & 0o111) throw new Error('Transfer requires a non-executable regular file: ' + path)
      const file = await this.files.readFile(workspacePath, path)
      if (file.binary || file.truncated || !file.revision) throw new Error('File is not a complete text snapshot: ' + path)
      const content = text(file.content); bytes += Buffer.byteLength(content)
      if (bytes > 8 * 1024 * 1024) throw new Error('Selected source snapshot exceeds 8 MiB')
      review.files.push({ path, baseRevision: file.revision, baseContent: content, state: 'pending' })
    }
    if (this.db(db => Number(db.prepare('SELECT COUNT(*) AS count FROM reviews').get()!.count)) >= 20) throw new Error('Environment review retention limit reached')
    this.save(review); return review
  }
  private async exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.active.has(id)) throw new Error('This environment review already has an operation in progress')
    this.active.add(id); try { return await operation() } finally { this.active.delete(id) }
  }
  send(workspacePath: string, id: string): Promise<EnvironmentResultReview> { return this.exclusive(id, () => this.sendNow(workspacePath, id)) }
  stage(workspacePath: string, id: string): Promise<EnvironmentResultReview> { return this.exclusive(id, () => this.stageNow(workspacePath, id)) }
  apply(workspacePath: string, id: string, selected: string[]): Promise<EnvironmentResultReview> { return this.exclusive(id, () => this.applyNow(workspacePath, id, selected)) }
  private async sendNow(workspacePath: string, id: string): Promise<EnvironmentResultReview> {
    const review = await this.get(workspacePath, id)
    for (const [index, file] of review.files.entries()) {
      if (file.baseContent === null) continue
      const result = await this.environments.request(workspacePath, review.environmentId, review.generation, 'source.put', { path: file.path, content: file.baseContent, revision: file.baseRevision }, review.id + '-source-' + index) as { state: string; error?: string }
      if (result.state !== 'completed') throw new Error(result.error ?? 'Source transfer outcome is uncertain; inspect its existing operation')
    }
    return review
  }
  private async stageNow(workspacePath: string, id: string): Promise<EnvironmentResultReview> {
    const review = await this.get(workspacePath, id)
    for (const file of review.files) {
      if (file.state === 'applied') continue
      const remote = await this.environments.request(workspacePath, review.environmentId, review.generation, 'result.read', { path: file.path }, randomUUID()) as { exists: boolean; content?: string; revision?: string }
      if (remote.exists === false) file.received = null
      else {
        const content = text(remote.content)
        if (remote.revision !== revision(content)) throw new Error('Returned bytes do not match their revision')
        file.received = { content, revision: remote.revision }
      }
      if (review.files.reduce((total, item) => total + Buffer.byteLength(item.baseContent ?? '') + Buffer.byteLength(item.received?.content ?? ''), 0) > 16 * 1024 * 1024) throw new Error('Staged source and results exceed 16 MiB')
      const local = await lstat(join(review.workspacePath, file.path)).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
      if (local) { const current = await this.files.readFile(workspacePath, file.path); file.currentContent = current.content; file.currentRevision = current.revision ?? null }
      else { file.currentContent = null; file.currentRevision = null }
      file.state = file.currentRevision === file.baseRevision ? 'staged' : 'conflict'
      if (file.state === 'conflict') file.error = 'Local content changed since source capture. It will not be overwritten.'; else delete file.error
      this.save(review)
    }
    return review
  }
  private async applyNow(workspacePath: string, id: string, selected: string[]): Promise<EnvironmentResultReview> {
    const review = await this.get(workspacePath, id)
    if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length) throw new Error('Select reviewed results to apply')
    for (const path of selected) {
      const file = review.files.find(file => file.path === path)
      if (!file || file.received === undefined) throw new Error('Result has not been staged for review')
      if (file.state === 'applied') continue
      try {
        const exists = await lstat(join(review.workspacePath, path)).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
        const current = exists ? await this.files.readFile(workspacePath, path) : null
        if (file.received === null && !current || file.received && current?.revision === file.received.revision) { file.state = 'applied'; delete file.error; this.save(review); continue }
        if ((current?.revision ?? null) !== file.baseRevision) throw new Error('Local content changed since source capture; review it before applying')
        if (file.received === null) {
          if (file.baseRevision) await this.files.deleteWorkspaceEntry(workspacePath, { path, expectedRevision: file.baseRevision })
        } else if (file.baseRevision === null) {
          await ensureEnvironmentArtifactParents(this.files, review.workspacePath, path)
          await this.files.createWorkspaceEntry(workspacePath, { path, kind: 'file', content: file.received.content })
        } else await this.files.writeFile(workspacePath, path, file.received.content, file.baseRevision)
        file.state = 'applied'; delete file.error
      } catch (error) { file.state = 'conflict'; file.error = String(error).slice(0, 1024) }
      this.save(review)
    }
    return review
  }
}
