import { app, shell, BrowserWindow, powerSaveBlocker, safeStorage } from 'electron'
import { join } from 'path'
import appIcon from '../../resources/icon.ico?asset'
// Static import (NOT dynamic): database.ts is imported statically everywhere else,
// so a dynamic import here made rollup split it into a second chunk whose `db`
// variable was tree-shaken away — leaving getDb to always throw. One import kind
// = one shared chunk = one db.
import { initDatabase } from './db/database'

let mainWindow: BrowserWindow | null = null
let blockerId: number | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    icon: appIcon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function setPipelineRunning(running: boolean): void {
  if (running && blockerId === null) {
    blockerId = powerSaveBlocker.start('prevent-app-suspension')
  } else if (!running && blockerId !== null) {
    powerSaveBlocker.stop(blockerId)
    blockerId = null
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    const { initLogger, log, logError } = await import('./services/logger')
    initLogger(join(app.getPath('userData'), 'logs'))
    process.on('unhandledRejection', (reason) => logError('process', 'unhandledRejection', reason))
    process.on('uncaughtException', (err) => logError('process', 'uncaughtException', err))
    log('app', `derAutor starting, userData=${app.getPath('userData')}`)
    initDatabase(process.env.DERAUTOR_DB ?? join(app.getPath('userData'), 'derautor.db'))
    const { reconcileInterruptedProjects } = await import('./db/repo/projects')
    reconcileInterruptedProjects()
    const { setEventSink, setPowerHook } = await import('./ipc/events')
    setEventSink((channel, payload) => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
    })
    setPowerHook(setPipelineRunning)
    const { setKeyCipher } = await import('./services/settings')
    setKeyCipher({
      encrypt: (plain) => {
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error('OS-level encryption unavailable; cannot store API keys safely')
        }
        return safeStorage.encryptString(plain).toString('base64')
      },
      decrypt: (encoded) => safeStorage.decryptString(Buffer.from(encoded, 'base64'))
    })
    const { registerIpcHandlers } = await import('./ipc/handlers')
    registerIpcHandlers()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}
