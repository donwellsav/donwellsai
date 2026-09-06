import { ProjectHandoffService } from './project-handoff'
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron'
import { join } from 'node:path'
import { ProjectTools, resolveProjectToolScope } from './project-tools'
import { createProject } from './project-creation'
import { ProjectMemoryService } from './project-memory'
import { configureAgentMemory } from './agents/project-memory-config'
import { EditorRecoveryService, registerEditorRecoveryHandlers } from './editor-recovery'
import type { AppMeta, AppSettings, AttentionState, BrowserCommand, IpcApi, MainEvents, SettingsResetRequest, UiCommand } from '@shared/types'
import { RuntimeRpcServer, newRpcToken } from './runtime-rpc'
import { RendererCommandRouter } from './renderer-command-router'
import packageMetadata from '../../package.json'
import { Store, idFromPath } from './store'
import { GitWorktrees, verifyWorktreePath, resolveRegisteredProjectWorkspace } from './git'
import { scanWorktree } from './ports'
import { DaemonClient } from './daemon-client'
import { runSmokeProbe } from './smoke-probe'
import { TrayService } from './tray-service'
import { SkillPackagesManager } from './skills'
import { SecretStore } from './secret-store'
import { BROWSER_PARTITION, configureBrowserPermissions, guardBrowserGuests } from './browser-permissions'
import { OperationalRunService } from './operational-run-service'
import { AgentRuntime, type AgentWorkspaceRegistration } from './agent-runtime'
import { deliverAgentAttachment } from './agent-delivery'
import { DiffReviewService } from './diff-review'
import { existsSync } from 'node:fs'
import { BrowserHistoryStore } from './browser-history'
import type { BrowserHistoryRecord } from '@shared/browser-history'
import { registerBrowserShortcuts } from './browser-shortcuts'
import { localRuntimePaths } from './local-runtime'
import { applyWindowAppearance } from './appearance'
import { registerMediaPreviewHandlers } from './media-preview'
import { registerProjectSearchHandlers } from './project-search-ipc'

// Unpackaged runs resolve userData from app name; pin it so `electron out/main/index.js`
// lands in donwells.ai, not Electron's default dir.
app.setName('donwells.ai')
// Test seam: isolated userData dir for the smoke harness.
if (process.env['DONWELLS_USER_DATA']) {
  app.setPath('userData', process.env['DONWELLS_USER_DATA'])
}

// Single instance (upstream parity): a second app instance would fight the first
// for the RPC socket path and discovery file. Focus the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

let store: Store
let browserHistory: BrowserHistoryStore
let git: GitWorktrees
let terminalBus: DaemonClient
let rpcServer: RuntimeRpcServer | null = null
let trayService: TrayService | null = null
let secrets: SecretStore | null = null
let operationalRuns: OperationalRunService
let agentRuntime: AgentRuntime
let mainWindow: BrowserWindow | null = null
let quitRequested = false
let allowQuit = false
let projectTools: ProjectTools | undefined
let toolsClosed = false
let closingTools: Promise<void> | undefined
const resolveRegisteredWorkspace = (path: string): Promise<string> => verifyWorktreePath(store, path)

function send<K extends keyof MainEvents>(channel: K, payload: MainEvents[K]): void {
  mainWindow?.webContents.send(channel, payload)
}

function publishSettings(settings: AppSettings): AppSettings {
  send('settings:changed', { settings })
  buildMenu()
  return settings
}

