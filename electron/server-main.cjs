const { app, Tray, Menu, nativeImage, shell, clipboard, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

const APP_ID = 'com.szalo.server'
const DEFAULT_PORT = 13113
const PORT = Number(process.env.PORT || DEFAULT_PORT)
const ADMIN_URL = `http://localhost:${PORT}/admin`
const SERVER_BUNDLE_PATH = path.join(__dirname, 'server.cjs')
const SERVER_ICON_PATH = path.join(__dirname, 'server-icon.png')
const SERVER_TRAY_ICON_PATH = path.join(__dirname, 'server-tray-icon.png')
const CLIENT_ICON_PATH = path.join(__dirname, 'icon.png')
const LOG_FILE = path.join(os.tmpdir(), 'szalo-server-tray.log')

let tray = null
let serverState = 'starting'
let serverError = null
let serverInfo = null

app.setName('Szalo Server')
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID)
}

function logToFile(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((arg) => {
    if (typeof arg === 'string') return arg
    if (arg instanceof Error) return arg.stack || arg.message
    try { return JSON.stringify(arg) } catch { return String(arg) }
  }).join(' ')}\n`

  try { fs.appendFileSync(LOG_FILE, line) } catch {}
  try { process.stderr.write(line) } catch {}
}

function iconPathForTray() {
  if (fs.existsSync(SERVER_TRAY_ICON_PATH)) return SERVER_TRAY_ICON_PATH
  if (fs.existsSync(SERVER_ICON_PATH)) return SERVER_ICON_PATH
  return CLIENT_ICON_PATH
}

function iconPathForWindow() {
  if (fs.existsSync(SERVER_ICON_PATH)) return SERVER_ICON_PATH
  return CLIENT_ICON_PATH
}

function createTrayImage() {
  const image = nativeImage.createFromPath(iconPathForTray())
  return image.isEmpty() ? image : image.resize({ width: 16, height: 16 })
}

function statusLabel() {
  if (serverState === 'running') return 'Szalo Server - Running'
  if (serverState === 'failed') return 'Szalo Server - Failed'
  return 'Szalo Server - Starting'
}

function showCopiedBalloon() {
  if (!tray || process.platform !== 'win32') return
  try {
    tray.displayBalloon({
      icon: nativeImage.createFromPath(iconPathForWindow()),
      title: 'Szalo Server',
      content: 'Admin link copied.',
    })
  } catch {}
}

function openAdmin() {
  shell.openExternal(ADMIN_URL)
}

function copyAdminLink() {
  clipboard.writeText(ADMIN_URL)
  showCopiedBalloon()
}

function openDataFolder() {
  const dataDir = serverInfo?.dataDir || process.env.DATA_DIR
  if (dataDir) shell.openPath(dataDir)
}

function showServerError() {
  const message = serverError?.stack || serverError?.message || String(serverError || 'Unknown error')
  dialog.showErrorBox('Szalo Server', message)
}

function updateTrayMenu() {
  if (!tray) return

  const contextMenu = Menu.buildFromTemplate([
    { label: statusLabel(), enabled: false },
    { type: 'separator' },
    {
      label: 'Open Admin',
      enabled: serverState !== 'failed',
      click: openAdmin,
    },
    {
      label: 'Copy Admin Link',
      click: copyAdminLink,
    },
    {
      label: 'Open Data Folder',
      enabled: Boolean(serverInfo?.dataDir || process.env.DATA_DIR),
      click: openDataFolder,
    },
    {
      label: 'Show Error',
      visible: serverState === 'failed',
      click: showServerError,
    },
    { type: 'separator' },
    {
      label: 'Quit Server',
      click: () => app.quit(),
    },
  ])

  tray.setContextMenu(contextMenu)
  tray.setToolTip(statusLabel())
}

function createTray() {
  tray = new Tray(createTrayImage())
  tray.on('click', openAdmin)
  updateTrayMenu()
}

function failServer(error) {
  serverState = 'failed'
  serverError = error
  logToFile('Server failed:', error)
  updateTrayMenu()
}

function startServer() {
  const dataDir = process.env.DATA_DIR || path.join(app.getPath('userData'), 'server-data')
  fs.mkdirSync(dataDir, { recursive: true })

  process.env.PORT = String(PORT)
  process.env.DATA_DIR = dataDir
  process.env.SZALO_EMBEDDED_SERVER = '1'

  process.on('szalo-server-ready', (info) => {
    serverState = 'running'
    serverInfo = info || { port: PORT, adminUrl: ADMIN_URL, dataDir }
    logToFile('Server ready:', serverInfo)
    updateTrayMenu()
  })

  process.on('szalo-server-error', (error) => {
    failServer(error)
  })

  if (!fs.existsSync(SERVER_BUNDLE_PATH)) {
    failServer(new Error(`Missing server bundle: ${SERVER_BUNDLE_PATH}. Run npm run build:server first.`))
    return
  }

  try {
    require(SERVER_BUNDLE_PATH)
  } catch (error) {
    failServer(error)
  }
}

process.on('uncaughtException', failServer)
process.on('unhandledRejection', (reason) => {
  failServer(reason instanceof Error ? reason : new Error(String(reason)))
})

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', openAdmin)

  app.whenReady().then(() => {
    logToFile('=== SZALO SERVER TRAY STARTING ===', 'pid:', process.pid, 'argv:', process.argv.join(' '))
    createTray()
    startServer()
  })
}

app.on('window-all-closed', () => {
  // The server is tray-only.
})
