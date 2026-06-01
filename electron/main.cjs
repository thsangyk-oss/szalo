const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, screen, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

// Debug log file (always log to a known path, fallback to temp dir)
const LOG_FILE = path.join(os.tmpdir(), 'szalo.log')

// Try multiple log locations to ensure at least one works
const LOG_PATHS = [
  LOG_FILE,
  path.join(os.homedir(), 'szalo.log'),
  path.join(__dirname, '..', '..', 'szalo.log'),
]

function logToFile(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => typeof a === 'string' ? a : (() => { try { return JSON.stringify(a) } catch { return String(a) } })()).join(' ')}\n`
  for (const logPath of LOG_PATHS) {
    try {
      fs.appendFileSync(logPath, line)
      break
    } catch { /* try next */ }
  }
  try { process.stderr.write(line) } catch {}
  console.log(...args)
}
logToFile('=== APP STARTING ===', 'pid:', process.pid, 'argv:', process.argv.join(' '))
process.on('uncaughtException', (err) => {
  logToFile('UNCAUGHT', err?.stack || String(err))
})
process.on('unhandledRejection', (reason) => {
  logToFile('UNHANDLED', String(reason))
})

const isDev = process.env.NODE_ENV === 'development'
const DEV_URL = process.env.SZALO_DEV_URL || 'http://localhost:5173'
const ICON_PATH = path.join(__dirname, 'icon.png')
const TRAY_ICON_PATH = path.join(__dirname, 'tray-icon.png')
const MAX_BUBBLES = 5
const BUBBLE_DOCK_SIZE = 72

let mainWindow = null
let bubbleDockWindow = null
let bubblePanelWindow = null
let tray = null
let isQuitting = false
let unreadCount = 0
let bubbleThreads = [] // [{threadId, type, name, avatar}]
let bubbleDockDragTimer = null
let bubbleDockDragOffset = null
let bubbleDockDragTimeout = null

function getRendererBuildDir() {
  // In dev, we use the live Vite server (DEV_URL).
  // In packaged builds, the renderer is bundled into the asar at "build/".
  return path.join(__dirname, '..', 'build')
}

function loadRenderer(window, hash = '') {
  if (isDev) {
    const url = hash ? `${DEV_URL}/${hash.startsWith('#') ? hash : `#${hash}`}` : DEV_URL
    window.loadURL(url)
  } else {
    const filePath = path.join(getRendererBuildDir(), 'index.html')
    window.loadFile(filePath, hash ? { hash: hash.startsWith('#') ? hash.slice(1) : hash } : undefined)
  }
}

function normalizeBubbleThread(data) {
  if (!data?.threadId) return null
  const threadId = String(data.threadId)
  const type = data.type === 'group' ? 'group' : 'user'
  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : threadId
  const avatar = typeof data.avatar === 'string' && data.avatar.trim() ? data.avatar.trim() : undefined
  return { threadId, type, name, avatar }
}

function mergeBubbleThread(current, incoming) {
  return {
    threadId: current?.threadId ?? incoming.threadId,
    type: incoming.type || current?.type || 'user',
    name: incoming.name || current?.name || incoming.threadId,
    avatar: incoming.avatar || current?.avatar,
  }
}

function clampBubbleDockPosition(x, y) {
  const display = screen.getDisplayNearestPoint({
    x: Math.round(x + BUBBLE_DOCK_SIZE / 2),
    y: Math.round(y + BUBBLE_DOCK_SIZE / 2),
  })
  const workArea = display.workArea
  return {
    x: Math.min(Math.max(Math.round(x), workArea.x), workArea.x + workArea.width - BUBBLE_DOCK_SIZE),
    y: Math.min(Math.max(Math.round(y), workArea.y), workArea.y + workArea.height - BUBBLE_DOCK_SIZE),
  }
}

function lockBubbleDockSize() {
  if (!bubbleDockWindow || bubbleDockWindow.isDestroyed()) return
  const bounds = bubbleDockWindow.getBounds()
  if (bounds.width === BUBBLE_DOCK_SIZE && bounds.height === BUBBLE_DOCK_SIZE) return
  bubbleDockWindow.setBounds({
    x: bounds.x,
    y: bounds.y,
    width: BUBBLE_DOCK_SIZE,
    height: BUBBLE_DOCK_SIZE,
  }, false)
}

function stopBubbleDockDrag() {
  if (bubbleDockDragTimer) {
    clearInterval(bubbleDockDragTimer)
    bubbleDockDragTimer = null
  }
  if (bubbleDockDragTimeout) {
    clearTimeout(bubbleDockDragTimeout)
    bubbleDockDragTimeout = null
  }
  bubbleDockDragOffset = null
  lockBubbleDockSize()
}

function startBubbleDockDrag() {
  if (!bubbleDockWindow || bubbleDockWindow.isDestroyed()) return
  stopBubbleDockDrag()
  const bounds = bubbleDockWindow.getBounds()
  const cursor = screen.getCursorScreenPoint()
  bubbleDockDragOffset = {
    x: cursor.x - bounds.x,
    y: cursor.y - bounds.y,
  }
  bubbleDockDragTimer = setInterval(() => {
    if (!bubbleDockWindow || bubbleDockWindow.isDestroyed() || !bubbleDockDragOffset) {
      stopBubbleDockDrag()
      return
    }
    const point = screen.getCursorScreenPoint()
    const position = clampBubbleDockPosition(point.x - bubbleDockDragOffset.x, point.y - bubbleDockDragOffset.y)
    bubbleDockWindow.setPosition(position.x, position.y, false)
    lockBubbleDockSize()
  }, 16)
  bubbleDockDragTimeout = setTimeout(stopBubbleDockDrag, 15000)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    icon: ICON_PATH,
    title: 'Szalo',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  loadRenderer(mainWindow)

  // Open all external links (window.open / target=_blank) in user's default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  // Block in-app navigation to external URLs — open them in browser instead.
  // The renderer itself lives at file:// (packaged) or http://localhost:5173 (dev).
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isLocalRenderer = url.startsWith('file://') || url.startsWith(DEV_URL)
    if (!isLocalRenderer && (url.startsWith('http://') || url.startsWith('https://'))) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// --- Bubble Dock: small 64x64 opaque window, always visible ---
function createBubbleDock() {
  if (bubbleDockWindow) {
    bubbleDockWindow.focus()
    return
  }

  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize

  bubbleDockWindow = new BrowserWindow({
    width: BUBBLE_DOCK_SIZE,
    height: BUBBLE_DOCK_SIZE,
    x: screenWidth - BUBBLE_DOCK_SIZE - 16,
    y: screenHeight - 200,
    icon: ICON_PATH,
    title: 'Szalo Bubble',
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    resizable: false,
    useContentSize: true,
    thickFrame: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  bubbleDockWindow.setMinimumSize(BUBBLE_DOCK_SIZE, BUBBLE_DOCK_SIZE)
  bubbleDockWindow.setMaximumSize(BUBBLE_DOCK_SIZE, BUBBLE_DOCK_SIZE)
  bubbleDockWindow.setContentSize(BUBBLE_DOCK_SIZE, BUBBLE_DOCK_SIZE)
  bubbleDockWindow.on('resize', lockBubbleDockSize)
  bubbleDockWindow.on('resized', lockBubbleDockSize)
  bubbleDockWindow.on('will-resize', (event) => {
    event.preventDefault()
    lockBubbleDockSize()
  })

  loadRenderer(bubbleDockWindow, '#/bubble-dock')

  bubbleDockWindow.on('closed', () => {
    stopBubbleDockDrag()
    bubbleDockWindow = null
    // Also close panel if dock is closed
    if (bubblePanelWindow) {
      bubblePanelWindow.close()
      bubblePanelWindow = null
    }
    if (mainWindow) {
      mainWindow.webContents.send('bubble-closed')
    }
    updateTrayMenu()
  })

  // Send threads after load
  bubbleDockWindow.webContents.on('did-finish-load', () => {
    bubbleDockWindow.webContents.send('bubble-threads', bubbleThreads)
  })
}

// --- Bubble Panel: chat window, opens next to dock ---
function createBubblePanel() {
  if (bubblePanelWindow) {
    bubblePanelWindow.show()
    bubblePanelWindow.focus()
    return
  }

  // Position panel to the left of the dock
  let panelX = 100
  let panelY = 100
  if (bubbleDockWindow) {
    const dockBounds = bubbleDockWindow.getBounds()
    panelX = dockBounds.x - 390
    panelY = dockBounds.y - 440
    // Clamp to screen
    if (panelX < 10) panelX = dockBounds.x + dockBounds.width + 10
    if (panelY < 10) panelY = 10
  }

  bubblePanelWindow = new BrowserWindow({
    width: 380,
    height: 500,
    x: panelX,
    y: panelY,
    icon: ICON_PATH,
    title: 'Szalo Chat',
    alwaysOnTop: true,
    frame: false,
    transparent: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    backgroundColor: '#14171e',
    minWidth: 300,
    minHeight: 350,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  loadRenderer(bubblePanelWindow, '#/bubble-panel')

  // External links → browser
  bubblePanelWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  bubblePanelWindow.on('closed', () => {
    bubblePanelWindow = null
  })

  // Send threads after load
  bubblePanelWindow.webContents.on('did-finish-load', () => {
    bubblePanelWindow.webContents.send('bubble-threads', bubbleThreads)
  })
}

function closeBubblePanel() {
  if (bubblePanelWindow) {
    bubblePanelWindow.close()
    bubblePanelWindow = null
  }
}

function sendThreadsToAll() {
  if (bubbleDockWindow) {
    bubbleDockWindow.webContents.send('bubble-threads', bubbleThreads)
  }
  if (bubblePanelWindow) {
    bubblePanelWindow.webContents.send('bubble-threads', bubbleThreads)
  }
}

function createTray() {
  // tray-icon.png is generated by build:icons; if missing, fall back to the app icon
  // so the tray still works in development before icons have been generated.
  const trayIconPath = fs.existsSync(TRAY_ICON_PATH) ? TRAY_ICON_PATH : ICON_PATH
  const icon = nativeImage.createFromPath(trayIconPath).resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.setToolTip('Szalo')
  updateTrayMenu()

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus()
      } else {
        mainWindow.show()
      }
    }
  })
}

function updateTrayMenu() {
  const contextMenu = Menu.buildFromTemplate([
    {
      label: unreadCount > 0 ? `Szalo (${unreadCount} chưa đọc)` : 'Szalo',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Hiện cửa sổ',
      click: () => {
        if (mainWindow) {
          mainWindow.show()
          mainWindow.focus()
        }
      },
    },
    {
      label: 'Ẩn cửa sổ',
      click: () => {
        if (mainWindow) mainWindow.hide()
      },
    },
    { type: 'separator' },
    {
      label: bubbleDockWindow ? `Đóng bong bóng (${bubbleThreads.length})` : 'Bong bóng chat',
      enabled: bubbleDockWindow !== null,
      click: () => {
        if (bubbleDockWindow) {
          bubbleDockWindow.close()
        }
        bubbleThreads = []
      },
    },
    { type: 'separator' },
    {
      label: 'Thoát',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])
  tray.setContextMenu(contextMenu)
  tray.setToolTip(unreadCount > 0 ? `Szalo (${unreadCount} chưa đọc)` : 'Szalo')
}

// === IPC Handlers ===

ipcMain.on('notification', (_event, { title, body, threadId, type }) => {
  if (!Notification.isSupported()) return

  const notification = new Notification({
    title: title || 'Szalo',
    body: body || '',
    icon: ICON_PATH,
    silent: false,
  })

  notification.on('click', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
      if (threadId) {
        mainWindow.webContents.send('open-thread', { threadId, type })
      }
    }
  })

  notification.show()
})

ipcMain.on('unread-count', (_event, count) => {
  unreadCount = count
  updateTrayMenu()

  if (mainWindow) {
    if (count > 0) {
      mainWindow.setTitle(`(${count}) Szalo`)
    } else {
      mainWindow.setTitle('Szalo')
    }
  }
})

ipcMain.on('flash-frame', () => {
  if (mainWindow && !mainWindow.isFocused()) {
    mainWindow.flashFrame(true)
  }
})

// Bubble IPC
ipcMain.on('open-bubble', (_event, data) => {
  const incoming = normalizeBubbleThread(data)
  if (!incoming) return
  const existingIndex = bubbleThreads.findIndex((b) => b.threadId === incoming.threadId)
  if (existingIndex >= 0) {
    bubbleThreads[existingIndex] = mergeBubbleThread(bubbleThreads[existingIndex], incoming)
  } else {
    if (bubbleThreads.length >= MAX_BUBBLES) {
      bubbleThreads.shift()
    }
    bubbleThreads.push(incoming)
  }
  createBubbleDock()
  setTimeout(() => sendThreadsToAll(), 300)
  updateTrayMenu()
})

ipcMain.on('open-bubble-panel', () => {
  createBubblePanel()
})

ipcMain.on('close-bubble-panel', () => {
  closeBubblePanel()
})

ipcMain.on('remove-bubble', (_event, threadId) => {
  bubbleThreads = bubbleThreads.filter((b) => b.threadId !== threadId)
  if (bubbleThreads.length === 0) {
    if (bubbleDockWindow) bubbleDockWindow.close()
  } else {
    sendThreadsToAll()
  }
  updateTrayMenu()
})

ipcMain.on('get-bubble-threads', (event) => {
  event.returnValue = bubbleThreads
})

ipcMain.on('begin-bubble-dock-drag', () => {
  startBubbleDockDrag()
})

ipcMain.on('end-bubble-dock-drag', () => {
  stopBubbleDockDrag()
})

ipcMain.on('close-all-bubbles', () => {
  bubbleThreads = []
  stopBubbleDockDrag()
  if (bubblePanelWindow) {
    bubblePanelWindow.close()
    bubblePanelWindow = null
  }
  if (bubbleDockWindow) {
    bubbleDockWindow.close()
    bubbleDockWindow = null
  }
  updateTrayMenu()
})

ipcMain.on('move-bubble-dock', (_event, { dx, dy }) => {
  if (!bubbleDockWindow) return
  const bounds = bubbleDockWindow.getBounds()
  const position = clampBubbleDockPosition(bounds.x + Number(dx || 0), bounds.y + Number(dy || 0))
  bubbleDockWindow.setPosition(position.x, position.y, false)
  lockBubbleDockSize()
})

// === App Lifecycle ===

app.on('ready', () => {
  logToFile('App ready, isDev:', isDev, 'devUrl:', DEV_URL)
  logToFile('Resource paths:', { app: app.getAppPath(), resources: process.resourcesPath })
  createWindow()
  createTray()
})

app.on('window-all-closed', () => {
  // Don't quit — keep running in tray
})

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow()
  } else {
    mainWindow.show()
  }
})

app.on('before-quit', () => {
  isQuitting = true
})

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
}
