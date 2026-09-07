import type { ProjectTaskCoordination } from './project-task-coordination'
import { parseAgentTaskIntent } from '@shared/agent-runtime'
import type { ProjectSessionHistory } from './project-session-history'
import type { ProjectHandoffService } from './project-handoff'
import type { AgentSessionCredential } from '@shared/agent-runtime'
import { parseAgentExecutable } from '@shared/agent-runtime'
import type { ProjectTools } from './project-tools'
import { parseProjectMemoryListRequest, parseProjectMemoryGetRequest, parseProjectMemoryCreateRequest, parseProjectMemoryUpdateRequest, parseProjectMemoryHistoryRequest, parseProjectMemoryArchiveRequest, type ProjectMemoryApi } from '@shared/project-memory'
import { createServer, type Server, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  AppSettings,
  BrowserCommand,
  RunsSection,
  SettingsResetRequest,
  SettingsSection,
  UiCommand
} from '@shared/types'
import type { AgentDeliveryReceipt, AgentDeliveryRequest } from '@shared/agent-delivery'
import type { AgentRuntime } from './agent-runtime'
import type { BrowserHistoryStore } from './browser-history'
import type { DiffReviewApi } from '@shared/diff-review'
import {
  parseDiffReviewCreateRequest,
  parseDiffReviewDeleteRequest,
  parseDiffReviewListRequest,
  parseDiffReviewUpdateRequest
} from '@shared/diff-review'
import {
  parseParallelRunInput,
  parseScheduledRunInput,
  type OperationalRunsApi
} from '@shared/operational-runs'
import type { SkillPackageProviderId, SkillPackageSource } from '@shared/skill-packages'
import type { Store } from './store'
import type { GitWorktrees } from './git'
import type { DaemonClient } from './daemon-client'
import type { SkillPackagesManager } from './skills'
import { isObject, validateCommandParams } from '@shared/command-catalog'
import { probeLocalProcessLiveness } from '@shared/child-process/execution-host'
import { readRuntimeIdentity } from './local-runtime'

// Authenticated NDJSON; the CLI and UI share domain operations and argument validation.
const MAX_FRAME_BYTES = 8 * 1024 * 1024

const MAX_RPC_ERROR_LENGTH = 64 * 1024

class RpcFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RpcFailure'
  }
}

function failureMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_RPC_ERROR_LENGTH)
}

function failureCode(error: unknown): string {
  if (error instanceof RpcFailure) return error.code
  if (isObject(error) && typeof error.code === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(error.code)) {
    return error.code
  }
  return 'COMMAND_FAILED'
}

function parseRpcInput<T>(parse: (input: unknown) => T, input: unknown): T {
  try {
    return parse(input)
  } catch (error) {
    throw new RpcFailure('INVALID_ARGUMENTS', failureMessage(error))
  }
}

export type RpcDeps = {
  store: Store
  git: GitWorktrees
  terminals: DaemonClient
  agents: Pick<AgentRuntime, 'listAgents' | 'start' | 'list' | 'interrupt' | 'stop' | 'dismiss'> & Partial<Pick<AgentRuntime, 'switchMode' | 'modeSwitchResult' | 'startAcp' | 'listAcp' | 'observeAcp' | 'promptAcp' | 'controlAcp'>>
  deliverAgentAttachment: (request: AgentDeliveryRequest) => Promise<AgentDeliveryReceipt>
  skills: Pick<SkillPackagesManager, 'list' | 'prepare' | 'apply' | 'read' | 'prepareUpdate' | 'prepareRemove' | 'remove'>
  projectKit?: import('@shared/project-export').ProjectKitApi
  projectTasks: Pick<ProjectTaskCoordination, 'inspect' | 'setAuthority' | 'openTool'>
  runs: OperationalRunsApi
  browserHistory: Pick<BrowserHistoryStore, 'list' | 'record' | 'clear'>
  sessionHistory?: Pick<ProjectSessionHistory, 'index' | 'search' | 'get' | 'analytics' | 'cancelAnalytics' | 'analyticsProgress'>
  projectTools: Pick<ProjectTools, 'list' | 'start' | 'stop' | 'call'> & Partial<Pick<import('./project-doctor').ProjectDoctor, 'temporalKnowledgeStatus' | 'temporalKnowledgeReconcile' | 'temporalKnowledgeQuery' | 'temporalKnowledgeStop' | 'knowledgeStatus' | 'knowledgeReconcile' | 'knowledgeRecall' | 'knowledgeReflect' | 'knowledgeStop'>>
  handoffs: Pick<ProjectHandoffService, 'receive' | 'acknowledge'>
  projectMemory: ProjectMemoryApi
  diffReview: {
    list: DiffReviewApi['diffReviewList']
    create: DiffReviewApi['diffReviewCreate']
    update: DiffReviewApi['diffReviewUpdate']
    remove: DiffReviewApi['diffReviewDelete']
  }
  meta: () => Promise<{ version: string; shell: string; userDataDir: string }>
  /** Notify the renderer (worktree:changed) after RPC mutations it can't see. */
  onChanged: (repoId: string) => void
  /** Notify the renderer (settings:changed) so RPC-driven settings apply live. */
  onSettingsChanged: (settings: AppSettings) => void
  /** Forward browser control commands to the renderer's webviews. */
  browser: { command: (cmd: BrowserCommand) => Promise<unknown> }
  /** Forward UI/panel control commands to the renderer's store. */
  ui: { command: (cmd: UiCommand) => Promise<unknown> }
}

