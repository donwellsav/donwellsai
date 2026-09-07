import { createHash } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { ProcessSpec } from '@shared/child-process/process-spec'
import type { ProjectToolScope } from '@shared/project-tools'

import { DatabaseSync } from 'node:sqlite'
import { runProcess } from '@shared/child-process/run-process'
import { sanitizedProcessEnv } from '@shared/child-process/process-environment'
import { projectEnvironmentId, type LumeEnvironment, type LumeEnvironmentConfig } from '@shared/project-environment'
export type { LumeEnvironmentConfig } from '@shared/project-environment'
export type LumeAdmission = { executable: string; executableSha256: string; clipboardDisabledQualified: boolean; vncDisabledQualified: boolean }
const inside = (root: string, path: string) => { const value = relative(root, path); return value === '' || value !== '..' && !value.startsWith('..' + sep) && !isAbsolute(value) }
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')

/** Prepare only an already admitted disposable guest. Image download/adoption and VM lifetime are separate operations. */
export function prepareLumeEnvironment(admission: LumeAdmission, config: LumeEnvironmentConfig, scope: ProjectToolScope, returnDirectory: string): ProcessSpec {
  if (!admission.clipboardDisabledQualified || !admission.vncDisabledQualified) throw new Error('Lume requires qualified clipboard-disable and no-VNC behavior before launch')
  if (!isAbsolute(admission.executable) || digest(readFileSync(admission.executable)) !== admission.executableSha256) throw new Error('Lume executable does not match its admission')
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(config.name) || !isAbsolute(config.storageDirectory)) throw new Error('Invalid Lume storage identity')
  const storage = realpathSync(config.storageDirectory), vmDirectory = join(storage, config.name)
  if (lstatSync(vmDirectory).isSymbolicLink() || realpathSync(vmDirectory) !== vmDirectory) throw new Error('Lume VM storage identity changed')
  for (const name of ['config.json', 'disk.img', 'nvram.bin']) {
    const file = lstatSync(join(vmDirectory, name))
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw new Error('Lume guest files must not alias another VM')
  }
  const guest = JSON.parse(readFileSync(join(vmDirectory, 'config.json'), 'utf8')) as Record<string, unknown>
  if (typeof guest.machineIdentifier !== 'string' || digest(guest.machineIdentifier) !== config.machineIdentifierSha256) throw new Error('Lume machine identity does not match the selected guest')
  if (guest.cpuCount !== 4 || guest.memorySize !== 8 * 1024 ** 3 || guest.os !== 'macOS') throw new Error('This Lume admission requires the selected 4 CPU / 8 GiB macOS guest')
  const args = ['run', config.name, '--storage', storage, '--display', 'native', '--vnc', 'disabled', '--no-clipboard', '--network', 'nat']
  if (config.mounts.length > 8) throw new Error('Too many selected Lume mounts')
  const resultRoot = realpathSync(returnDirectory), checkout = realpathSync(scope.checkoutPath)
  for (const mount of config.mounts) {
    if (!isAbsolute(mount.path) || /[:\0\r\n]/.test(mount.path)) throw new Error('Lume mount path cannot contain colon or control characters')
    const path = realpathSync(mount.path)
    if (path !== mount.path || !lstatSync(path).isDirectory() || inside(path, homedir())) throw new Error('Lume mount must be a selected canonical directory')
    if (mount.purpose === 'source' ? mount.mode !== 'ro' || !inside(checkout, path) : mount.purpose !== 'results' || mount.mode !== 'rw' || !inside(resultRoot, path)) throw new Error('Lume mount exceeds its reviewed source or result scope')
    args.push('--shared-dir', path + ':' + mount.mode)
  }
  return { program: admission.executable, args, cwd: storage, executionHost: { kind: 'local' }, detached: true, timeoutMs: null }
}