/** Route a menu/accelerator action to the renderer; the store decides what it does. */
function menuAction(action: string): void {
  send('menu:action', { action })
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Add Repository…', accelerator: 'CmdOrCtrl+O', click: () => menuAction('add-repo') },
        { label: 'New Worktree', accelerator: 'CmdOrCtrl+N', click: () => menuAction('new-worktree') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => menuAction('close-active-pane') },
        { label: 'Close Window', accelerator: 'Shift+CmdOrCtrl+W', click: () => BrowserWindow.getFocusedWindow()?.close() },
        ...(isMac ? [] : [{ type: 'separator' } as Electron.MenuItemConstructorOptions, { role: 'quit' } as Electron.MenuItemConstructorOptions])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+P', click: () => menuAction('command-palette') },
        { label: 'New Terminal', accelerator: 'CmdOrCtrl+T', click: () => menuAction('new-terminal') },
        { label: 'Split Terminal', accelerator: 'CmdOrCtrl+Shift+5', click: () => menuAction('split-terminal') },
        { label: 'Toggle Explorer', accelerator: 'CmdOrCtrl+Shift+E', click: () => menuAction('toggle-explorer') },
        { label: 'Toggle Git Status', accelerator: 'CmdOrCtrl+Shift+G', click: () => menuAction('toggle-git-status') },
        { label: 'Run Agent', accelerator: 'CmdOrCtrl+Enter', click: () => menuAction('run-agent') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => menuAction('settings') },
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? ([{ type: 'separator' }, { role: 'front' }] as Electron.MenuItemConstructorOptions[])
          : ([{ role: 'close' }] as Electron.MenuItemConstructorOptions[]))
      ]
    },
    ...(!isMac
      ? ([
          {
            label: 'Help',
            submenu: [{ role: 'about' }]
          }
        ] as Electron.MenuItemConstructorOptions[])
      : [])
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

const commandRouter = new RendererCommandRouter(() => {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  return mainWindow!.webContents
})
const browserControl = (cmd: BrowserCommand): Promise<unknown> => commandRouter.call('browser:command', cmd)
const uiControl = (cmd: UiCommand): Promise<unknown> => commandRouter.call('ui:command', cmd)

function runtimeMetadata(): AppMeta {
  return {
    version: packageMetadata.version,
    shell: process.env.SHELL || '',
    userDataDir: app.getPath('userData'),
    memoryMcp: {
      command: process.execPath,
      args: [join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'cli', 'donwells.mjs')],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    }
  }
}

