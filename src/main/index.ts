import { WorkspacePreview } from './workspace-preview'
import { resolveExistingEntry } from './worktree-files'
import { isObject } from '@shared/command-catalog'
import { appCommand, electronAccelerator, type AppCommandId } from '@shared/app-commands'
import { appResourcesRoot } from './app-resources'
import { NativeTerminals, nativeTerminalAvailability, nativeTerminalThemes } from './native-terminals'
import { readHerdrSnapshot } from './herdr-session'
import { ProjectExport } from './project-export'
import { ProjectTaskCoordination } from './project-task-coordination'
import { publishRegisteredProjects } from './task-authority/task-authority-migration'
import { ProjectHandoffService } from './project-handoff'
import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } from 'electron'
import { restoreWindowBounds } from './window-bounds'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveProjectToolScope } from './project-tools'
import { ProjectDoctor } from './project-doctor'
import { parseProjectToolConfiguration } from '@shared/project-doctor'
import { createCodeGraphDefinition } from './project-code-graph'
import { createDocumentDefinition } from './project-documents'
import { createProject } from './project-creation'
import { ProjectMemoryService } from './project-memory'
import { configureAgentMemory } from './agents/project-memory-config'
import { EditorRecoveryService, registerEditorRecoveryHandlers } from './editor-recovery'
import type { AppMeta, AppSettings, BrowserCommand, IpcApi, MainEvents, SettingsResetRequest, UiCommand } from '@shared/types'
import { RuntimeRpcServer, newRpcToken } from './runtime-rpc'
import { RendererCommandRouter } from './renderer-command-router'
import packageMetadata from '../../package.json'
import { Store } from './store'
import { GitWorktrees, verifyWorktreePath, verifyWorkspaceDirectory, resolveRegisteredProjectWorkspace } from './git'
import { scanWorktree } from './ports'
import { DaemonClient } from './daemon-client'
import { runSmokeProbe } from './smoke-probe'
import { TrayService } from './tray-service'
import { SkillPackagesManager } from './skills'
import { SecretStore } from './secret-store'
import { ProviderCredentialAuthority, ProviderSecretAuthority } from './provider-secret-authority'
import { parseProviderCredentialRevokeRequest, parseProviderCredentialStatusRequest, parseProviderCredentialWriteRequest, SecretAuthorityError } from '@shared/provider-secret-broker'
import { hashVerificationArtifact } from './diff-review'
import { OperationalRunService, openVerificationArtifact } from './operational-run-service'
import { registerTaskAuthorityCapability } from './plugins/app-capabilities'
import { AgentRuntime, type AgentWorkspaceRegistration } from './agent-runtime'
import { deliverAgentAttachment } from './agent-delivery'
import { DiffReviewService } from './diff-review'
import { existsSync } from 'node:fs'
import { BrowserHistoryStore } from './browser-history'
import type { BrowserHistoryRecord } from '@shared/browser-history'
import { BrowserViews } from './browser-views'
import { createComputerToolDefinition } from './project-computer-tools'
import { createBrowserToolDefinition } from './project-browser-tools'
import { ProjectLanguageTools } from './project-language-tools'
import { canonicalPrivateDirectory } from '@shared/runtime-file-security'
import { localRuntimePaths } from './local-runtime'
import { applyWindowAppearance } from './appearance'
import { registerMediaPreviewHandlers } from './media-preview'
import { registerProjectSearchHandlers } from './project-search-ipc'
import { createServer } from 'node:http'
import { configureDesktopPath } from '@shared/child-process/process-environment'
import { AgentRegistry } from './agents/registry'
import * as Sentry from '@sentry/electron/main'
import { logger } from '@shared/logger'
import { initServices, getServices } from './services'
import { getPerfStats, startIpcTimer } from '@shared/perf-monitor'
import { createDaemonJobRunner, executeJobCommand } from './autonomous/daemon-job-runner'


configureDesktopPath()

// Crash reporting — opt-in via env, DSN must be configured
if (process.env['DONWELLS_SENTRY_DSN']) {
  Sentry.init({
    dsn: process.env['DONWELLS_SENTRY_DSN'],
    release: `donwells@${packageMetadata.version}`,
    environment: process.env['NODE_ENV'] || 'production',
  })
}

// Unpackaged runs resolve userData from app name; pin it so `electron out/main/index.js`
// lands in donwells.ai, not Electron's default dir.
app.setName('donwells.ai')

// Test seam: isolated userData dir for the smoke harness. Must run BEFORE
// initServices(): the feature tier binds app.getPath('userData') at construction.
if (process.env['DONWELLS_USER_DATA']) {
  app.setPath('userData', process.env['DONWELLS_USER_DATA'])
}
initServices()

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
/**
 * The separate Graphiti Neo4j secret authority: unrelated to provider
 * credentials, with its own store, migration risk, and durable key namespace.
 */
let graphitiSecrets: SecretStore | null = null
/** Main-process orchestration of the provider credential saga. */
let providerCredentials: ProviderCredentialAuthority | null = null
let operationalRuns: OperationalRunService
let agentRuntime: AgentRuntime
const guiDrafts = new Map<string, string>()
const pendingGuiSaves = new Set<Promise<unknown>>()
function acknowledgeGuiDraft<T>(name: string, key: string, action: () => Promise<T>): Promise<T> {
  const entries = () => JSON.parse(guiDrafts.get(name) ?? '[]') as Array<[string, unknown]>
  const sortedStringify = (v: unknown) => JSON.stringify(v, (_, val) =>
    typeof val === 'object' && val !== null && !Array.isArray(val) ?
      Object.keys(val).sort().reduce((s, k) => { s[k] = val[k]; return s }, {} as Record<string, unknown>) : val)
  const submitted = sortedStringify(entries().find(row => row[0] === key)?.[1])
  const pending = Promise.resolve().then(action).then(result => {
    const current = entries()
    if (sortedStringify(current.find(row => row[0] === key)?.[1]) === submitted) guiDrafts.set(name, JSON.stringify(current.filter(row => row[0] !== key)))
    return result
  }).finally(() => pendingGuiSaves.delete(pending))
  pendingGuiSaves.add(pending)
  return pending
}
function acknowledgeMemoryDraft<T>(request: Parameters<IpcApi['projectMemoryCreate']>[0] | Parameters<IpcApi['projectMemoryUpdate']>[0], action: () => Promise<T>): Promise<T> {
  const editor: unknown = (JSON.parse(guiDrafts.get('memory-editor') ?? '[]') as Array<[string, unknown]>).find(row => row[0] === 'editor')?.[1]
  if (!isObject(editor) || !isObject(editor.draft)) return action()
  const draft = editor.draft
  const matches = editor.workspacePath === request.workspacePath && draft.kind === request.kind && draft.title === request.title && draft.content === request.content
    && (isObject(editor.entry) ? editor.entry.id : undefined) === ('id' in request ? request.id : undefined)
    && JSON.stringify(typeof draft.tags === 'string' ? draft.tags.split(',').map(tag => tag.trim()).filter(Boolean) : []) === JSON.stringify(request.tags ?? [])
    && (typeof draft.sourceRef === 'string' ? draft.sourceRef.trim() : '') === (request.attribution.sourceRef ?? '')
  return matches ? acknowledgeGuiDraft('memory-editor', 'editor', action) : action()
}
let mainWindow: BrowserWindow | null = null
let nativeTerminals: NativeTerminals | undefined
let browserViews: BrowserViews | undefined
let quitRequested = false
let allowQuit = false
let projectTools: ProjectDoctor | undefined
let projectLanguage: ProjectLanguageTools | undefined
let toolsClosed = false
let closingTools: Promise<void> | undefined
let daemonShutdownComplete = false
let closingDaemon: Promise<void> | undefined
const resolveRegisteredWorkspace = (path: string): Promise<string> => verifyWorktreePath(store, path)
const workspacePreview = new WorkspacePreview(resolveRegisteredWorkspace)

