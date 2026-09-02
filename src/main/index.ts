import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { IpcApi, MainEvents } from '@shared/types'
import { Store, idFromPath } from './store'
import { GitWorktrees } from './git'
import { PtyManager } from './pty'
import { runSmokeProbe } from './smoke-probe'

// Test seam: isolated userData dir for the smoke harness.
if (process.env['ORCA_LITE_USER_DATA']) {
  app.setPath('userData', process.env['ORCA_LITE_USER_DATA'])
}

let store: Store
let git: GitWorktrees
let ptyManager: PtyManager
let mainWindow: BrowserWindow | null = null

function send<K extends keyof MainEvents>(channel: K, payload: MainEvents[K]): void {
  mainWindow?.webContents.send(channel, payload)
}

function registerIpc(): void {
  ipcMain.handle('meta', () => ({
    version: app.getVersion(),
    shell: ptyManager ? '' : '',
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

  ipcMain.handle('removeWorktree', async (_e, repoId: string, worktreePath: string) => {
    const repo = store.listRepos().find((r) => r.id === repoId)
    if (!repo) throw new Error(`unknown repo ${repoId}`)
    const summary = await git.removeWorktree(repo.path, worktreePath)
    send('worktree:changed', { repoId })
    return summary
  })

  ipcMain.handle('openTerminal', (_e, worktreePath: string, cwd?: string) => {
    if (!existsSync(worktreePath)) throw new Error(`path does not exist: ${worktreePath}`)
    return ptyManager.open(cwd ?? worktreePath, 100, 30)
  })

  ipcMain.handle('closeTerminal', (_e, sessionId: string) => {
    ptyManager.close(sessionId)
    return true
  })

  ipcMain.handle('terminalWrite', (_e, sessionId: string, data: string) => {
    ptyManager.write(sessionId, data)
    return true
  })

  ipcMain.handle('terminalResize', (_e, sessionId: string, cols: number, rows: number) => {
    ptyManager.resize(sessionId, cols, rows)
    return true
  })

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
  ptyManager = new PtyManager({
    data: (sessionId, data) => send('terminal:data', { sessionId, data }),
    exit: (sessionId, exitCode) => send('terminal:exit', { sessionId, exitCode }),
    title: (sessionId, title) => send('terminal:title', { sessionId, title })
  })
  registerIpc()
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

app.on('window-all-closed', () => {
  // Keep app running until every PTY session is gone? No: quitting closes terminals,
  // which is the expected desktop behavior for lite. Terminate all PTYs on quit.
  app.quit()
})

app.on('before-quit', () => {
  ptyManager?.list().forEach((s) => ptyManager.close(s.id))
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})