/** Prepared guests only: private profile storage excludes all retained research/user VMs. */
export class ProjectLume {
  readonly storageDirectory: string
  readonly returnDirectory: string
  readonly admissionPath: string
  private readonly database: string
  private readonly launching = new Map<string, { completion: Promise<void>; controller: AbortController }>()
  private readonly changing = new Set<string>()
  constructor(userData: string, private readonly scope: (path: string) => Promise<ProjectToolScope>, private readonly execute: typeof runProcess = runProcess) {
    const directory = join(userData, 'project-environments')
    this.storageDirectory = join(directory, 'lume-vms'); this.returnDirectory = join(directory, 'lume-results'); this.admissionPath = join(directory, 'lume-admission.json')
    for (const path of [directory, this.storageDirectory, this.returnDirectory]) { mkdirSync(path, { recursive: true, mode: 0o700 }); const file = lstatSync(path); if (!file.isDirectory() || file.isSymbolicLink() || file.mode & 0o077 || process.getuid && file.uid !== process.getuid()) throw new Error('Lume profile directories must be private and owned') }
    this.database = join(directory, 'lume.sqlite')
    try { closeSync(openSync(this.database, 'wx', 0o600)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const file = lstatSync(this.database); if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.mode & 0o077 || process.getuid && file.uid !== process.getuid()) throw new Error('Lume registry is not private and owned')
    this.db(db => db.exec('CREATE TABLE IF NOT EXISTS guests (id TEXT PRIMARY KEY, record TEXT NOT NULL, disks TEXT NOT NULL)'))
  }
  private db<T>(fn: (db: DatabaseSync) => T): T { const db = new DatabaseSync(this.database); try { db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE'); const value = fn(db); db.exec('COMMIT'); return value } finally { db.close() } }
  private admission(): LumeAdmission {
    const file = lstatSync(this.admissionPath)
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.mode & 0o077 || file.size > 16384 || process.getuid && file.uid !== process.getuid()) throw new Error('Lume admission must be a private, qualified build receipt')
    return JSON.parse(readFileSync(this.admissionPath, 'utf8'))
  }
  private disks(config: LumeEnvironmentConfig): string { return JSON.stringify(['disk.img', 'nvram.bin'].map(name => { const file = lstatSync(join(config.storageDirectory, config.name, name)); return { name, dev: file.dev, ino: file.ino } })) }
  private save(record: LumeEnvironment): LumeEnvironment { this.db(db => db.prepare('UPDATE guests SET record=? WHERE id=?').run(JSON.stringify(record), record.id)); return record }
  private async record(path: string, id: string): Promise<LumeEnvironment> {
    const scope = await this.scope(path), row = this.db(db => db.prepare('SELECT record,disks FROM guests WHERE id=?').get(projectEnvironmentId(id)))
    if (!row) throw new Error('Prepared Lume guest is not registered')
    const record = JSON.parse(String(row.record)) as LumeEnvironment
    if (record.projectKey !== scope.projectKey || record.checkoutPath !== scope.checkoutPath) throw new Error('Lume guest belongs to another project')
    if (record.config.storageDirectory !== realpathSync(this.storageDirectory) || this.disks(record.config) !== row.disks) throw new Error('Prepared Lume disk identity changed')
    prepareLumeEnvironment(this.admission(), { ...record.config, mounts: [] }, scope, this.returnDirectory)
    return record
  }
  async list(path: string) {
    const scope = await this.scope(path)
    const guests = this.db(db => db.prepare('SELECT record FROM guests').all().map(row => JSON.parse(String(row.record)) as LumeEnvironment).filter(record => record.projectKey === scope.projectKey && record.checkoutPath === scope.checkoutPath))
    return { storageDirectory: this.storageDirectory, returnDirectory: this.returnDirectory, admissionPath: this.admissionPath, guests }
  }
  async register(path: string, id: string, config: LumeEnvironmentConfig): Promise<LumeEnvironment> {
    projectEnvironmentId(id); const scope = await this.scope(path)
    if (config.storageDirectory !== realpathSync(this.storageDirectory)) throw new Error('Only a newly prepared guest in this profile’s private storage can be registered; retained VMs are excluded')
    prepareLumeEnvironment(this.admission(), config, scope, this.returnDirectory)
    if (!config.mounts.some(mount => mount.purpose === 'source') || !config.mounts.some(mount => mount.purpose === 'results')) throw new Error('Select one source and one return mount')
    const record: LumeEnvironment = { id, projectKey: scope.projectKey, checkoutPath: scope.checkoutPath, config, state: 'stopped' }
    this.db(db => { const prior = db.prepare('SELECT id FROM guests').all(); if (prior.length >= 8) throw new Error('Lume prepared guest limit reached'); const used = db.prepare('SELECT record FROM guests').all().some(row => (JSON.parse(String(row.record)) as LumeEnvironment).config.name === config.name); if (used) throw new Error('This machine is already registered'); db.prepare('INSERT INTO guests VALUES (?,?,?)').run(id, JSON.stringify(record), this.disks(config)) })
    return record
  }
  private async probe(record: LumeEnvironment): Promise<LumeEnvironment> {
    const result = await this.execute({ program: this.admission().executable, args: ['get', record.config.name, '--storage', record.config.storageDirectory, '--format', 'json'], env: sanitizedProcessEnv(process.env), timeoutMs: 5000, maxOutputBytes: 65536 })
    const parsed = JSON.parse(result.stdout), value = Array.isArray(parsed) ? parsed[0] : parsed
    if (value?.name !== record.config.name || value.cpuCount !== 4 || value.memorySize !== 8 * 1024 ** 3 || value.os !== 'macOS' || value.vncUrl) throw new Error('Lume runtime identity or no-VNC policy does not match')
    if (value.status === 'stopped') return { ...record, state: this.launching.has(record.id) ? 'starting' : 'stopped', pid: undefined, startedAt: undefined, ipAddress: undefined, detail: undefined }
    if (value.status !== 'running') throw new Error('Lume is not in an admitted runtime state: ' + value.status)
    const markerPath = join(record.config.storageDirectory, record.config.name, 'sessions.json'), stat = lstatSync(markerPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536) throw new Error('Lume session marker changed')
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
    if (marker.vncEnabled !== false || marker.url || !Number.isSafeInteger(marker.pid) || marker.pid < 1 || !Number.isFinite(marker.startedAt)) throw new Error('Lume owner marker is unverifiable')
    if (!this.launching.has(record.id) && (record.pid !== marker.pid || record.startedAt !== marker.startedAt)) throw new Error('Running Lume process does not match the recorded owner; it will not be adopted or stopped')
    return { ...record, state: 'running', pid: marker.pid, startedAt: marker.startedAt, ipAddress: typeof value.ipAddress === 'string' ? value.ipAddress : undefined, detail: undefined }
  }
  async action(path: string, id: string, action: 'start' | 'stop' | 'status'): Promise<LumeEnvironment> {
    if (this.changing.has(id)) throw new Error('Lume operation already in progress')
    this.changing.add(id)
    let record: LumeEnvironment | undefined
    try {
      record = await this.record(path, id)
      const observed = await this.probe(record)
      if (action === 'status') return this.save(observed)
      if (action === 'start') {
        if (observed.state !== 'stopped') throw new Error('Guest is already running or starting; reconnect to it')
        if (this.launching.size || this.db(db => db.prepare('SELECT record FROM guests WHERE id<>?').all(id).some(row => (JSON.parse(String(row.record)) as LumeEnvironment).state !== 'stopped'))) throw new Error('Stop or reconcile other prepared guests before starting another VM')
        const scope = await this.scope(path), spec = prepareLumeEnvironment(this.admission(), record.config, scope, this.returnDirectory)
        record = this.save({ ...record, state: 'starting', detail: undefined })
        const controller = new AbortController()
        const completion = this.execute({ ...spec, signal: controller.signal, env: sanitizedProcessEnv(process.env), maxOutputBytes: 1024 * 1024 }).then(() => { this.save({ ...record!, state: 'stopped', pid: undefined, startedAt: undefined }) }, error => { this.save({ ...record!, state: 'unverifiable', detail: String(error).slice(0, 1024) }) }).finally(() => this.launching.delete(id))
        this.launching.set(id, { completion, controller })
        return record
      }
      if (action !== 'stop') throw new Error('Unknown Lume action')
      if (observed.state === 'stopped') return this.save(observed)
      if (observed.state === 'starting' && this.launching.has(id)) { const launch = this.launching.get(id)!; launch.controller.abort(); await launch.completion; const stopped = await this.probe(record); if (stopped.state !== 'stopped') throw new Error('Cancelled Lume launch still owns a runtime'); return this.save(stopped) }
      if (observed.state !== 'running') throw new Error('Wait for verified VM ownership before stopping')
      this.save({ ...observed, state: 'stopping' })
      await this.execute({ program: this.admission().executable, args: ['stop', record.config.name, '--storage', record.config.storageDirectory], env: sanitizedProcessEnv(process.env), timeoutMs: 30000, maxOutputBytes: 65536 })
      const launch = this.launching.get(id)?.completion
      if (launch) { let timer: ReturnType<typeof setTimeout> | undefined; try { await Promise.race([launch, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Lume launcher exit is unverifiable')), 5000) })]) } finally { clearTimeout(timer) } }
      const stopped = await this.probe(observed)
      if (stopped.state !== 'stopped') throw new Error('Lume stop did not release its owner')
      return this.save(stopped)
    } catch (error) { if (record) this.save({ ...record, state: 'unverifiable', detail: String(error).slice(0, 1024) }); throw error }
    finally { this.changing.delete(id) }
  }
}