function send<K extends keyof MainEvents>(channel: K, payload: MainEvents[K]): void {
  mainWindow?.webContents.send(channel, payload)
}

/**
 * Renders one credential failure for the renderer. Only the typed authority
 * code and a bounded explanation cross the boundary: no ref, generation, path,
 * or ciphertext may appear in an error string the UI displays.
 */
function credentialFailure(error: unknown): Error {
  if (error instanceof SecretAuthorityError) return new Error(`${error.code}: ${error.message}`)
  return new Error(error instanceof Error ? error.message : 'Provider credential operation failed')
}

function publishSettings(settings: AppSettings): AppSettings {
  send('settings:changed', { settings })
  buildMenu()
  nativeTerminals?.configure()
  return settings
}

/** Route a menu/accelerator action to the renderer; the store decides what it does. */
function menuAction(action: string): void {
  getServices().analytics.trackUI(action)
  send('menu:action', { action })
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const commandItem = (id: AppCommandId): Electron.MenuItemConstructorOptions => {
    const command = appCommand(id)!
    return { label: command.label, accelerator: electronAccelerator(command, store.getSettings().keyboardShortcutOverrides), click: () => menuAction(id) }
  }
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
        commandItem('new-project'),
        commandItem('add-repo'),
        commandItem('quick-open'),
        commandItem('new-worktree'),
        { type: 'separator' },
        commandItem('close-active-pane'),
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
        commandItem('command-palette'),
        commandItem('new-terminal'),
        commandItem('split-terminal'),
        commandItem('toggle-explorer'),
        commandItem('toggle-git-status'),
        commandItem('show-project-memory'),
        commandItem('show-computer-control'),
        commandItem('show-editor-recovery'),
        commandItem('run-agent'),
        { type: 'separator' },
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
        commandItem('settings'),
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
const browserControl = async (cmd: BrowserCommand): Promise<unknown> => {
  if (cmd.op === 'eval') {
    const snapshot = await commandRouter.call('browser:command', { op: 'snapshot', key: cmd.key }) as { key: string }
    if (!browserViews) throw new Error('Browser views unavailable')
    return browserViews.evaluate(snapshot.key, cmd.js)
  }
  return commandRouter.call('browser:command', cmd)
}
const uiControl = (cmd: UiCommand): Promise<unknown> => commandRouter.call('ui:command', cmd)

function runtimeMetadata(): AppMeta {
  return {
    version: packageMetadata.version,
    shell: process.env.SHELL || '',
    userDataDir: app.getPath('userData'),
    memoryMcp: {
      command: process.execPath,
      args: [join(appResourcesRoot(), 'cli', 'donwells.mjs')],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    }
  }
}

function registerIpc(): void {
  const draftOwner = (event: Electron.IpcMainInvokeEvent) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('Draft recovery has no authorized window')
  }
  ipcMain.handle('guiDraftsRead', async event => { draftOwner(event); await Promise.allSettled([...pendingGuiSaves]); return [...guiDrafts] })
  ipcMain.handle('guiDraftsWrite', (event, name: unknown, entries: unknown) => {
    draftOwner(event)
    if (typeof name !== 'string' || !/^[a-z-]{1,64}$/.test(name) || typeof entries !== 'string' || Buffer.byteLength(entries) > 8 * 1024 * 1024) throw new Error('Draft recovery exceeds its supported size')
    const value: unknown = JSON.parse(entries)
    if (!Array.isArray(value) || value.length > 10000 || !value.every(row => Array.isArray(row) && row.length === 2 && typeof row[0] === 'string')) throw new Error('Invalid draft recovery entries')
    if (!guiDrafts.has(name) && guiDrafts.size >= 32) throw new Error('Too many draft recovery owners')
    guiDrafts.set(name, entries)
  })
  ipcMain.handle('agentConfigureMemory', async (_e, workspacePath: string, provider: string, launchArgs?: string[], replacement?: { action: 'preview' } | { action: 'apply'; revision: string }) => configureAgentMemory({
    files: git, workspacePath: await resolveRegisteredWorkspace(workspacePath), provider, launchArgs, replacement, userDataDir: app.getPath('userData'), executable: process.execPath,
    cliPath: join(appResourcesRoot(), 'cli', 'donwells.mjs')
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
    getServices().analytics.track('project:create', 'project', { repoId: summary.repo.id })
    return summary
  })

  ipcMain.handle('addRepo', async (_e, dir: string) => {
    const summary = await git.addRepo(dir)
    send('worktree:changed', { repoId: summary.repo.id })
    getServices().analytics.trackUI('repo:add', { repoId: summary.repo.id })
    return summary
  })

  ipcMain.handle('removeRepo', (_e, repoId: string) => {
    git.removeRepo(repoId)
    // RPC (or any client) may remove repos behind the renderer's back — let it prune.
    send('worktree:changed', { repoId })
    getServices().analytics.trackUI('repo:remove', { repoId })
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
    // A terminal inherits shell authority: the effective cwd must be inside a registered workspace.
    const effectiveCwd = cwd ?? worktreePath
    return terminalBus.open(await verifyWorkspaceDirectory(store, effectiveCwd), 100, 30)
  })

  ipcMain.handle('native-terminal:request', (event, request) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !nativeTerminals) throw new Error('Native terminal request has no authorized owner')
    return nativeTerminals.request(request)
  })

  ipcMain.handle('native-terminal:availability', (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('Native terminal availability has no authorized owner')
    return nativeTerminalAvailability()
  })

  ipcMain.handle('native-terminal:read', (event, sessionId) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !nativeTerminals) throw new Error('Native terminal read has no authorized owner')
    return nativeTerminals.read(String(sessionId))
  })

  ipcMain.handle('native-terminal:themes', (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('Native terminal themes have no authorized owner')
    return nativeTerminalThemes()
  })

  ipcMain.handle('herdr:snapshot', (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('Session request has no authorized owner')
    return readHerdrSnapshot()
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

  ipcMain.handle('terminalResize', async (_e, sessionId: string, cols: number, rows: number) => {
    await terminalBus.resize(sessionId, cols, rows)
    return true
  })

  ipcMain.handle('terminalInterrupt', (_e, sessionId: string) => {
    terminalBus.interrupt(sessionId)
    return true
  })
  ipcMain.handle('terminalSessions', () => terminalBus.list())

  ipcMain.handle('gitStatus', (_e, worktreePath: string) => git.status(worktreePath))
  // The scan attributes process and port ownership by path prefix, so the path
  // must be a registered workspace or inside one; an arbitrary renderer-supplied
  // directory would otherwise enumerate unrelated processes.
  ipcMain.handle('scanWorktree', async (_e, worktreePath: string) => scanWorktree(await verifyWorkspaceDirectory(store, worktreePath)))
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
  ipcMain.handle('listWorkspaceDirectory', (_e, ...args: Parameters<IpcApi['listWorkspaceDirectory']>) => git.listWorkspaceDirectory(...args))
  ipcMain.handle('searchWorkspaceFiles', (_e, ...args: Parameters<IpcApi['searchWorkspaceFiles']>) => git.searchWorkspaceFiles(...args))
  ipcMain.handle('createWorkspaceEntry', (_e, ...args: Parameters<IpcApi['createWorkspaceEntry']>) => git.createWorkspaceEntry(...args))
  ipcMain.handle('moveWorkspaceEntry', (_e, ...args: Parameters<IpcApi['moveWorkspaceEntry']>) => git.moveWorkspaceEntry(...args))
  ipcMain.handle('duplicateWorkspaceEntry', (_e, ...args: Parameters<IpcApi['duplicateWorkspaceEntry']>) => git.duplicateWorkspaceEntry(...args))
  ipcMain.handle('deleteWorkspaceEntry', (_e, ...args: Parameters<IpcApi['deleteWorkspaceEntry']>) => git.deleteWorkspaceEntry(...args, path => shell.trashItem(path)))
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
  ipcMain.handle('browserSiteDataClear', (_e, worktreePath: string) => {
    if (!browserViews) throw new Error('Browser is unavailable')
    return browserViews.clearSiteData(worktreePath)
  })

  ipcMain.handle('getWorkspaceSession', () => store.getWorkspaceSession())
  ipcMain.handle('saveWorkspaceSession', (_e, ws) => store.setWorkspaceSession(ws))

  ipcMain.handle('pickDirectory', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle('pickProjectKitPath', async (event, kind: unknown) => {
    if (kind !== 'export' && kind !== 'archive' && kind !== 'destination') throw new Error('Invalid project kit path kind')
    const win = BrowserWindow.fromWebContents(event.sender)
    if (kind === 'archive') {
      const options: Electron.OpenDialogOptions = { title: 'Choose project kit', properties: ['openFile'], filters: [{ name: 'Project kit', extensions: ['json'] }] }
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      return result.canceled ? null : result.filePaths[0] ?? null
    }
    const options: Electron.SaveDialogOptions = { title: kind === 'export' ? 'Save project kit' : 'Choose new project destination', defaultPath: kind === 'export' ? 'project.donwells-kit.json' : 'restored-project', properties: ['createDirectory'] }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    return result.canceled ? null : result.filePath ?? null
  })

  ipcMain.handle('listAgents', () => agentRuntime.listAgents())
  ipcMain.handle('agentNativeOpen', (_e, ...args: Parameters<IpcApi['agentNativeOpen']>) => agentRuntime.openNative(...args))
  ipcMain.handle('agentList', () => agentRuntime.list())
  ipcMain.handle('agentSwitchMode', (_e, ...args: Parameters<IpcApi['agentSwitchMode']>) => agentRuntime.switchMode(...args))
  ipcMain.handle('agentSwitchResult', (_e, ...args: Parameters<IpcApi['agentSwitchResult']>) => agentRuntime.modeSwitchResult(...args))
  ipcMain.handle('agentAcpStart', (_e, ...args: Parameters<IpcApi['agentAcpStart']>) => agentRuntime.startAcp(...args))
  ipcMain.handle('agentAcpList', (_e, ...args: Parameters<IpcApi['agentAcpList']>) => agentRuntime.listAcp(...args))
  ipcMain.handle('agentAcpObserve', (_e, ...args: Parameters<IpcApi['agentAcpObserve']>) => agentRuntime.observeAcp(...args))
  ipcMain.handle('agentAcpPrompt', (_e, ...args: Parameters<IpcApi['agentAcpPrompt']>) => agentRuntime.promptAcp(...args))
  ipcMain.handle('agentAcpControl', (_e, ...args: Parameters<IpcApi['agentAcpControl']>) => agentRuntime.controlAcp(...args))
  ipcMain.handle('agentStop', (_e, sessionId: string) => agentRuntime.stop(sessionId))
  ipcMain.handle('agentDismiss', (_e, sessionId: string) => agentRuntime.dismiss(sessionId))
  ipcMain.handle('agentDeliver', (_e, request: Parameters<IpcApi['agentDeliver']>[0]) => deliverAgentAttachment(agentRuntime, terminalBus, resolveRegisteredWorkspace, request))

  ipcMain.handle('revealWorkspaceEntry', async (_event, workspacePath: string, relPath: string) => {
    const root = await resolveRegisteredWorkspace(workspacePath)
    const target = relPath === '' ? root : (await resolveExistingEntry(root, relPath)).abs
    shell.showItemInFolder(target)
  })
  ipcMain.handle('workspacePreviewUrl', (_event, workspacePath: string, relPath: string) => workspacePreview.url(workspacePath, relPath))

  ipcMain.handle('openExternal', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return true
  })

  ipcMain.on('browser:router-ready', (event) => commandRouter.ready('browser:command', event.sender))
  ipcMain.on('ui:router-ready', (event) => commandRouter.ready('ui:command', event.sender))
  ipcMain.on('browser:command:result', (event, id: string, result) => commandRouter.resolve('browser:command', id, result, event.sender))
  // --- Plugin system: IPC handlers ---
  ipcMain.handle('plugin:list', () => getServices().pluginLoader.list())
  ipcMain.handle('plugin:enable', (_e, pluginId: string) => getServices().pluginLoader.enable(pluginId))
  ipcMain.handle('plugin:disable', (_e, pluginId: string) => getServices().pluginLoader.disable(pluginId))
  ipcMain.handle('plugin:install', (_e, sourceDirPath: string) => getServices().pluginLoader.install(sourceDirPath))
  ipcMain.handle('plugin:remove', (_e, pluginId: string) => getServices().pluginLoader.remove(pluginId))

  // --- Session Templates IPC ---
  ipcMain.handle('sessionTemplate:list', () => {
    const { sessionTemplates } = getServices()
    return sessionTemplates.getAll()
  })

  // --- Autonomous Agent IPC ---
  // Gated autonomous actions awaiting the user's Allow/Deny decision (R2.3).
  const pendingAutonomousActions = new Map<string, (approved: boolean) => void>()

  ipcMain.handle('autonomous:start', async (_e, goal: string, job?: { workspacePath: string; command: string }) => {
    if (!job || !job.workspacePath || !job.command) {
      throw new Error('Autonomous run requires a registered workspace and agent command')
    }
    const workspacePath = await resolveRegisteredWorkspace(job.workspacePath)
    const { autonomousAgent } = getServices()
    const result = await autonomousAgent.run(
      goal,
      async (action) => {
        if (action.type !== 'shell') {
          return `unsupported action type: ${action.type}`
        }
        if (!action.approved) {
          const actionId = `act-${randomUUID()}`
          const approved = await new Promise<boolean>((resolve) => {
            let settled = false
            let timer: ReturnType<typeof setTimeout>
            const finish = (value: boolean): void => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              pendingAutonomousActions.delete(actionId)
              resolve(value)
            }
            timer = setTimeout(() => finish(false), 120_000)
            pendingAutonomousActions.set(actionId, finish)
            send('autonomous:action-request', {
              actionId,
              type: action.type,
              description: action.description
            })
          })
          if (!approved) {
            return 'not approved'
          }
          action.approved = true
        }
        const command = String(action.params.command ?? action.description)
        try {
          const outcome = await executeJobCommand(terminalBus, workspacePath, command)
          return `executed (exit ${outcome.exitCode ?? 'unknown'}): ${outcome.output.trim().slice(0, 400)}`
        } catch (error) {
          return `execution failed: ${error instanceof Error ? error.message : String(error)}`
        }
      },
      { workspacePath, command: job.command, runner: createDaemonJobRunner(terminalBus) }
    )
    return {
      success: result.success,
      finalResult: result.finalResult,
      iterations: result.iterations.length,
      totalTokens: result.totalTokens,
      totalDurationMs: result.totalDurationMs,
      stoppedReason: result.stoppedReason,
    }
  })
  ipcMain.handle('autonomous:stop', () => {
    const { autonomousAgent } = getServices()
    autonomousAgent.stop()
  })
  ipcMain.handle('autonomous:state', () => {
    const { autonomousAgent } = getServices()
    return autonomousAgent.getState()
  })

  ipcMain.handle('autonomous:action-decision', (_e, actionId: string, approved: boolean) => {
    const finish = pendingAutonomousActions.get(actionId)
    if (!finish) return false
    finish(approved === true)
    return true
  })

  // Autonomous iterations are durable evidence for replay (R4.1). Registered
  // once here — this handler setup runs a single time on app startup.
  getServices().autonomousAgent.on('iteration', (iteration) => {
    const es = getServices().eventStore
    void es
      .append({
        id: `autonomous-${iteration.index}-${Date.now()}`,
        type: 'autonomous:iteration',
        aggregateId: 'autonomous-run',
        aggregateType: 'autonomous',
        timestamp: Date.now(),
        version: iteration.index + 1,
        payload: {
          goalAchieved: iteration.goalAchieved === true,
          error: iteration.error?.slice(0, 2000)
        }
      })
      .catch((err) => logger.error({ err }, 'event-store: autonomous iteration append failed'))
  })

  // --- Perf & Analytics IPC handlers (registered ONCE above, lines 550-570) ---
  ipcMain.on('ui:command:result', (event, id: string, result) => commandRouter.resolve('ui:command', id, result, event.sender))

  // --- Event Store IPC (session replay) ---
  ipcMain.handle('events:query', (_e, filter: { sessionId?: string; type?: string; since?: number }) => {
    const es = getServices().eventStore
    return es.query(filter)
  })
  // --- Perf & Analytics IPC ---
  ipcMain.handle('perf:getStats', () => getPerfStats())
}

