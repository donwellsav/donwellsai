import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { IpcApi, MainEvents } from '@shared/types'
import { Store, idFromPath } from './store'
import { GitWorktrees } from './git'
import { DaemonClient } from './daemon-client'
import { runSmokeProbe } from './smoke-probe'

// Test seam: isolated userData dir for the smoke harness.
if (process.env['ORCA_LITE_USER_DATA']) {
  app.setPath('userData', process.env['ORCA_LITE_USER_DATA'])
}

let store: Store
let git: GitWorktrees
let terminalBus: DaemonClient
let mainWindow: BrowserWindow | null = null

function send<K extends keyof MainEvents>(channel: K, payload: MainEvents[K]): void {
  mainWindow?.webContents.send(channel, payload)
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
        { role: isMac ? 'close' : 'quit' }
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
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+Shift+P', click: () => menuAction('command-palette') },
        { label: 'New Terminal', accelerator: 'CmdOrCtrl+Shift+T', click: () => menuAction('new-terminal') },
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

function registerIpc(): void {
  ipcMain.handle('meta', () => ({
    version: app.getVersion(),
    shell: process.env.SHELL || '',
    userDataDir: app.getPath('userData')
  }))

  ipcMain.handle('listRepos', () => git.listAll())

  ipcMain.handle('addRepo', async (_e, dir: string) => {
    const summary = await git.addRepo(dir)
    send('worktree:changed', { repoId: summary.repo.id })
    return summary
  })

  ipcMain.handle('removeRepo', (_e, repoId: string) => {
    git.removeRepo(repoId)
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

  ipcMain.handle('gitStatus', (_e, worktreePath: string) => git.status(worktreePath))
  ipcMain.handle('listFiles', (_e, worktreePath: string, prefix = '') => git.listFiles(worktreePath, prefix))
  ipcMain.handle('readFile', (_e, worktreePath: string, relPath: string) => git.readFile(worktreePath, relPath))

  ipcMain.handle('getSettings', () => store.getSettings())
  ipcMain.handle('setSettings', (_e, patch: Record<string, unknown>) => store.updateSettings(patch))

  ipcMain.handle('listAgents', () => git.detectAgents())

  ipcMain.handle('pickDirectory', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle('openExternal', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return true
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Orca Lite',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('closed', () => {
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
  git = new GitWorktrees(store)
  git.setTrashRoot(join(app.getPath('userData'), 'trash'))
  // Daemon owns the PTYs: spawn-if-needed (detached), never killed on app exit —
  // running agents survive app restarts; scrollback replays on reattach.
  terminalBus = new DaemonClient(
    app.getPath('userData'),
    {
      data: (sessionId, data) => send('terminal:data', { sessionId, data }),
      exit: (sessionId, exitCode) => send('terminal:exit', { sessionId, exitCode }),
      title: (sessionId, title) => send('terminal:title', { sessionId, title })
    },
    join(__dirname, 'terminal-daemon-entry.js')
  )
  void terminalBus.connect().catch((e) => {
    console.error('terminal daemon connect failed:', e)
  })
  registerIpc()
  buildMenu()
  createWindow()
  if (process.env['ORCA_LITE_SMOKE'] === '1') {
    mainWindow?.webContents.once('did-finish-load', () => {
      console.log('smoke:ready')
      void runSmokeProbe(git).then((ok) => {
        app.exit(ok ? 0 : 1)
      })
    })
  }
})
app.on('before-quit', () => {
  // orcad rule: never kill the daemon or its PTYs on app exit — sessions survive
})


app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})