function registerIpc(): void {
  ipcMain.handle('agentConfigureMemory', async (_e, workspacePath: string, provider: string, launchArgs?: string[]) => configureAgentMemory({
    files: git, workspacePath: await resolveRegisteredWorkspace(workspacePath), provider, launchArgs, userDataDir: app.getPath('userData'), executable: process.execPath,
    cliPath: join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'cli', 'donwells.mjs')
  }))
  ipcMain.handle('meta', runtimeMetadata)
  const editorRecovery = new EditorRecoveryService(app.getPath('userData'), { resolveWorkspace: resolveRegisteredWorkspace })
  registerEditorRecoveryHandlers(ipcMain, editorRecovery)
  ipcMain.handle('attentionInboxList', () => terminalBus.attentionInboxList())
  ipcMain.handle('attentionInboxAcknowledge', (_e, request: Parameters<IpcApi['attentionInboxAcknowledge']>[0]) => terminalBus.attentionInboxAcknowledge(request))

  ipcMain.handle('listRepos', () => git.listAll())
  ipcMain.handle('getProjectCreationDefaults', () => ({ parentPath: app.getPath('home') }))
  ipcMain.handle('createProject', async (_e, request: Parameters<IpcApi['createProject']>[0]) => {
    const summary = await createProject(request, (path) => git.addRepo(path))
    send('worktree:changed', { repoId: summary.repo.id })
    return summary
  })

  ipcMain.handle('addRepo', async (_e, dir: string) => {
    const summary = await git.addRepo(dir)
    send('worktree:changed', { repoId: summary.repo.id })
    return summary
  })

  ipcMain.handle('removeRepo', (_e, repoId: string) => {
    git.removeRepo(repoId)
    // RPC (or any client) may remove repos behind the renderer's back — let it prune.
    send('worktree:changed', { repoId })
    return true
  })
  ipcMain.handle('refreshRepo', (_e, repoId: string) => {
    const repo = store.listRepos().find((r) => r.id === repoId)
    if (!repo) throw new Error(`unknown repo ${repoId}`)
    return git.summarize(repo.path)
  })

  ipcMain.handle('createWorktree', async (_e, repoId: string, opts: { name?: string; branch?: string }) => {
    const repo = store.listRepos().find((r) => r.id === repoId)
    if (!repo) throw new Error(`unknown repo ${repoId}`)
    const summary = await git.createWorktree(repo.path, opts)
    send('worktree:changed', { repoId })
    return summary
  })

  ipcMain.handle('removeWorktree', async (_e, repoId: string, worktreePath: string, force = false) => {
    const repo = store.listRepos().find((r) => r.id === repoId)
    if (!repo) throw new Error(`unknown repo ${repoId}`)
    const summary = await git.removeWorktree(repo.path, worktreePath, force)
    send('worktree:changed', { repoId })
    return summary
  })

  ipcMain.handle('openTerminal', async (_e, worktreePath: string, cwd?: string) => {
    if (!existsSync(worktreePath)) throw new Error(`path does not exist: ${worktreePath}`)
    return terminalBus.open(cwd ?? worktreePath, 100, 30)
  })

  ipcMain.handle('attachTerminal', async (_e, sessionId: string) => {
    // scrollback snapshot + live session state for reattach after app restart
    return terminalBus.attach(sessionId)
  })

  ipcMain.handle('closeTerminal', async (_e, sessionId: string) => {
    await terminalBus.close(sessionId)
    return true
  })

  ipcMain.handle('terminalWrite', (_e, sessionId: string, data: string) => {
    terminalBus.write(sessionId, data)
    return true
  })

  ipcMain.handle('terminalResize', (_e, sessionId: string, cols: number, rows: number) => {
    terminalBus.resize(sessionId, cols, rows)
    return true
  })

  ipcMain.handle('terminalInterrupt', (_e, sessionId: string) => {
    terminalBus.interrupt(sessionId)
    return true
  })
  ipcMain.handle('terminalSessions', () => terminalBus.list())

  ipcMain.handle('gitStatus', (_e, worktreePath: string) => git.status(worktreePath))
  ipcMain.handle('scanWorktree', (_e, worktreePath: string) => scanWorktree(worktreePath))
  ipcMain.handle('gitStage', (_e, worktreePath: string, paths: string[]) => git.stage(worktreePath, paths))
  ipcMain.handle('gitUnstage', (_e, worktreePath: string, paths: string[]) => git.unstage(worktreePath, paths))
  ipcMain.handle('gitDiscard', (_e, worktreePath: string, paths: string[]) => git.discard(worktreePath, paths))
  ipcMain.handle('gitCommit', (_e, ...args: Parameters<IpcApi['gitCommit']>) => git.commit(...args))
  ipcMain.handle('gitPush', (_e, worktreePath: string) => git.push(worktreePath))
  ipcMain.handle('gitPull', (_e, worktreePath: string) => git.pull(worktreePath))
  ipcMain.handle('gitFetch', (_e, ...args: Parameters<IpcApi['gitFetch']>) => git.fetch(...args))
  ipcMain.handle('gitBranches', (_e, worktreePath: string) => git.branches(worktreePath))
  ipcMain.handle('gitCheckout', (_e, worktreePath: string, branch: string) => git.checkout(worktreePath, branch))
  ipcMain.handle('gitCreateBranch', (_e, ...args: Parameters<IpcApi['gitCreateBranch']>) => git.createBranch(...args))
  ipcMain.handle('gitHistory', (_e, ...args: Parameters<IpcApi['gitHistory']>) => git.history(...args))
  ipcMain.handle('gitDiff', (_e, worktreePath: string, relPath: string) => git.diff(worktreePath, relPath))
  ipcMain.handle('listWorkspaceDirectory', (_e, ...args: Parameters<IpcApi['listWorkspaceDirectory']>) => git.listWorkspaceDirectory(...args))
  ipcMain.handle('searchWorkspaceFiles', (_e, ...args: Parameters<IpcApi['searchWorkspaceFiles']>) => git.searchWorkspaceFiles(...args))
  ipcMain.handle('createWorkspaceEntry', (_e, ...args: Parameters<IpcApi['createWorkspaceEntry']>) => git.createWorkspaceEntry(...args))
  ipcMain.handle('moveWorkspaceEntry', (_e, ...args: Parameters<IpcApi['moveWorkspaceEntry']>) => git.moveWorkspaceEntry(...args))
  ipcMain.handle('duplicateWorkspaceEntry', (_e, ...args: Parameters<IpcApi['duplicateWorkspaceEntry']>) => git.duplicateWorkspaceEntry(...args))
  ipcMain.handle('deleteWorkspaceEntry', (_e, ...args: Parameters<IpcApi['deleteWorkspaceEntry']>) => git.deleteWorkspaceEntry(...args))
  ipcMain.handle('readFile', (_e, worktreePath: string, relPath: string) => git.readFile(worktreePath, relPath))
  ipcMain.handle('readFileAtRef', (_e, worktreePath: string, relPath: string, ref?: string) => git.readFileAtRef(worktreePath, relPath, ref))
  ipcMain.handle('writeFile', (_e, worktreePath: string, relPath: string, content: string, expectedRevision?: string) => git.writeFile(worktreePath, relPath, content, expectedRevision))
  ipcMain.handle('readPreviewImage', (_e, worktreePath: string, documentPath: string, source: string) => git.readPreviewImage(worktreePath, documentPath, source))
  registerMediaPreviewHandlers(git)
  registerProjectSearchHandlers(git)
  ipcMain.handle('applyAppearance', (_e, request: Parameters<IpcApi['applyAppearance']>[0]) => {
    if (!mainWindow) throw new Error('The application window is unavailable')
    applyWindowAppearance(mainWindow, request)
  })

  ipcMain.handle('getSettings', () => store.getSettings())
  ipcMain.handle('setSettings', (_e, patch: Record<string, unknown>) => publishSettings(store.updateSettings(patch)))
  ipcMain.handle('resetSettings', (_e, request: SettingsResetRequest) => publishSettings(store.resetSettings(request)))
  ipcMain.handle('browserHistoryList', () => browserHistory.list())
  ipcMain.handle('browserHistoryRecord', (_e, entry: BrowserHistoryRecord) => browserHistory.record(entry))
  ipcMain.handle('browserHistoryClear', () => browserHistory.clear())

  ipcMain.handle('getWorkspaceSession', () => store.getWorkspaceSession())
  ipcMain.handle('saveWorkspaceSession', (_e, ws) => store.setWorkspaceSession(ws))

  ipcMain.handle('pickDirectory', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle('listAgents', () => agentRuntime.listAgents())
  ipcMain.handle('agentStart', (_e, ...args: Parameters<IpcApi['agentStart']>) => agentRuntime.start(...args))
  ipcMain.handle('agentList', () => agentRuntime.list())
  ipcMain.handle('agentInterrupt', (_e, sessionId: string) => agentRuntime.interrupt(sessionId))
  ipcMain.handle('agentStop', (_e, sessionId: string) => agentRuntime.stop(sessionId))
  ipcMain.handle('agentDismiss', (_e, sessionId: string) => agentRuntime.dismiss(sessionId))
  ipcMain.handle('agentDeliver', (_e, request: Parameters<IpcApi['agentDeliver']>[0]) => deliverAgentAttachment(agentRuntime, terminalBus, resolveRegisteredWorkspace, request))

  ipcMain.handle('openExternal', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return true
  })

  ipcMain.on('browser:router-ready', (event) => commandRouter.ready('browser:command', event.sender))
  ipcMain.on('ui:router-ready', (event) => commandRouter.ready('ui:command', event.sender))
  ipcMain.on('browser:command:result', (event, id: string, result) => commandRouter.resolve('browser:command', id, result, event.sender))
  ipcMain.on('ui:command:result', (event, id: string, result) => commandRouter.resolve('ui:command', id, result, event.sender))
}