export class RuntimeRpcServer {
  private server: Server | null = null
  private clients = new Set<Socket>()
  /** inode of the socket path we bound — ownership check for stop(). */
  private boundIno: number | null = null

  constructor(
    private socketPath: string,
    private runtimeFile: string,
    private authToken: string,
    private deps: RpcDeps
  ) {}

  async start(): Promise<void> {
    if (this.server) throw new Error('Runtime RPC is already started')
    const priorExists = existsSync(this.runtimeFile)
    const prior = readRuntimeIdentity(this.runtimeFile)
    const socketExists = process.platform !== 'win32' && existsSync(this.socketPath)
    if (priorExists && (!prior?.pid || probeLocalProcessLiveness(prior.pid) !== 'exited')) {
      throw new Error('Runtime owner is live or unverifiable; refusing to replace it')
    }
    if (socketExists && (!prior || prior.socketPath !== this.socketPath)) {
      throw new Error('Runtime endpoint has no verifiable owner; refusing to unlink it')
    }
    if (socketExists) rmSync(this.socketPath)
    if (priorExists) rmSync(this.runtimeFile)
    mkdirSync(dirname(this.runtimeFile), { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') {
      const directory = dirname(this.socketPath)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const stat = lstatSync(directory)
      if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) {
        throw new Error('Runtime socket directory is not owned by this user')
      }
      chmodSync(directory, 0o700)
    }
    const ready = Promise.withResolvers<void>()
    const server = createServer((socket) => this.handleClient(socket))
    this.server = server
    server.on('error', ready.reject)
    server.listen(this.socketPath, () => ready.resolve())
    try {
      await ready.promise
      if (process.platform !== 'win32') {
        this.boundIno = statSync(this.socketPath).ino
        chmodSync(this.socketPath, 0o600)
      }
      const temporary = this.runtimeFile + '.' + randomUUID() + '.tmp'
      writeFileSync(temporary, JSON.stringify({
        socketPath: this.socketPath, authToken: this.authToken, pid: process.pid
      }), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      try { renameSync(temporary, this.runtimeFile) } finally { rmSync(temporary, { force: true }) }
    } catch (error) {
      this.stop()
      throw error
    }
  }

  stop(): void {
    for (const client of this.clients) client.destroy()
    this.clients.clear()
    let ownsEndpoint = process.platform === 'win32'
    if (process.platform !== 'win32') {
      try { ownsEndpoint = this.boundIno !== null && statSync(this.socketPath).ino === this.boundIno } catch {}
    }
    // Closing a Unix server unlinks its path; never unlink a successor's endpoint.
    if (ownsEndpoint) this.server?.close()
    this.server = null
    this.boundIno = null
    const runtime = readRuntimeIdentity(this.runtimeFile)
    if (runtime?.pid === process.pid && runtime.authToken === this.authToken) rmSync(this.runtimeFile)
  }

  private handleClient(socket: Socket): void {
    let authed = false
    let buf = ''
    this.clients.add(socket)
    socket.setEncoding('utf8')

    socket.on('data', (chunk) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        if (Buffer.byteLength(line) > MAX_FRAME_BYTES) { socket.destroy(); return }
        let msg: Record<string, unknown>
        try {
          const parsed: unknown = JSON.parse(line)
          if (!isObject(parsed)) { socket.destroy(); return }
          msg = parsed
        } catch {
          socket.destroy()
          return
        }
        if (!authed) {
          if (msg['method'] === 'auth.hello'
            && msg['authToken'] === this.authToken
            && typeof msg['id'] === 'string'
            && msg['id'].length > 0
            && msg['id'].length <= 256) {
            authed = true
            this.reply(socket, msg['id'], true, { version: 'rpc-v1' })
          } else {
            socket.destroy()
          }
          continue
        }
        void this.dispatch(socket, msg)
      }
      if (Buffer.byteLength(buf) > MAX_FRAME_BYTES) socket.destroy()
    })

