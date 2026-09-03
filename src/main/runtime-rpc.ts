import { createServer, type Server, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AppSettings, BrowserCommand, SettingsSection, UiCommand } from '@shared/types'
import type { Store } from './store'
import type { GitWorktrees } from './git'
import type { DaemonClient } from './daemon-client'

/**
 * Runtime RPC (upstream §6.1, local transport): NDJSON over a unix socket.
 * The CLI (and any local client) drives the same operations the UI has.
 *
 * Envelope:  {id, authToken, method, params} → {id, ok, result|error}
 * Discovery: <userData>/donwells-runtime.json = {socketPath, authToken, pid}
 * Methods are the app surface, grouped by domain like upstream:
 *   status.get, repo.list/add/remove, worktree.create/remove,
 *   terminal.open/write/resize/interrupt/close/list, git.status/files/read,
 *   settings.get/set (live-applied), meta.get,
 *   browser.list/open/navigate/back/forward/reload/snapshot/eval,
 *   ui.state/activate, ui.terminal.open, ui.split, ui.pane.focus/close/resize,
 *   ui.preview.open/close, ui.sidebar, ui.floating, ui.palette, ui.settings.open
 */

export type RpcDeps = {
  store: Store
  git: GitWorktrees
  terminals: DaemonClient
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

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (existsSync(this.socketPath)) rmSync(this.socketPath)
      this.server = createServer((socket) => this.handleClient(socket))
      this.server.on('error', reject)
      mkdirSync(dirname(this.socketPath), { recursive: true })
      this.server.listen(this.socketPath, () => {
        try {
          this.boundIno = statSync(this.socketPath).ino
        } catch {
          this.boundIno = null
        }
        writeFileSync(
          this.runtimeFile,
          JSON.stringify({ socketPath: this.socketPath, authToken: this.authToken, pid: process.pid }, null, 2),
          'utf8'
        )
        resolve()
      })
    })
  }

  stop(): void {
    for (const c of this.clients) c.destroy()
    this.clients.clear()
    // Only tear down the socket/discovery files if they are still OURS: a
    // successor app may have re-bound the same path while we were quitting
    // (server.close() unlinks the bound path — never clobber theirs).
    let owns = false
    try {
      owns = this.boundIno !== null && statSync(this.socketPath).ino === this.boundIno
    } catch {
      owns = false
    }
    if (owns) this.server?.close()
    try {
      const rt = JSON.parse(readFileSync(this.runtimeFile, 'utf8')) as { pid?: number }
      if (rt.pid === process.pid) rmSync(this.runtimeFile)
    } catch {
      // unreadable or already gone — nothing to clean
    }
  }

  private handleClient(socket: Socket): void {
    let authed = false
    let buf = ''
    this.clients.add(socket)

    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (!authed) {
          if (msg['method'] === 'auth.hello' && msg['authToken'] === this.authToken) {
            authed = true
            this.reply(socket, String(msg['id'] ?? ''), true, { version: 'rpc-v1' })
          } else {
            socket.destroy()
          }
          continue
        }
        void this.dispatch(socket, msg)
      }
    })

    socket.on('close', () => this.clients.delete(socket))
    socket.on('error', () => socket.destroy())
  }

  private reply(socket: Socket, id: string, ok: boolean, result: Record<string, unknown>): void {
    if (!socket.destroyed) socket.write(JSON.stringify({ id, ok, ...result }) + '\n')
  }

  private async dispatch(socket: Socket, msg: Record<string, unknown>): Promise<void> {
    const id = String(msg['id'] ?? '')
    const method = String(msg['method'] ?? '')
    const params = (msg['params'] ?? {}) as Record<string, unknown>
    const str = (k: string): string => String(params[k] ?? '')
    try {
      const result = await this.route(method, params, str)
      this.reply(socket, id, true, { result })
    } catch (e) {
      this.reply(socket, id, false, { error: e instanceof Error ? e.message : String(e) })
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
        terminals.resize(str('sessionId'), Number(params['cols'] ?? 100), Number(params['rows'] ?? 30))
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
      case 'git.files':
        return { entries: await git.listFiles(str('worktreePath'), str('prefix')) }
      case 'git.read':
        return git.readFile(str('worktreePath'), str('relPath'))
      case 'settings.get':
        return store.getSettings()
      case 'settings.set': {
        const settings = store.updateSettings(params as Record<string, never>)
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
        return this.deps.ui.command({ op: 'preview.close', worktreePath: str('worktreePath') })
      case 'ui.sidebar':
        return this.deps.ui.command({
          op: 'sidebar',
          side: str('side') === 'right' ? 'right' : 'left',
          open: params['open'] as boolean | 'toggle' | undefined,
          tab: params['tab'] as 'explorer' | 'git' | undefined,
          width: params['width'] === undefined ? undefined : Number(params['width'])
        })
      case 'ui.floating':
        return this.deps.ui.command({ op: 'floating', action: (params['action'] as 'open' | 'close' | 'toggle' | undefined) ?? 'toggle' })
      case 'ui.palette': {
        const raw = params['open']
        // CLI passthrough sends 'open'/'close' strings — normalize here
        const open = raw === undefined || raw === 'toggle' ? 'toggle' : raw === 'open' ? true : raw === 'close' ? false : Boolean(raw)
        return this.deps.ui.command({ op: 'palette', open })
      }
      case 'ui.settings.open':
        return this.deps.ui.command({ op: 'settings.open', section: params['section'] as SettingsSection | undefined })
      case 'browser.list':
        return { panes: await this.deps.browser.command({ op: 'list' }) }
      case 'browser.open':
        await this.deps.browser.command({ op: 'open', key: str('worktreePath'), url: str('url') })
        return { snapshot: await this.deps.browser.command({ op: 'snapshot', key: str('worktreePath') }) }
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
      default:
        throw new Error(`unknown method: ${method}`)
    }
  }
}

export function newRpcToken(): string {
  return randomUUID() + randomUUID().slice(0, 8)
}