function createWindow(): void {
  configureBrowserPermissions(session.fromPartition(BROWSER_PARTITION))
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'donwells.ai',
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: true
    }
  })

  const window = mainWindow
  commandRouter.bind(window.webContents)
  guardBrowserGuests(window)
  // Documents may open content, never replace the privileged application renderer.
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) commandRouter.reset(new Error('Renderer reloaded before the command finished'), true)
  })
  window.webContents.on('render-process-gone', () => commandRouter.reset(new Error('Renderer process exited before the command finished')))
  let closing = false
  let allowClose = false
  window.on('close', (event) => {
    if (allowClose || !commandRouter.isReady('ui:command')) return
    event.preventDefault()
    if (closing) return
    closing = true
    void (async () => {
      try {
        await uiControl({ op: 'workspace.flush' })
      } catch (error) {
        const result = await dialog.showMessageBox(window, {
          type: 'warning', message: 'Some changes could not be saved', detail: String(error),
          buttons: ['Keep open', 'Close without saving'], defaultId: 0, cancelId: 0
        })
        if (result.response !== 1) { closing = false; quitRequested = false; return }
      }
      allowClose = true
      window.close()
      if (quitRequested) { allowQuit = true; app.quit() }
    })()
  })
  window.on('closed', () => {
    commandRouter.reset(new Error('Window closed before the command finished'))
    mainWindow = null
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  store = new Store()
  browserHistory = new BrowserHistoryStore(app.getPath('userData'))
  registerBrowserShortcuts(() => mainWindow?.webContents ?? null)
  git = new GitWorktrees(store)
  git.setTrashRoot(join(app.getPath('userData'), 'trash'))
  // Daemon owns the PTYs: spawn-if-needed (detached), never killed on app exit —
  // running agents survive app restarts; scrollback replays on reattach.
  terminalBus = new DaemonClient(
    app.getPath('userData'),
    {
      data: (sessionId, data, sequence) => {
        send('terminal:data', { sessionId, data, sequence })
        void operationalRuns?.onDaemonEvent('data', sessionId, data).catch((error) => console.error('Run output persistence failed:', error))
      },
      exit: (sessionId, exitCode) => {
        send('terminal:exit', { sessionId, exitCode })
        void operationalRuns?.onDaemonEvent('exit', sessionId, '', exitCode).catch((error) => console.error('Run completion persistence failed:', error))
      },
      title: (sessionId, title) => send('terminal:title', { sessionId, title }),
      agent: (run) => {
        agentRuntime.observe(run)
        send('agent:changed', { run })
      },
      agentDismissed: (sessionId) => {
        agentRuntime.observeDismissed(sessionId)
        send('agent:dismissed', { sessionId })
      }
    },
    join(__dirname, 'terminal-daemon-entry.js')
  )
  agentRuntime = new AgentRuntime(terminalBus, {
    registeredWorkspaces: async () => (await git.listAll()).flatMap<AgentWorkspaceRegistration>((summary) => [
      { path: summary.repo.path, host: { kind: 'local' } },
      ...summary.worktrees.map<AgentWorkspaceRegistration>((worktree) => ({ path: worktree.path, host: { kind: 'local' } }))
    ])
  })
  operationalRuns = new OperationalRunService(app.getPath('userData'), terminalBus, resolveRegisteredWorkspace)
  void terminalBus.connect().catch((e) => {
    console.error('terminal daemon connect failed:', e)
  })
  registerIpc()
  buildMenu()
  createWindow()
  // Tray presence + attention badge; skipped headless (smoke runs).
  if (process.env['DONWELLS_SMOKE'] !== '1' && process.platform !== 'linux') {
    trayService = new TrayService()
    trayService.start(() => {
      if (!mainWindow) createWindow()
      else {
        mainWindow.show()
        mainWindow.focus()
      }
    })
  }
  secrets = new SecretStore(app.getPath('userData'))
  ipcMain.handle('secretSet', (_e, key: string, value: string) => {
    secrets?.set(key, value)
    return true
  })
  ipcMain.handle('secretGet', (_e, key: string) => secrets?.get(key) ?? null)
  ipcMain.handle('secretDelete', (_e, key: string) => {
    secrets?.delete(key)
    return true
  })
  ipcMain.handle('secretAvailable', () => secrets?.available ?? false)
  // Renderer-driven, preference-gated native attention effects.
  ipcMain.on('attention', (_event, state: AttentionState) => trayService?.setAttention(state))

  void operationalRuns.resume().catch((error) => console.error('Run recovery failed:', error))
  ipcMain.handle('scheduledRunsList', () => operationalRuns.scheduledRunsList())
  ipcMain.handle('scheduledRunSave', (_e, ...args: Parameters<IpcApi['scheduledRunSave']>) => operationalRuns.scheduledRunSave(...args))
  ipcMain.handle('scheduledRunSetEnabled', (_e, ...args: Parameters<IpcApi['scheduledRunSetEnabled']>) => operationalRuns.scheduledRunSetEnabled(...args))
  ipcMain.handle('scheduledRunDuplicate', (_e, id: string) => operationalRuns.scheduledRunDuplicate(id))
  ipcMain.handle('scheduledRunDelete', (_e, id: string) => operationalRuns.scheduledRunDelete(id))
  ipcMain.handle('scheduledRunRunNow', (_e, id: string) => operationalRuns.scheduledRunRunNow(id))
  ipcMain.handle('scheduledRunCancel', (_e, id: string) => operationalRuns.scheduledRunCancel(id))
  ipcMain.handle('scheduledRunHistory', (_e, id: string) => operationalRuns.scheduledRunHistory(id))
  ipcMain.handle('parallelRunsList', () => operationalRuns.parallelRunsList())
  ipcMain.handle('parallelRunStart', (_e, ...args: Parameters<IpcApi['parallelRunStart']>) => operationalRuns.parallelRunStart(...args))
  ipcMain.handle('parallelRunRetry', (_e, ...args: Parameters<IpcApi['parallelRunRetry']>) => operationalRuns.parallelRunRetry(...args))
  ipcMain.handle('parallelRunCancel', (_e, id: string) => operationalRuns.parallelRunCancel(id))
  ipcMain.handle('parallelRunDelete', (_e, id: string) => operationalRuns.parallelRunDelete(id))
  const skills = new SkillPackagesManager(app.getPath('userData'), {
    resolveWorkspace: resolveRegisteredWorkspace
  })
  ipcMain.handle('skillPackagesList', (_e, ...args: Parameters<IpcApi['skillPackagesList']>) => skills.list(...args))
  ipcMain.handle('skillPackagesPrepare', (_e, ...args: Parameters<IpcApi['skillPackagesPrepare']>) => skills.prepare(...args))
  ipcMain.handle('skillPackagesApply', (_e, ...args: Parameters<IpcApi['skillPackagesApply']>) => skills.apply(...args))
  ipcMain.handle('skillPackagesRead', (_e, ...args: Parameters<IpcApi['skillPackagesRead']>) => skills.read(...args))
  ipcMain.handle('skillPackagesPrepareUpdate', (_e, ...args: Parameters<IpcApi['skillPackagesPrepareUpdate']>) => skills.prepareUpdate(...args))
  ipcMain.handle('skillPackagesPrepareRemove', (_e, ...args: Parameters<IpcApi['skillPackagesPrepareRemove']>) => skills.prepareRemove(...args))
  ipcMain.handle('skillPackagesRemove', (_e, ...args: Parameters<IpcApi['skillPackagesRemove']>) => skills.remove(...args))
  const diffReview = new DiffReviewService(app.getPath('userData'), { resolveWorkspace: resolveRegisteredWorkspace })
  ipcMain.handle('diffReviewList', (_e, ...args: Parameters<IpcApi['diffReviewList']>) => diffReview.list(...args))
  ipcMain.handle('diffReviewCreate', (_e, ...args: Parameters<IpcApi['diffReviewCreate']>) => diffReview.create(...args))
  ipcMain.handle('diffReviewUpdate', (_e, ...args: Parameters<IpcApi['diffReviewUpdate']>) => diffReview.update(...args))
  ipcMain.handle('diffReviewDelete', (_e, ...args: Parameters<IpcApi['diffReviewDelete']>) => diffReview.remove(...args))
  const resolveToolWorkspace = (path: string) => resolveRegisteredProjectWorkspace(store, path)
  projectTools = new ProjectTools(resolveToolWorkspace, [])
  const handoffs = new ProjectHandoffService(app.getPath('userData'), path => resolveProjectToolScope(path, resolveToolWorkspace), git, agentRuntime)
  ipcMain.handle('projectHandoffExport', (_e, ...args: Parameters<IpcApi['projectHandoffExport']>) => handoffs.projectHandoffExport(...args))
  ipcMain.handle('projectHandoffList', (_e, ...args: Parameters<IpcApi['projectHandoffList']>) => handoffs.projectHandoffList(...args))
  ipcMain.handle('projectHandoffGet', (_e, ...args: Parameters<IpcApi['projectHandoffGet']>) => handoffs.projectHandoffGet(...args))
  ipcMain.handle('projectHandoffCreate', (_e, ...args: Parameters<IpcApi['projectHandoffCreate']>) => handoffs.projectHandoffCreate(...args))
  ipcMain.handle('projectHandoffAccept', (_e, ...args: Parameters<IpcApi['projectHandoffAccept']>) => handoffs.projectHandoffAccept(...args))
  ipcMain.handle('projectHandoffSupersede', (_e, ...args: Parameters<IpcApi['projectHandoffSupersede']>) => handoffs.projectHandoffSupersede(...args))
  const projectMemory = new ProjectMemoryService(app.getPath('userData'), async (workspacePath) => {
    const { projectPath, projectKey } = await resolveProjectToolScope(workspacePath, resolveToolWorkspace)
    return { projectPath, projectKey }
  }, { onChanged: ({ projectKey }) => send('project-memory:changed', { projectKey }) })
  ipcMain.handle('projectMemoryList', (_e, request: Parameters<IpcApi['projectMemoryList']>[0]) => projectMemory.projectMemoryList(request))
  ipcMain.handle('projectMemoryStorageStatus', () => projectMemory.projectMemoryStorageStatus())
  ipcMain.handle('projectMemoryStorageAction', async (_e, action: unknown) => {
    const result = await projectMemory.projectMemoryStorageAction(action)
    if (result.exportPath) shell.showItemInFolder(result.exportPath)
    return result
  })
  ipcMain.handle('projectMemoryGet', (_e, request: Parameters<IpcApi['projectMemoryGet']>[0]) => projectMemory.projectMemoryGet(request))
  ipcMain.handle('projectMemoryCreate', (_e, request: Parameters<IpcApi['projectMemoryCreate']>[0]) => projectMemory.projectMemoryCreate(request))
  ipcMain.handle('projectMemoryUpdate', (_e, request: Parameters<IpcApi['projectMemoryUpdate']>[0]) => projectMemory.projectMemoryUpdate(request))
  ipcMain.handle('projectMemoryHistory', (_e, request: Parameters<IpcApi['projectMemoryHistory']>[0]) => projectMemory.projectMemoryHistory(request))
  ipcMain.handle('projectMemoryArchive', (_e, request: Parameters<IpcApi['projectMemoryArchive']>[0]) => projectMemory.projectMemoryArchive(request))
  const runtimePaths = localRuntimePaths(app.getPath('userData'), 'app')
  const rpc = new RuntimeRpcServer(
    runtimePaths.socketPath,
    runtimePaths.runtimeFile,
    newRpcToken(),
    {
      store,
      git,
      terminals: terminalBus,
      agents: agentRuntime,
      deliverAgentAttachment: (request) => deliverAgentAttachment(agentRuntime, terminalBus, resolveRegisteredWorkspace, request),
      skills,
      runs: operationalRuns,
      browserHistory,
      diffReview,
      projectMemory,
      handoffs,
      projectTools,
      meta: async () => runtimeMetadata(),
      onChanged: (repoId) => send('worktree:changed', { repoId }),
      onSettingsChanged: publishSettings,
      browser: { command: (cmd) => browserControl(cmd) },
      ui: { command: (cmd) => uiControl(cmd) }
    }
  )
  rpcServer = rpc
  void rpc.start().catch((e) => console.error('runtime rpc failed to start:', e))
  if (process.env['DONWELLS_SMOKE'] === '1') {
    mainWindow?.webContents.once('did-finish-load', () => {
      console.log('smoke:ready')
      void runSmokeProbe(git).then((ok) => {
        app.exit(ok ? 0 : 1)
      })
    })
  }
})
app.on('before-quit', (event) => {
  if (!allowQuit && mainWindow && commandRouter.isReady('ui:command')) {
    event.preventDefault()
    quitRequested = true
    mainWindow.close()
  }
})

app.on('will-quit', (event) => {
  if (projectTools && !toolsClosed) {
    event.preventDefault()
    closingTools ??= projectTools.close().catch(() => {
      dialog.showErrorBox('Tool shutdown incomplete', 'An owned tool process could not be confirmed stopped. Check it before starting another instance.')
    }).then(() => { toolsClosed = true; setImmediate(() => app.quit()) })
    return
  }
  // daemon rule: never kill the daemon or its PTYs on app exit — sessions survive.
  // The RPC socket is UI-adjacent: closing it is correct (CLI reconnects via discovery).
  rpcServer?.stop()
  operationalRuns?.stop()
  trayService?.stop()
})

app.on('window-all-closed', () => {
  // macOS convention (and upstream parity): stay alive with no windows; quit elsewhere.
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