    socket.on('close', () => this.clients.delete(socket))
    socket.on('error', () => socket.destroy())
  }

  private reply(socket: Socket, id: string, ok: boolean, result: Record<string, unknown>): void {
    if (socket.destroyed) return
    let frame: string
    try {
      frame = JSON.stringify({ id, ok, ...result })
    } catch {
      frame = JSON.stringify({ id, ok: false, code: 'RESPONSE_SERIALIZATION_FAILED', error: 'Runtime result is not JSON serializable' })
    }
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
      frame = JSON.stringify({ id, ok: false, code: 'RESPONSE_TOO_LARGE', error: 'Runtime result exceeds the 8 MiB response limit' })
    }
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) { socket.destroy(); return }
    socket.write(frame + '\n')
  }

  private async dispatch(socket: Socket, msg: Record<string, unknown>): Promise<void> {
    const id = msg['id']
    if (typeof id !== 'string' || id.length === 0 || id.length > 256) { socket.destroy(); return }
    const method = msg['method']
    if (typeof method !== 'string' || method.length === 0 || method.length > 256) {
      this.reply(socket, id, false, { code: 'INVALID_ARGUMENTS', error: 'Invalid command method' })
      return
    }
    let params: Record<string, unknown>
    try {
      params = validateCommandParams(method, Object.hasOwn(msg, 'params') ? msg['params'] : {})
    } catch (error) {
      this.reply(socket, id, false, { code: 'INVALID_ARGUMENTS', error: failureMessage(error) })
      return
    }
    const str = (key: string): string => params[key] as string
    try {
      const result = await this.route(method, params, str)
      this.reply(socket, id, true, { result })
    } catch (error) {
      this.reply(socket, id, false, { code: failureCode(error), error: failureMessage(error) })
    }
  }

  private async route(method: string, params: Record<string, unknown>, str: (k: string) => string): Promise<unknown> {
    const { store, git, terminals } = this.deps
    switch (method) {
      case 'status.get': {
        const repos = await git.listAll()
        return { version: (await this.deps.meta()).version, repos: repos.length, uptimeS: Math.round(process.uptime()) }
      }
      case 'meta.get':
        return this.deps.meta()
      case 'repo.list':
        return git.listAll()
      case 'repo.add': {
        const summary = await git.addRepo(str('dir'))
        this.deps.onChanged(summary.repo.id)
        return summary
      }
      case 'repo.remove':
        git.removeRepo(str('repoId'))
        this.deps.onChanged(str('repoId'))
        return {}
      case 'worktree.create': {
        const repo = store.listRepos().find((r) => r.id === str('repoId'))
        if (!repo) throw new Error(`unknown repo ${str('repoId')}`)
        const created = await git.createWorktree(repo.path, { name: params['name'] as string | undefined, branch: params['branch'] as string | undefined })
        this.deps.onChanged(repo.id)
        return created
      }
      case 'worktree.remove': {
        const repo = store.listRepos().find((r) => r.id === str('repoId'))
        if (!repo) throw new Error(`unknown repo ${str('repoId')}`)
        const removed = await git.removeWorktree(repo.path, str('worktreePath'), params['force'] === true)
        this.deps.onChanged(repo.id)
        return removed
      }
      case 'terminal.open':
        return { session: await terminals.open(str('cwd')) }
      case 'terminal.write':
        terminals.write(str('sessionId'), str('data'))
        return {}
      case 'terminal.resize':
        await terminals.resize(str('sessionId'), Number(params['cols'] ?? 100), Number(params['rows'] ?? 30))
        return {}
      case 'terminal.interrupt':
        terminals.interrupt(str('sessionId'))
        return {}
      case 'terminal.close':
        await terminals.close(str('sessionId'))
        return {}
      case 'terminal.list':
        return { sessions: await terminals.list() }
      case 'git.status':
        return git.status(str('worktreePath'))
      case 'file.list':
        return git.listWorkspaceDirectory(str('workspacePath'), {
          directory: params['directory'] as string | undefined ?? '',
          showHidden: params['showHidden'] === true,
          includeIgnored: params['includeIgnored'] === true
        })
      case 'file.search':
        return git.searchWorkspaceFiles(str('workspacePath'), {
          query: params['query'] as string | undefined ?? '',
          maxResults: params['maxResults'] as number | undefined,
          showHidden: params['showHidden'] === true,
          includeIgnored: params['includeIgnored'] === true
        })
      case 'file.searchContent':
        return git.searchWorkspaceContent(str('workspacePath'), {
          query: str('query'),
          ...(params['language'] === undefined ? {} : { language: str('language') }),
          maxResults: params['maxResults'] as number | undefined,
          showHidden: params['showHidden'] === true,
          includeIgnored: params['includeIgnored'] === true
        })
      case 'file.read':
        return git.readFile(str('workspacePath'), str('relPath'))
      case 'file.write':
        return git.writeFile(str('workspacePath'), str('relPath'), str('content'), str('expectedRevision'))
      case 'file.create':
        return git.createWorkspaceEntry(str('workspacePath'), {
          path: str('path'),
          kind: params['kind'] === 'dir' ? 'dir' : 'file',
          content: params['content'] as string | undefined
        })
      case 'file.move':
        return git.moveWorkspaceEntry(str('workspacePath'), {
          sourcePath: str('sourcePath'), destinationPath: str('destinationPath')
        })
      case 'file.duplicate':
        return git.duplicateWorkspaceEntry(str('workspacePath'), {
          sourcePath: str('sourcePath'), destinationPath: str('destinationPath')
        })
      case 'file.delete':
        return git.deleteWorkspaceEntry(str('workspacePath'), { path: str('path') })
      case 'git.stage':
        return git.stage(str('worktreePath'), params['paths'] as string[])
      case 'git.unstage':
        return git.unstage(str('worktreePath'), params['paths'] as string[])
      case 'git.discard':
        return git.discard(str('worktreePath'), params['paths'] as string[])
      case 'git.commit':
        return git.commit(str('worktreePath'), str('message'), { amend: params['amend'] === true })
      case 'git.fetch':
        return git.fetch(str('worktreePath'))
      case 'git.push':
        return git.push(str('worktreePath'))
      case 'git.pull':
        return git.pull(str('worktreePath'))
      case 'git.branches':
        return git.branches(str('worktreePath'))
      case 'git.checkout':
        return git.checkout(str('worktreePath'), str('branch'))
      case 'git.branch.create':
        return git.createBranch(str('worktreePath'), str('branch'), params['startPoint'] as string | undefined)
      case 'git.history':
        return git.history(str('worktreePath'), {
          cursor: params['cursor'] as string | undefined,
          limit: params['limit'] as number | undefined
        })
      case 'git.diff':
        return git.diff(str('worktreePath'), str('relPath'))
      case 'settings.get':
        return store.getSettings()
      case 'settings.set': {
        const settings = store.updateSettings(params)
        this.deps.onSettingsChanged(settings)
        return settings
      }
      case 'settings.reset': {
        const settings = store.resetSettings(params as SettingsResetRequest)
        this.deps.onSettingsChanged(settings)
        return settings
      }
      case 'ui.state':
        return this.deps.ui.command({ op: 'state' })
      case 'ui.activate':
        return this.deps.ui.command({
          op: 'activate',
          worktreePath: params['worktreePath'] as string | undefined,
          repoId: params['repoId'] as string | undefined
        })
      case 'ui.terminal.open':
        return this.deps.ui.command({ op: 'terminal.open', worktreePath: str('worktreePath') })
      case 'ui.split':
        return this.deps.ui.command({ op: 'split', worktreePath: str('worktreePath') })
      case 'ui.pane.focus':
        return this.deps.ui.command({ op: 'pane.focus', worktreePath: str('worktreePath'), key: str('key') })
      case 'ui.pane.close':
        return this.deps.ui.command({ op: 'pane.close', worktreePath: str('worktreePath'), key: str('key') })
      case 'ui.pane.resize':
        return this.deps.ui.command({
          op: 'pane.resize',
          worktreePath: str('worktreePath'),
          splitId: Number(params['splitId'] ?? 0),
          pct: Number(params['pct'] ?? 50)
        })
      case 'ui.preview.open':
        return this.deps.ui.command({ op: 'preview.open', worktreePath: str('worktreePath'), relPath: str('relPath') })
      case 'ui.preview.close':
        return this.deps.ui.command({
          op: 'preview.close',
          worktreePath: str('worktreePath'),
          relPath: params['relPath'] as string | undefined
        })
      case 'ui.sidebar':
        return this.deps.ui.command({
          op: 'sidebar',
          side: str('side') === 'right' ? 'right' : 'left',
          open: params['open'] as boolean | 'toggle' | undefined,
          tab: params['tab'] as 'explorer' | 'git' | 'memory' | undefined,
          width: params['width'] === undefined ? undefined : Number(params['width'])
        })
      case 'ui.palette':
        return this.deps.ui.command({
          op: 'palette',
          open: params['open'] as boolean | 'toggle' | undefined,
          mode: params['mode'] as 'commands' | 'files' | undefined
        })
      case 'ui.settings.open':
        return this.deps.ui.command({ op: 'settings.open', section: params['section'] as SettingsSection | undefined })
      case 'ui.runs.open': {
        const section = params['section']
        if (section !== undefined && section !== 'agents' && section !== 'automations' && section !== 'orchestration') {
          throw new Error('invalid runs section "' + String(section) + '"; expected agents, automations, or orchestration')
        }
        return this.deps.ui.command({ op: 'runs.open', section: section as RunsSection | undefined })
      }
      case 'ui.editor.open':
        return this.deps.ui.command({ op: 'editor.open', worktreePath: str('worktreePath'), relPath: str('relPath') })
      case 'ui.diff.open':
        return this.deps.ui.command({ op: 'diff.open', worktreePath: str('worktreePath'), relPath: str('relPath') })
      case 'ui.editor.write':
        return this.deps.ui.command({ op: 'editor.write', worktreePath: str('worktreePath'), relPath: str('relPath'), content: str('content') })
      case 'ui.editor.read':
        return this.deps.ui.command({ op: 'editor.read', worktreePath: str('worktreePath'), relPath: params['relPath'] as string | undefined })
      case 'ui.workspace.flush':
        return this.deps.ui.command({ op: 'workspace.flush' })
      case 'browser.list':
        return { panes: await this.deps.browser.command({ op: 'list' }) }
      case 'browser.open': {
        const snapshot = await this.deps.browser.command({ op: 'open', key: str('worktreePath'), url: str('url') })
        return { snapshot }
      }
      case 'browser.navigate':
        return this.deps.browser.command({ op: 'navigate', key: str('key'), url: str('url') })
      case 'browser.back':
        return this.deps.browser.command({ op: 'back', key: str('key') })
      case 'browser.forward':
        return this.deps.browser.command({ op: 'forward', key: str('key') })
      case 'browser.reload':
        return this.deps.browser.command({ op: 'reload', key: str('key') })
      case 'browser.snapshot':
        return { snapshot: await this.deps.browser.command({ op: 'snapshot', key: str('key') }) }
      case 'browser.eval':
        return { result: await this.deps.browser.command({ op: 'eval', key: str('key'), js: str('js') }) }
      case 'browser.history.list':
        return { entries: this.deps.browserHistory.list() }
      case 'browser.history.record':
        return { entries: this.deps.browserHistory.record({ url: str('url'), title: str('title') }) }
      case 'browser.history.clear':
        this.deps.browserHistory.clear()
        return {}
      case 'handoff.receive':
        return this.deps.handoffs.receive(binding => this.deps.terminals.authenticateAgent(binding), params['credential'] as AgentSessionCredential, str('workspacePath'), str('id'), Number(params['expectedRevision']))
      case 'handoff.acknowledge':
        return this.deps.handoffs.acknowledge(binding => this.deps.terminals.authenticateAgent(binding), params['credential'] as AgentSessionCredential, str('workspacePath'), str('id'), Number(params['expectedRevision']))
      case 'project.kit.export': return this.deps.projectKit!.projectKitExport(str('workspacePath'), str('outputPath'), (params['artifacts'] as string | undefined)?.split('\n').filter(Boolean) ?? [])
      case 'project.kit.preview': return this.deps.projectKit!.projectKitPreview(str('archivePath'))
      case 'project.kit.import': return this.deps.projectKit!.projectKitImport(str('archivePath'), str('destinationPath'), str('expectedSha256'), str('sourceProjectKey'))
      case 'project.kit.report': return this.deps.projectKit!.projectKitReport(str('workspacePath'))
      case 'project.tasks': return this.deps.projectTasks.inspect(str('workspacePath'))
      case 'project.task-authority': return this.deps.projectTasks.setAuthority(str('workspacePath'), params['enabled'] as boolean)
      case 'project.task-tool': return this.deps.projectTasks.openTool(str('workspacePath'), str('tool') as 'lazygit' | 'backlog')
      case 'agent.providers':
        return { providers: this.deps.agents.listAgents() }
      case 'agent.authenticate': {
        const identity = await this.deps.terminals.authenticateAgent(params['credential'] as AgentSessionCredential)
        if (realpathSync(identity.workspacePath) !== realpathSync(str('workspacePath'))) throw new Error('Agent credential belongs to another workspace')
        return identity
      }
      case 'agent.switch':
        if (!this.deps.agents.switchMode) throw new Error('Mode switching unavailable')
        return this.deps.agents.switchMode(str('workspacePath'), str('sessionId'), str('target') as 'native' | 'acp', str('requestId'), params['context'] as string | undefined)
      case 'agent.switch.get':
        if (!this.deps.agents.modeSwitchResult) throw new Error('Mode switching unavailable')
        return this.deps.agents.modeSwitchResult(str('workspacePath'), str('requestId'))
      case 'agent.acp.start':
        if (!this.deps.agents.startAcp) throw new Error('ACP runtime unavailable')
        return this.deps.agents.startAcp(str('workspacePath'), str('requestId'), params['loadRunId'] as string | undefined)
      case 'agent.acp.list':
        if (!this.deps.agents.listAcp) throw new Error('ACP runtime unavailable')
        return { sessions: await this.deps.agents.listAcp(str('workspacePath')) }
      case 'agent.acp.observe':
        if (!this.deps.agents.observeAcp) throw new Error('ACP runtime unavailable')
        return this.deps.agents.observeAcp(str('workspacePath'), str('sessionId'), Number(params['afterSequence'] ?? 0))
      case 'agent.acp.prompt':
        if (!this.deps.agents.promptAcp) throw new Error('ACP runtime unavailable')
        return this.deps.agents.promptAcp(str('workspacePath'), str('sessionId'), str('requestId'), str('text'))
      case 'agent.acp.cancel': case 'agent.acp.stop': case 'agent.acp.permission': case 'agent.acp.dismiss':
        if (!this.deps.agents.controlAcp) throw new Error('ACP runtime unavailable')
        return this.deps.agents.controlAcp(str('workspacePath'), str('sessionId'), method.slice(10) as 'cancel' | 'stop' | 'permission' | 'dismiss', params['permissionId'] as string | undefined, params['optionId'] as string | undefined)
      case 'agent.list':
        return { agents: await this.deps.agents.list() }
      case 'agent.start':
        if ((params['launch'] !== undefined) === (params['command'] !== undefined)) throw new Error('Supply exactly one of command or launch')
        return this.deps.agents.start(str('workspacePath'), params['launch'] === undefined ? str('command') : parseAgentExecutable(params['launch']), params['task'] === undefined ? undefined : parseAgentTaskIntent(params['task']))
      case 'agent.interrupt':
        return this.deps.agents.interrupt(str('sessionId'))
      case 'agent.stop':
        return this.deps.agents.stop(str('sessionId'))
      case 'agent.dismiss':
        await this.deps.agents.dismiss(str('sessionId'))
        return {}
      case 'agent.deliver':
        return this.deps.deliverAgentAttachment({
          requestId: params['requestId'] as string | undefined,
          sessionId: str('sessionId'),
          attachment: {
            kind: str('kind') as 'diff-review' | 'design-capture',
            workspacePath: str('workspacePath'),
            title: str('title'),
            text: str('text')
          },
          submit: params['submit'] === true
        })
      case 'skill.list':
        return this.deps.skills.list({
          workspacePath: params['workspacePath'] as string | undefined,
          providerId: params['providerId'] as SkillPackageProviderId | undefined
        })
      case 'skill.prepare': {
        let source: SkillPackageSource
        if (params['localSource'] !== undefined) {
          source = { kind: 'local', path: str('localSource') }
        } else if (params['sourceKind'] === 'git') {
          source = {
            kind: 'git',
            url: str('sourceUrl'),
            revision: params['revision'] as string | undefined,
            subpath: params['subpath'] as string | undefined
          }
        } else {
          source = { kind: 'https', url: str('sourceUrl') }
        }
        return this.deps.skills.prepare({
          workspacePath: str('workspacePath'),
          providerId: str('providerId') as SkillPackageProviderId,
          source
        })
      }
      case 'skill.apply':
        return this.deps.skills.apply({ planId: str('planId'), confirmationToken: str('confirmationToken') })
      case 'skill.read':
        return this.deps.skills.read({
          kind: 'package',
          workspacePath: str('workspacePath'),
          providerId: str('providerId') as SkillPackageProviderId,
          name: str('name'),
          path: params['path'] as string | undefined
        })
      case 'skill.readLegacy':
        return this.deps.skills.read({ kind: 'legacy', id: str('id') })
      case 'skill.prepareUpdate':
        return this.deps.skills.prepareUpdate({
          workspacePath: str('workspacePath'),
          providerId: str('providerId') as SkillPackageProviderId,
          name: str('name')
        })
      case 'skill.prepareRemove':
        return this.deps.skills.prepareRemove({
          workspacePath: str('workspacePath'),
          providerId: str('providerId') as SkillPackageProviderId,
          name: str('name')
        })
      case 'skill.remove':
        return this.deps.skills.remove({ planId: str('planId'), confirmationToken: str('confirmationToken') })
      case 'scheduled.list':
        return { scheduledRuns: await this.deps.runs.scheduledRunsList() }
      case 'scheduled.save': {
        const input = parseRpcInput(parseScheduledRunInput, params['input'])
        return this.deps.runs.scheduledRunSave(input)
      }
      case 'scheduled.enable':
        return this.deps.runs.scheduledRunSetEnabled(str('id'), params['enabled'] === true)
      case 'scheduled.duplicate':
        return this.deps.runs.scheduledRunDuplicate(str('id'))
      case 'scheduled.delete':
        await this.deps.runs.scheduledRunDelete(str('id'))
        return {}
      case 'scheduled.run':
        return this.deps.runs.scheduledRunRunNow(str('id'))
      case 'scheduled.cancel':
        return this.deps.runs.scheduledRunCancel(str('executionId'))
      case 'scheduled.history':
        return { executions: await this.deps.runs.scheduledRunHistory(str('id')) }
      case 'verification.scripts': return this.deps.runs.verificationScripts(str('workspacePath'))
      case 'verification.run': return this.deps.runs.verificationRun(str('workspacePath'),str('script'),params['options'] as import('@shared/operational-runs').VerificationRunOptions | undefined)
      case 'verification.list': return this.deps.runs.verificationList(str('workspacePath'),params['verifyArtifacts']===true)
      case 'verification.attach': return this.deps.runs.verificationAttach(str('workspacePath'),str('runId'),str('taskId'),str('path'))
      case 'parallel.list':
        return { parallelRuns: await this.deps.runs.parallelRunsList() }
      case 'parallel.start': {
        const input = parseRpcInput(parseParallelRunInput, params['input'])
        return this.deps.runs.parallelRunStart(input, params['options'] as import('@shared/operational-runs').VerificationRunOptions | undefined)
      }
      case 'parallel.retry':
        return this.deps.runs.parallelRunRetry(str('id'), params['taskIds'] as string[])
      case 'parallel.cancel':
        return this.deps.runs.parallelRunCancel(str('id'))
      case 'parallel.delete':
        await this.deps.runs.parallelRunDelete(str('id'))
        return {}
      case 'diffReview.list': {
        const request = parseRpcInput(parseDiffReviewListRequest, {
          workspacePath: str('workspacePath'),
          filePath: str('filePath'),
          comparison: str('comparison')
        })
        return this.deps.diffReview.list(request)
      }
      case 'diffReview.create': {
        const request = parseRpcInput(parseDiffReviewCreateRequest, {
          workspacePath: str('workspacePath'),
          filePath: str('filePath'),
          comparison: str('comparison'),
          snapshot: params['snapshot'],
          anchor: params['anchor'],
          body: str('body'),
          ...(params.runLink === undefined ? {} : { runLink: params.runLink })
        })
        return this.deps.diffReview.create(request)
      }
      case 'diffReview.update': {
        const request = parseRpcInput(parseDiffReviewUpdateRequest, {
          workspacePath: str('workspacePath'),
          id: str('id'),
          expectedRevision: params['expectedRevision'],
          body: str('body')
        })
        return this.deps.diffReview.update(request)
      }
      case 'diffReview.remove': {
        const request = parseRpcInput(parseDiffReviewDeleteRequest, {
          workspacePath: str('workspacePath'),
          id: str('id'),
          expectedRevision: params['expectedRevision']
        })
        await this.deps.diffReview.remove(request)
        return {}
      }
      case 'temporal.status': case 'temporal.reconcile': case 'temporal.query': case 'temporal.stop': {
        const tools = this.deps.projectTools, path = str('workspacePath')
        if (!tools.temporalKnowledgeStatus || !tools.temporalKnowledgeReconcile || !tools.temporalKnowledgeQuery || !tools.temporalKnowledgeStop) throw new Error('Temporal knowledge is unavailable')
        if (method === 'temporal.status') return tools.temporalKnowledgeStatus(path)
        if (method === 'temporal.reconcile') return tools.temporalKnowledgeReconcile(path, (params.selection as { sources: import('@shared/project-knowledge').KnowledgeSelection[] })?.sources)
        if (method === 'temporal.query') return tools.temporalKnowledgeQuery(path, str('query'), params.asOf as string | undefined)
        await tools.temporalKnowledgeStop(path); return {}
      }
      case 'knowledge.status': case 'knowledge.reconcile': case 'knowledge.recall': case 'knowledge.reflect': case 'knowledge.stop': {
        const tools = this.deps.projectTools, path = str('workspacePath')
        if (!tools.knowledgeStatus || !tools.knowledgeReconcile || !tools.knowledgeRecall || !tools.knowledgeReflect || !tools.knowledgeStop) throw new Error('Learned knowledge is unavailable')
        if (method === 'knowledge.status') return tools.knowledgeStatus(path)
        if (method === 'knowledge.reconcile') return tools.knowledgeReconcile(path, (params.selection as { sources: import('@shared/project-knowledge').KnowledgeSelection[] })?.sources)
        if (method === 'knowledge.recall') return tools.knowledgeRecall(path, str('query'))
        if (method === 'knowledge.reflect') return tools.knowledgeReflect(path, str('query'))
        await tools.knowledgeStop(path); return {}
      }
      case 'history.index':
      case 'history.analytics':
      case 'history.analytics.cancel':
      case 'history.analytics.progress':
      case 'history.search':
      case 'history.get': {
        const history = this.deps.sessionHistory
        if (!history) throw new Error('Session history is not configured')
        if (method === 'history.analytics') return history.analytics(str('workspacePath'), { engine: params.engine as 'sqlite' | 'duckdb' | undefined, requestId: params.requestId as string | undefined, decisionAt: params.decisionAt as string | undefined })
        if (method === 'history.analytics.cancel') { await history.cancelAnalytics(str('workspacePath'), str('requestId')); return {} }
        if (method === 'history.analytics.progress') return history.analyticsProgress(str('workspacePath'), str('requestId'))
        if (method === 'history.index') return history.index(str('workspacePath'))
        if (method === 'history.search') return history.search(str('workspacePath'), str('query'))
        return history.get(str('workspacePath'), str('id'))
      }
      case 'tool.list':
        return this.deps.projectTools.list(str('workspacePath'))
      case 'tool.start':
        return this.deps.projectTools.start(str('workspacePath'), str('id'))
      case 'tool.stop':
        await this.deps.projectTools.stop(str('workspacePath'), str('id'))
        return {}
      case 'tool.call':
        return this.deps.projectTools.call(str('workspacePath'), str('id'), str('operation'), params['arguments'])
      case 'memory.list':
        return this.deps.projectMemory.projectMemoryList(parseRpcInput(parseProjectMemoryListRequest, params))
      case 'memory.get':
        return this.deps.projectMemory.projectMemoryGet(parseRpcInput(parseProjectMemoryGetRequest, params))
      case 'memory.create':
        return this.deps.projectMemory.projectMemoryCreate(parseRpcInput(parseProjectMemoryCreateRequest, params))
      case 'memory.update':
        return this.deps.projectMemory.projectMemoryUpdate(parseRpcInput(parseProjectMemoryUpdateRequest, params))
      case 'memory.history':
        return this.deps.projectMemory.projectMemoryHistory(parseRpcInput(parseProjectMemoryHistoryRequest, params))
      case 'memory.archive':
        return this.deps.projectMemory.projectMemoryArchive(parseRpcInput(parseProjectMemoryArchiveRequest, params))
      default:
        throw new Error(`unknown method: ${method}`)
    }
  }
}

export function newRpcToken(): string {
  return randomUUID() + randomUUID().slice(0, 8)
}