// Wrap ipcMain.handle to auto-time every IPC call for perf monitoring
const originalIpcHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
  return originalIpcHandle(channel, async (event, ...args) => {
    const finish = startIpcTimer(channel)
    try {
      // Await so async handlers measure completion, not dispatch overhead.
      return await listener(event, ...args)
    } finally {
      finish()
    }
  })
}

// --- Debug HTTP server (localhost only) ---
let perfServer: ReturnType<typeof createServer> | null = null

function startPerfServer(): void {
  if (perfServer) return
  if (app.isPackaged && !process.env['DONWELLS_PERF_SERVER']) return

  perfServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)

    if (url.pathname === '/api/perf') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      })
      res.end(JSON.stringify(getPerfStats()))
      return
    }

    if (url.pathname === '/api/analytics/status') {
      const collector = getServices().analytics
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ enabled: collector.isEnabled(), pending: collector.pendingCount }))
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })

  perfServer.listen(0, '127.0.0.1', () => {
    const addr = perfServer?.address()
    if (addr && typeof addr !== 'string') {
      logger.info({ port: addr.port }, 'perf-server: listening')
    }
  })
}

function createWindow(): void {
  const saved = store.getWindowState()
  const { workArea } = saved ? screen.getDisplayMatching(saved) : screen.getPrimaryDisplay()
  mainWindow = new BrowserWindow({
    show: process.env['DONWELLS_SMOKE'] !== '1',
    ...restoreWindowBounds(saved, workArea),
    minWidth: Math.min(900, workArea.width),
    minHeight: Math.min(600, workArea.height),
    title: 'donwells.ai',
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  const window = mainWindow
  if (saved?.maximized && process.env['DONWELLS_SMOKE'] !== '1') window.maximize()
  commandRouter.bind(window.webContents)
  browserViews = new BrowserViews(window, resolveRegisteredWorkspace, (key, url) => workspacePreview.resolveUrl(key, url))
  nativeTerminals = new NativeTerminals(window, terminalBus, () => store.getSettings())
  // Documents may open content, never replace the privileged application renderer.
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) commandRouter.reset(new Error('Renderer reloaded before the command finished'), true)
  })
  let rendererRecoveryAttempted = false
  window.webContents.on('render-process-gone', (_event, details) => {
    commandRouter.reset(new Error('Renderer process exited before the command finished'))
    // ponytail: one automatic recovery per window prevents a crash loop; further failures require reopening the window.
    if (!quitRequested && details.reason !== 'clean-exit' && !rendererRecoveryAttempted && !window.isDestroyed()) {
      rendererRecoveryAttempted = true
      window.webContents.reload()
    }
  })
  let closing = false
  let allowClose = false
  window.on('close', (event) => {
    if (allowClose || !commandRouter.isReady('ui:command')) return
    event.preventDefault()
    if (closing) return
    closing = true
    void (async () => {
      try {
        store.setWindowState({ ...window.getNormalBounds(), maximized: window.isMaximized() })
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

void app.whenReady().then(async () => {
  getServices().analytics.track('app:ready', 'app')
  store = new Store()
  browserHistory = new BrowserHistoryStore(app.getPath('userData'), undefined, undefined, () => store.getSettings().recordBrowserHistory)
  ipcMain.handle('browser:view', (event, request) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !browserViews) throw new Error('Browser request has no authorized owner')
    return browserViews.request(request)
  })
  git = new GitWorktrees(store)
  git.setTrashRoot(join(app.getPath('userData'), 'trash'))
  // Daemon owns the PTYs: spawn-if-needed (detached), never killed on app exit —
  // running agents survive app restarts; scrollback replays on reattach.
  terminalBus = new DaemonClient(
    app.getPath('userData'),
    {
      disconnected: () => {
        nativeTerminals?.disconnect()
        send('terminal:disconnected', {})
        for (const run of agentRuntime.connectionLost()) send('agent:changed', { run })
      },
      data: (sessionId, data, sequence) => {
        nativeTerminals?.data(sessionId, data, sequence)
        send('terminal:data', { sessionId, data, sequence })
        void operationalRuns?.onDaemonEvent('data', sessionId, data).catch((error) => logger.error({ err: error }, 'Run output persistence failed'))
      },
      exit: (sessionId, exitCode) => {
        nativeTerminals?.exited(sessionId)
        send('terminal:exit', { sessionId, exitCode })
        void operationalRuns?.onDaemonEvent('exit', sessionId, '', exitCode).catch((error) => logger.error({ err: error, sessionId, exitCode }, 'Run completion persistence failed'))
      },
      title: (sessionId, title) => send('terminal:title', { sessionId, title }),
      agent: (run) => {
        agentRuntime.observe(run)
        send('agent:changed', { run })
        // Record agent:start event
        const es = getServices().eventStore
        void es.append({
          id: `${run.sessionId}:start`,
          type: 'agent:start',
          aggregateId: run.sessionId,
          aggregateType: 'agent',
          timestamp: Date.now(),
          version: 1,
          payload: { command: run.command, workspace: run.workspacePath, intent: run.task?.intent }
        }).catch((err: Error) => logger.error({ err }, 'event-store: failed to record start'))
      },
      agentDismissed: (sessionId) => {
        agentRuntime.observeDismissed(sessionId)
        send('agent:dismissed', { sessionId })
        // Record agent:complete event
        const es = getServices().eventStore
        void es.append({
          id: `${sessionId}:complete`,
          type: 'agent:complete',
          aggregateId: sessionId,
          aggregateType: 'agent',
          timestamp: Date.now(),
          version: 1,
          payload: { sessionId }
        }).catch((err: Error) => logger.error({ err }, 'event-store: failed to record complete'))
      }
    },
    join(__dirname, 'terminal-daemon-entry.js')
  )
  const projectTasks = new ProjectTaskCoordination(store, terminalBus, async path => {
    if (!projectTools) throw new Error('Project tools are not ready')
    const config = await projectTools.configuration(path)
    return config.disabled.includes('backlog') ? undefined : config.backlogBinary
  })
  agentRuntime = new AgentRuntime(terminalBus, {
    nativeMcpArgs: async (workspacePath, provider, args) => {
      if (args.some(arg => arg.includes('donwells-project-memory'))) return []
      const setup = await configureAgentMemory({ files: git, workspacePath, provider, userDataDir: app.getPath('userData'), executable: process.execPath, cliPath: join(appResourcesRoot(), 'cli', 'donwells.mjs') })
      return setup.launchArgs ?? []
    },
    acpMcpServers: async workspacePath => {
      const meta = runtimeMetadata(), mcp = meta.memoryMcp
      if (!mcp) throw new Error('Project memory MCP launcher is unavailable')
      return [{ name: 'donwells-project-memory', command: mcp.command, args: [...mcp.args, 'memory-mcp', '--workspace', workspacePath, '--harness', 'opencode', '--user-data', meta.userDataDir], env: Object.entries(mcp.env).map(([name, value]) => ({ name, value })) }]
    },
    registeredWorkspaces: async () => (await git.listAll()).flatMap<AgentWorkspaceRegistration>((summary) => [
      { path: summary.repo.path, host: { kind: 'local' } },
      ...summary.worktrees.map<AgentWorkspaceRegistration>((worktree) => ({ path: worktree.path, host: { kind: 'local' } }))
    ])
  })
  /**
   * Driver-owned launch arguments for one provider instance.
   *
   * The project-memory MCP patch is part of a driver's argument policy for
   * codex and claude, which take it on the command line and write no config file:
   * without it their launches silently lose project memory. It is computed here
   * because it needs workspace and app paths the daemon does not have, and it is
   * keyed on the instance's driver identity — never on a command string or a
   * filename. Any failure degrades to no arguments rather than blocking a launch.
   */
  const providerDriverLaunchArguments = async (workspacePath: string, providerInstanceId: string): Promise<readonly string[]> => {
    try {
      const snapshot = await terminalBus.providerCatalogSnapshot()
      const instance = snapshot.instances.find(candidate => candidate.id === providerInstanceId)
      const driver = instance?.driver
      if (driver === undefined || driver.kind !== 'known') return []
      if (!['codex', 'claude'].includes(driver.id)) return []
      const launch = instance?.command
      if (launch?.kind !== 'driver') return []
      const setup = await configureAgentMemory({
        files: git, workspacePath, provider: driver.id, userDataDir: app.getPath('userData'),
        executable: process.execPath, cliPath: join(appResourcesRoot(), 'cli', 'donwells.mjs')
      })
      return setup.launchArgs ?? []
    } catch (error) {
      logger.warn({ err: error, providerInstanceId }, 'provider launch without driver arguments')
      return []
    }
  }

  ipcMain.handle('projectTasksInspect', (_e, path: string) => projectTasks.inspect(path))
  /**
   * The detached daemon cannot read this process's repository registry, so the
   * migration's exact project set is handed over as one private identity file
   * (project, repository, canonical workspace root — never task content).
   */
  const publishProjectRegistry = (): void => {
    try {
      publishRegisteredProjects(app.getPath('userData'), store.listRepos()
        .filter(repo => repo.taskAuthority === 'backlog.md')
        .map(repo => ({ projectId: repo.id, repositoryId: repo.id, workspaceRoot: repo.path })))
    } catch (error) {
      logger.warn({ err: error }, 'could not publish the migration project registry')
    }
  }
  publishProjectRegistry()
  ipcMain.handle('projectTaskAuthority', async (_e, path: string, enabled: boolean) => {
    const result = await projectTasks.setAuthority(path, enabled)
    publishProjectRegistry()
    return result
  })
  ipcMain.handle('projectTaskTool', (_e, path: string, tool: 'lazygit' | 'backlog') => projectTasks.openTool(path, tool))
  operationalRuns = new OperationalRunService(
    app.getPath('userData'),
    terminalBus,
    resolveRegisteredWorkspace,
    {
      source: path => git.handoffSource(path),
      openArtifact: (path, workspacePath, sha256) => openVerificationArtifact(path, workspacePath, sha256, (worktreePath, relPath) => uiControl({ op: 'editor.open', worktreePath, relPath }), path => shell.openPath(path)),
      artifactRoots: async path => {
        const scope = await resolveProjectToolScope(path, async candidate => resolveRegisteredProjectWorkspace(store, candidate))
        return [scope.checkoutPath, join(app.getPath('userData'), 'project-tools', 'browser', scope.indexKey)]
      }
    },
    async path => (await resolveRegisteredProjectWorkspace(store, path)).projectId
  )

  try {
    await terminalBus.connect()
  } catch (error) {
    logger.fatal({ err: error }, 'terminal daemon connect failed')
    app.exit(1)
    return
  }
  registerTaskAuthorityCapability(terminalBus)
  registerIpc()
  buildMenu()
  // macOS can emit activate before app.whenReady() initialization finishes.
  // Register only after createWindow's dependencies are fully assigned; the
  // initial startup path below creates the first window independently.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  createWindow()
  startPerfServer()
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
  // The renderer has no raw secret surface. Credential material is reachable
  // only through the action-specific provider methods below, which return a
  // sanitized Catalog projection plus a CredentialStatus.
  graphitiSecrets = new SecretStore(app.getPath('userData'))
  const credentialCatalog = terminalBus.providerCredentialCatalog()
  providerCredentials = new ProviderCredentialAuthority({
    catalog: credentialCatalog,
    authority: new ProviderSecretAuthority({ userDataDir: app.getPath('userData') })
  })
  // Startup reconciliation runs before any credential handler registers, so an
  // interrupted saga is settled before the UI can observe or extend it.
  const reconciliation = await providerCredentials.reconcile()
  if (reconciliation.blocked.length) logger.warn({ operations: reconciliation.blocked }, 'credential operations require explicit recovery')
  // Credential handlers authorize the exact main window and frame, exactly like
  // draft recovery and native terminals: a guest view cannot reach them.
  const credentialOwner = (event: Electron.IpcMainInvokeEvent) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('Provider credential request has no authorized owner')
  }
  ipcMain.handle('providerCredentialWrite', async (event, request: unknown) => {
    credentialOwner(event)
    if (!providerCredentials) throw new Error('Provider credential authority is unavailable')
    return providerCredentials.write(parseProviderCredentialWriteRequest(request))
      .catch(error => { throw credentialFailure(error) })
  })
  ipcMain.handle('providerCredentialStatus', async (event, request: unknown) => {
    credentialOwner(event)
    if (!providerCredentials) throw new Error('Provider credential authority is unavailable')
    return providerCredentials.status(parseProviderCredentialStatusRequest(request))
  })
  ipcMain.handle('providerCredentialRevoke', async (event, request: unknown) => {
    credentialOwner(event)
    if (!providerCredentials) throw new Error('Provider credential authority is unavailable')
    return providerCredentials.revoke(parseProviderCredentialRevokeRequest(request))
      .catch(error => { throw credentialFailure(error) })
  })
  ipcMain.handle('providerCatalogRead', (event) => {
    credentialOwner(event)
    return terminalBus.providerCatalogSnapshot()
  })
  ipcMain.handle('providerCatalogCreate', async (event, input: Parameters<DaemonClient['providerCatalogCreate']>[0]) => {
    credentialOwner(event)
    return terminalBus.providerCatalogCreate(input)
  })
  ipcMain.handle('providerCatalogUpdate', async (event, instanceId: string, expectedRevision: number, input: Parameters<DaemonClient['providerCatalogUpdate']>[2]) => {
    credentialOwner(event)
    return terminalBus.providerCatalogUpdate(instanceId, expectedRevision, input)
  })
  ipcMain.handle('providerCatalogRemove', async (event, instanceId: string, expectedRevision: number) => {
    credentialOwner(event)
    return terminalBus.providerCatalogRemove(instanceId, expectedRevision)
  })
  ipcMain.handle('providerCatalogSetDefault', async (event, instanceId: string | null, expectedRevision: number) => {
    credentialOwner(event)
    return terminalBus.providerCatalogSetDefault(instanceId, expectedRevision)
  })
  ipcMain.handle('providerInstanceLaunch', async (event, workspacePath: string, providerInstanceId: string, task?: Parameters<DaemonClient['providerInstanceLaunch']>[2]) => {
    credentialOwner(event)
    const workspace = await resolveRegisteredProjectWorkspace(store, workspacePath)
    // Driver-owned launch arguments are computed here, in the trusted main
    // process, because the project-memory patch needs workspace and app paths the
    // daemon does not have. They are derived from the instance's own driver
    // identity — never from a command string — and the renderer supplies neither.
    const driverArguments = await providerDriverLaunchArguments(workspace.path, providerInstanceId)
    return terminalBus.providerInstanceLaunch(workspace.path, providerInstanceId, task, driverArguments)
  })

  void operationalRuns.resume().catch((error) => logger.error({ err: error }, 'Run recovery failed'))
  ipcMain.handle('scheduledRunsList', () => operationalRuns.scheduledRunsList())
  ipcMain.handle('scheduledRunSave', (_e, ...args: Parameters<IpcApi['scheduledRunSave']>) => acknowledgeGuiDraft('scheduled-composer', 'draft', () => operationalRuns.scheduledRunSave(...args)))
  ipcMain.handle('scheduledRunSetEnabled', (_e, ...args: Parameters<IpcApi['scheduledRunSetEnabled']>) => operationalRuns.scheduledRunSetEnabled(...args))
  ipcMain.handle('scheduledRunDuplicate', (_e, id: string) => operationalRuns.scheduledRunDuplicate(id))
  ipcMain.handle('scheduledRunDelete', (_e, id: string) => operationalRuns.scheduledRunDelete(id))
  ipcMain.handle('scheduledRunRunNow', (_e, id: string) => operationalRuns.scheduledRunRunNow(id))
  ipcMain.handle('scheduledRunCancel', (_e, id: string) => operationalRuns.scheduledRunCancel(id))
  ipcMain.handle('scheduledRunHistory', (_e, id: string) => operationalRuns.scheduledRunHistory(id))
  ipcMain.handle('verificationScripts', (_e, ...args: Parameters<IpcApi['verificationScripts']>) => operationalRuns.verificationScripts(...args))
  ipcMain.handle('verificationRun', (_e, ...args: Parameters<IpcApi['verificationRun']>) => operationalRuns.verificationRun(...args))
  ipcMain.handle('verificationList', (_e, ...args: Parameters<IpcApi['verificationList']>) => operationalRuns.verificationList(...args))
  ipcMain.handle('verificationOpen', (_e, ...args: Parameters<IpcApi['verificationOpen']>) => operationalRuns.verificationOpen(...args))
  ipcMain.handle('verificationAttach', (_e, ...args: Parameters<IpcApi['verificationAttach']>) => operationalRuns.verificationAttach(...args))
  ipcMain.handle('parallelRunsList', () => operationalRuns.parallelRunsList())
  ipcMain.handle('parallelRunStart', (_e, ...args: Parameters<IpcApi['parallelRunStart']>) => acknowledgeGuiDraft('parallel-composer', 'draft', () => operationalRuns.parallelRunStart(...args)))
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
  const diffReview = new DiffReviewService(app.getPath('userData'), { resolveWorkspace: resolveRegisteredWorkspace, runs: path => operationalRuns.verificationReviewRuns(path) })
  ipcMain.handle('diffReviewList', (_e, ...args: Parameters<IpcApi['diffReviewList']>) => diffReview.list(...args))
  ipcMain.handle('diffReviewCreate', (_e, ...args: Parameters<IpcApi['diffReviewCreate']>) => diffReview.create(...args))
  ipcMain.handle('diffReviewUpdate', (_e, ...args: Parameters<IpcApi['diffReviewUpdate']>) => diffReview.update(...args))
  ipcMain.handle('diffReviewDelete', (_e, ...args: Parameters<IpcApi['diffReviewDelete']>) => diffReview.remove(...args))
  const resolveToolWorkspace = (path: string) => resolveRegisteredProjectWorkspace(store, path)
  projectLanguage = new ProjectLanguageTools(async path => { const scope=await resolveProjectToolScope(path,resolveToolWorkspace);return {checkoutPath:scope.checkoutPath,indexKey:scope.indexKey} })
  ipcMain.handle('projectLanguageStatus', (_e, ...args: Parameters<IpcApi['projectLanguageStatus']>) => projectLanguage!.inspect(...args))
  ipcMain.handle('projectLanguageStop', (_e, ...args: Parameters<IpcApi['projectLanguageStop']>) => projectLanguage!.stopProject(...args))
  ipcMain.handle('projectLanguageOpen', (_e, ...args: Parameters<IpcApi['projectLanguageOpen']>) => projectLanguage!.open(...args))
  ipcMain.handle('projectLanguageChange', (_e, ...args: Parameters<IpcApi['projectLanguageChange']>) => projectLanguage!.change(...args))
  ipcMain.handle('projectLanguageClose', (_e, ...args: Parameters<IpcApi['projectLanguageClose']>) => projectLanguage!.closeDocument(...args))
  ipcMain.handle('projectLanguageDiagnostics', (_e, ...args: Parameters<IpcApi['projectLanguageDiagnostics']>) => projectLanguage!.diagnostics(...args))
  ipcMain.handle('projectLanguageDefinition', (_e, ...args: Parameters<IpcApi['projectLanguageDefinition']>) => projectLanguage!.definition(...args))
  ipcMain.handle('projectLanguageReferences', (_e, ...args: Parameters<IpcApi['projectLanguageReferences']>) => projectLanguage!.references(...args))
  ipcMain.handle('projectLanguageRestart', (_e, ...args: Parameters<IpcApi['projectLanguageRestart']>) => projectLanguage!.restart(...args))
  const sessionHistory = {
    analytics: (path: string, options?: import('@shared/project-session-history').SessionAnalyticsOptions) => projectTools!.historyAnalytics(path, options),
    cancelAnalytics: (path: string, requestId: string) => projectTools!.historyAnalyticsCancel(path, requestId),
    analyticsProgress: (path: string, requestId: string) => projectTools!.historyAnalyticsProgress(path, requestId),
    index: (path: string) => projectTools!.historyIndex(path),
    search: (path: string, query: string, requestId?: string) => projectTools!.historySearch(path, query, requestId),
    cancelSearch: (path: string, requestId: string) => projectTools!.historySearchCancel(path, requestId),
    get: (path: string, id: string, page?: import('@shared/project-session-history').SessionHistoryPage) => projectTools!.historyGet(path, id, page)
  }
  ipcMain.handle('projectSessionHistoryIndex', (_e, path: string) => sessionHistory.index(path))
  ipcMain.handle('projectSessionHistoryAnalytics', (_e, ...args: Parameters<IpcApi['projectSessionHistoryAnalytics']>) => sessionHistory.analytics(...args))
  ipcMain.handle('projectSessionHistoryAnalyticsCancel', (_e, ...args: Parameters<IpcApi['projectSessionHistoryAnalyticsCancel']>) => sessionHistory.cancelAnalytics(...args))
  ipcMain.handle('projectSessionHistoryAnalyticsProgress', (_e, ...args: Parameters<IpcApi['projectSessionHistoryAnalyticsProgress']>) => sessionHistory.analyticsProgress(...args))
  ipcMain.handle('projectSessionHistorySearch', (_e, ...args: Parameters<IpcApi['projectSessionHistorySearch']>) => sessionHistory.search(...args))
  ipcMain.handle('projectSessionHistorySearchCancel', (_e, ...args: Parameters<IpcApi['projectSessionHistorySearchCancel']>) => sessionHistory.cancelSearch(...args))
  ipcMain.handle('projectSessionHistoryGet', (_e, ...args: Parameters<IpcApi['projectSessionHistoryGet']>) => sessionHistory.get(...args))
  const toolDiscovery = new AgentRegistry()
  const bundledHistory = join(app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources'), 'native/history/agentsview')
  projectTools = new ProjectDoctor(join(app.getPath('userData'), 'project-tools', 'configuration'), resolveToolWorkspace, projectPath => parseProjectToolConfiguration({
    codeGraphBinary: process.env['DONWELLS_CODE_GRAPH_BINARY'] ?? toolDiscovery.findExecutable('codebase-memory-mcp'),
    historyBinary: process.env['DONWELLS_HISTORY_BINARY'] ?? (process.platform === 'darwin' && process.arch === 'arm64' && existsSync(bundledHistory) ? bundledHistory : toolDiscovery.findExecutable('agentsview')),
    duckdbPython: process.env['DONWELLS_DUCKDB_PYTHON'],
    backlogBinary: process.env['DONWELLS_BACKLOG_BINARY'] ?? toolDiscovery.findExecutable('backlog'),
    historyOmpRoots: JSON.parse(process.env['DONWELLS_HISTORY_ROOTS'] || '{}').omp,
    historyDshRoots: JSON.parse(process.env['DONWELLS_HISTORY_ROOTS'] || '{}')['deepseek-harness'],
    historyHermesRoots: JSON.parse(process.env['DONWELLS_HISTORY_ROOTS'] || '{}').hermes,
    historyKimiRoots: JSON.parse(process.env['DONWELLS_HISTORY_ROOTS'] || '{}').kimi,
    qmdPackage: process.env['DONWELLS_DOCUMENT_QMD_PACKAGE'],
    lancePackage: process.env['DONWELLS_DOCUMENT_LANCE_PACKAGE'],
    browserPackage: process.env['DONWELLS_BROWSER_TOOL_PACKAGE'],
    browserExecutable: process.env['DONWELLS_BROWSER_TOOL_EXECUTABLE'],
    computerBinary: process.env['DONWELLS_COMPUTER_TOOL_BINARY'] ?? toolDiscovery.findExecutable('cua-driver'),
    embeddingModel: process.env['DONWELLS_DOCUMENT_EMBEDDING_MODEL'],
    rerankingModel: process.env['DONWELLS_DOCUMENT_RERANKING_MODEL'],
    referenceRoots: JSON.parse(process.env['DONWELLS_DOCUMENT_REFERENCES'] || '{}')[projectPath] ?? [],
    disabled: []
  }), (config, projectPath) => [
    ...(config.computerBinary ? [createComputerToolDefinition(config.computerBinary, app.isPackaged ? 'ai.donwells.desktop' : 'com.github.Electron')] : []),
    ...(config.browserPackage && config.browserExecutable ? [createBrowserToolDefinition({ packagePath: config.browserPackage, browser: config.browserExecutable, cache: join(app.getPath('userData'), 'project-tools', 'browser'), program: process.execPath, target: path => { if (!browserViews) throw new Error('Browser previews unavailable'); return browserViews.target(path) } })] : []),
    ...(config.codeGraphBinary ? [createCodeGraphDefinition(config.codeGraphBinary, join(app.getPath('userData'), 'project-tools', 'code-graph'), path => git.handoffSource(path))] : []),
    ...(config.qmdPackage && config.lancePackage ? [createDocumentDefinition({ program: process.execPath, worker: join(__dirname, 'project-document-worker.js'), cache: join(app.getPath('userData'), 'project-tools', 'documents'), qmdPackage: config.qmdPackage, lancePackage: config.lancePackage, retrievalMode: config.documentRetrievalMode, embeddingModel: config.embeddingModel, rerankingModel: config.rerankingModel, references: JSON.stringify({ [projectPath]: config.referenceRoots }) })] : [])
  ], join(app.getPath('userData'), 'project-tools', 'history'), { profile: app.getPath('userData'), graphitiPassword: key => graphitiSecrets?.get(`graphiti:${key}:neo4j`) ?? null, handoff: (path, id) => handoffs.projectHandoffGet(path, id) })
  ipcMain.handle('projectTemporalKnowledgePasswordSet', async (_e, path: string, password: string) => {
    if (typeof password !== 'string' || !password.length || password.length > 4096 || /[\x00-\x1f\x7f]/.test(password)) throw new Error('Enter a valid database password')
    const scope = await resolveProjectToolScope(path, resolveToolWorkspace)
    if (!graphitiSecrets) throw new Error('Credential storage is unavailable')
    await projectTools!.temporalKnowledgeStop(path)
    graphitiSecrets.set(`graphiti:${scope.projectKey}:neo4j`, password)
  })
  ipcMain.handle('projectTemporalKnowledgeStatus', (_e, ...args: Parameters<IpcApi['projectTemporalKnowledgeStatus']>) => projectTools!.temporalKnowledgeStatus(...args))
  ipcMain.handle('projectTemporalKnowledgeReconcile', (_e, ...args: Parameters<IpcApi['projectTemporalKnowledgeReconcile']>) => projectTools!.temporalKnowledgeReconcile(...args))
  ipcMain.handle('projectTemporalKnowledgeQuery', (_e, ...args: Parameters<IpcApi['projectTemporalKnowledgeQuery']>) => projectTools!.temporalKnowledgeQuery(...args))
  ipcMain.handle('projectTemporalKnowledgeStop', (_e, ...args: Parameters<IpcApi['projectTemporalKnowledgeStop']>) => projectTools!.temporalKnowledgeStop(...args))
  ipcMain.handle('projectKnowledgeStatus', (_e, ...args: Parameters<IpcApi['projectKnowledgeStatus']>) => projectTools!.knowledgeStatus(...args))
  ipcMain.handle('projectKnowledgeReconcile', (_e, ...args: Parameters<IpcApi['projectKnowledgeReconcile']>) => projectTools!.knowledgeReconcile(...args))
  ipcMain.handle('projectKnowledgeRecall', (_e, ...args: Parameters<IpcApi['projectKnowledgeRecall']>) => projectTools!.knowledgeRecall(...args))
  ipcMain.handle('projectKnowledgeReflect', (_e, ...args: Parameters<IpcApi['projectKnowledgeReflect']>) => projectTools!.knowledgeReflect(...args))
  ipcMain.handle('projectKnowledgeStop', (_e, ...args: Parameters<IpcApi['projectKnowledgeStop']>) => projectTools!.knowledgeStop(...args))
  ipcMain.handle('projectDoctorPreviewBackup', (_e, path: string, name: string) => projectTools!.previewBackup(path, name))
  ipcMain.handle('projectDoctorInspect', (_e, path: string) => projectTools!.inspect(path))
  ipcMain.handle('projectBrowserArtifactReveal', async (_e, workspacePath: string, path: string, sha256: string) => {
    const scope = await resolveProjectToolScope(workspacePath, resolveToolWorkspace)
    const artifact = await hashVerificationArtifact(path, [join(app.getPath('userData'), 'project-tools', 'browser', scope.indexKey)])
    if (artifact.sha256 !== sha256) throw new Error('Artifact changed; take a new screenshot before revealing it')
    shell.showItemInFolder(artifact.path)
  })
  ipcMain.handle('projectDoctorSetup', (_e, path: string, field: string, revision: string | null) => projectTools!.setup(path, field, revision))
  ipcMain.handle('projectDoctorConfigure', (_e, path: string, config: unknown, revision: string | null) => projectTools!.configure(path, config, revision))
  ipcMain.handle('projectDoctorRetry', (_e, path: string, id: string) => projectTools!.retry(path, id))
  ipcMain.handle('projectToolsList', (_e, ...args: Parameters<IpcApi['projectToolsList']>) => projectTools!.list(...args))
  ipcMain.handle('projectToolCall', (_e, ...args: Parameters<IpcApi['projectToolCall']>) => projectTools!.call(...args))
  ipcMain.handle('projectToolStop', (_e, ...args: Parameters<IpcApi['projectToolStop']>) => projectTools!.stop(...args))
  const handoffs = new ProjectHandoffService(app.getPath('userData'), path => resolveProjectToolScope(path, resolveToolWorkspace), git, agentRuntime, request => deliverAgentAttachment(agentRuntime, terminalBus, resolveRegisteredWorkspace, request))
  ipcMain.handle('projectHandoffDispatch', (_e, ...args: Parameters<IpcApi['projectHandoffDispatch']>) => handoffs.projectHandoffDispatch(...args))
  ipcMain.handle('projectHandoffExport', (_e, ...args: Parameters<IpcApi['projectHandoffExport']>) => handoffs.projectHandoffExport(...args))
  ipcMain.handle('projectHandoffList', (_e, ...args: Parameters<IpcApi['projectHandoffList']>) => handoffs.projectHandoffList(...args))
  ipcMain.handle('projectHandoffGet', (_e, ...args: Parameters<IpcApi['projectHandoffGet']>) => handoffs.projectHandoffGet(...args))
  ipcMain.handle('projectHandoffCreate', (_e, ...args: Parameters<IpcApi['projectHandoffCreate']>) => acknowledgeGuiDraft('handoffs', args[0], () => handoffs.projectHandoffCreate(...args)))
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
  ipcMain.handle('projectMemoryCreate', (_e, request: Parameters<IpcApi['projectMemoryCreate']>[0]) => acknowledgeMemoryDraft(request, () => projectMemory.projectMemoryCreate(request)))
  ipcMain.handle('projectMemoryUpdate', (_e, request: Parameters<IpcApi['projectMemoryUpdate']>[0]) => acknowledgeMemoryDraft(request, () => projectMemory.projectMemoryUpdate(request)))
  ipcMain.handle('projectMemoryHistory', (_e, request: Parameters<IpcApi['projectMemoryHistory']>[0]) => projectMemory.projectMemoryHistory(request))
  ipcMain.handle('projectMemoryArchive', (_e, request: Parameters<IpcApi['projectMemoryArchive']>[0]) => projectMemory.projectMemoryArchive(request))
  ipcMain.handle('projectMemoryErase', (_e, request: Parameters<IpcApi['projectMemoryErase']>[0]) => projectMemory.projectMemoryErase(request))
  const projectKit = new ProjectExport(app.getPath('userData'), store, resolveToolWorkspace, projectTools, () => projectMemory.reloadStorage())
  ipcMain.handle('projectKitExport', (_e, ...args: Parameters<IpcApi['projectKitExport']>) => projectKit.projectKitExport(...args))
  ipcMain.handle('projectKitReconnectLearned', (_e, ...args: Parameters<IpcApi['projectKitReconnectLearned']>) => projectKit.projectKitReconnectLearned(...args))
  ipcMain.handle('projectKitPreview', (_e, ...args: Parameters<IpcApi['projectKitPreview']>) => projectKit.projectKitPreview(...args))
  ipcMain.handle('projectKitImport', (_e, ...args: Parameters<IpcApi['projectKitImport']>) => projectKit.projectKitImport(...args))
  ipcMain.handle('projectKitReport', (_e, ...args: Parameters<IpcApi['projectKitReport']>) => projectKit.projectKitReport(...args))
  const runtimePaths = localRuntimePaths(canonicalPrivateDirectory(app.getPath('userData'), { create: true, requireCanonical: true }), 'app')
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
      projectTasks,
      projectKit,
      browserHistory,
      diffReview,
      projectMemory,
      handoffs,
      projectTools,
      sessionHistory,
      meta: async () => runtimeMetadata(),
      onChanged: (repoId) => send('worktree:changed', { repoId }),
      onSettingsChanged: publishSettings,
      browser: { command: (cmd) => browserControl(cmd), openFile: async (worktreePath, relPath) => browserControl({ op: 'open', key: worktreePath, url: await workspacePreview.url(worktreePath, relPath) }) },
      ui: { command: (cmd) => uiControl(cmd) }
    }
  )
  rpcServer = rpc
  const rendererLoaded = process.env['DONWELLS_SMOKE'] === '1' && mainWindow
    ? new Promise<void>(resolve => {
        if (mainWindow!.webContents.isLoadingMainFrame()) mainWindow!.webContents.once('did-finish-load', () => resolve())
        else resolve()
      })
    : null
  try {
    await rpc.start()
    if (!rpc.isReady()) throw new Error('runtime RPC start completed without an active listener and active ownership')
  } catch (error) {
    logger.fatal({ err: error }, 'runtime rpc failed to start')
    app.exit(1)
    return
  }
  if (rendererLoaded) {
    await rendererLoaded
    if (!rpc.isReady()) {
      logger.fatal('smoke readiness refused because runtime RPC ownership was lost')
      app.exit(1)
      return
    }
    logger.info('smoke:ready')
    const ok = await runSmokeProbe(git, mainWindow!)
    app.exit(ok ? 0 : 1)
  }
}).catch((error) => {
  logger.fatal({ err: error }, 'application startup failed')
  app.exit(1)
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
    closingTools ??= Promise.all([projectTools.close(),projectLanguage?.close()]).then(()=>undefined).catch(() => {
      dialog.showErrorBox('Tool shutdown incomplete', 'An owned tool process could not be confirmed stopped. Check it before starting another instance.')
    }).then(() => { toolsClosed = true; setImmediate(() => app.quit()) })
    return
  }
  if (!daemonShutdownComplete) {
    event.preventDefault()
    closingDaemon ??= (async () => {
      try {
        await terminalBus?.shutdownIfIdle()
      } catch (err) {
        logger.debug({ err }, 'idle daemon reap refused')
      }
      daemonShutdownComplete = true
      setImmediate(() => app.quit())
    })()
    return
  }
  // Daemons owning sessions survive app exit. An idle daemon reaches this
  // point only after its endpoint and ownership row have been reclaimed.
  void workspacePreview.close()
  const runtimeCleanup = rpcServer?.stop()
  if (runtimeCleanup === 'cleanup-failed') logger.error('runtime RPC ownership cleanup could not be verified before quit')
  operationalRuns?.stop()
  trayService?.stop()
  perfServer?.close()
  perfServer = null
})

app.on('window-all-closed', () => {
  // macOS convention (and upstream parity): stay alive with no windows; quit elsewhere.
  if (process.platform !== 'darwin') app.quit()
})
