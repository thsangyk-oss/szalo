const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, screen, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const { fileURLToPath, pathToFileURL } = require('url')

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

app.disableHardwareAcceleration()
app.setName('Szalo')
if (process.platform === 'win32') {
  app.setAppUserModelId('com.szalo.app')
}

const isDev = process.env.NODE_ENV === 'development'
const DEV_URL = process.env.SZALO_DEV_URL || 'http://localhost:5173'
const ICON_PATH = path.join(__dirname, 'icon.png')
const ICON_ICO_PATH = path.join(__dirname, 'icon.ico')
const WINDOW_ICON_PATH = process.platform === 'win32' && fs.existsSync(ICON_ICO_PATH) ? ICON_ICO_PATH : ICON_PATH
const TRAY_ICON_PATH = path.join(__dirname, 'tray-icon.png')
const MAX_BUBBLES = 5
const BUBBLE_DOCK_SIZE = 72
const NOTIFICATION_AVATAR_SIZE = 96
const MAX_NOTIFICATION_AVATAR_BYTES = 5 * 1024 * 1024
const NOTIFICATION_AVATAR_TIMEOUT_MS = 3500

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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function notificationCacheDir() {
  return path.join(app.getPath('userData'), 'notification-avatars')
}

function notificationIconCachePath(avatar) {
  const hash = crypto.createHash('sha256').update(avatar).digest('hex').slice(0, 32)
  return path.join(notificationCacheDir(), `${hash}.png`)
}

function createNativeImageFromDataUrl(dataUrl) {
  try {
    const image = nativeImage.createFromDataURL(dataUrl)
    return image.isEmpty() ? null : image
  } catch {
    return null
  }
}

async function createNativeImageFromRemoteUrl(url) {
  if (typeof fetch !== 'function') return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NOTIFICATION_AVATAR_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Szalo/1.0' },
    })
    if (!response.ok) return null

    const contentLength = Number(response.headers.get('content-length') || 0)
    if (contentLength > MAX_NOTIFICATION_AVATAR_BYTES) return null

    const arrayBuffer = await response.arrayBuffer()
    if (arrayBuffer.byteLength > MAX_NOTIFICATION_AVATAR_BYTES) return null

    const image = nativeImage.createFromBuffer(Buffer.from(arrayBuffer))
    return image.isEmpty() ? null : image
  } catch (error) {
    logToFile('NOTIFICATION_AVATAR_FETCH_FAILED', { url, error: error?.message || String(error) })
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function createNativeImageFromAvatar(avatar) {
  const value = typeof avatar === 'string' ? avatar.trim() : ''
  if (!value) return null

  if (value.startsWith('data:image/')) {
    return createNativeImageFromDataUrl(value)
  }

  if (/^https?:\/\//i.test(value)) {
    return createNativeImageFromRemoteUrl(value)
  }

  let filePath = value
  if (value.startsWith('file://')) {
    try {
      filePath = fileURLToPath(value)
    } catch {
      return null
    }
  }
  try {
    const image = nativeImage.createFromPath(filePath)
    return image.isEmpty() ? null : image
  } catch {
    return null
  }
}

async function resolveNotificationAvatarIcon(avatar) {
  const value = typeof avatar === 'string' ? avatar.trim() : ''
  if (!value) return null

  const cachePath = notificationIconCachePath(value)
  if (fs.existsSync(cachePath)) return cachePath

  const image = await createNativeImageFromAvatar(value)
  if (!image) return null

  const png = image.resize({
    width: NOTIFICATION_AVATAR_SIZE,
    height: NOTIFICATION_AVATAR_SIZE,
    quality: 'best',
  }).toPNG()
  if (!png.length) return null

  fs.mkdirSync(path.dirname(cachePath), { recursive: true })
  fs.writeFileSync(cachePath, png)
  return cachePath
}

function createWindowsToastXml({ title, body, avatarIconPath }) {
  const image = avatarIconPath
    ? `<image placement="appLogoOverride" hint-crop="circle" src="${escapeXml(pathToFileURL(avatarIconPath).href)}" alt="${escapeXml(title || 'Szalo')}"/>`
    : ''

  return `
<toast activationType="foreground">
  <visual>
    <binding template="ToastGeneric">
      ${image}
      <text>${escapeXml(title || 'Szalo')}</text>
      <text>${escapeXml(body || '')}</text>
    </binding>
  </visual>
  <audio src="ms-winsoundevent:Notification.Default"/>
</toast>`.trim()
}

function focusThreadFromNotification(threadId, type) {
  if (!mainWindow) return
  mainWindow.show()
  mainWindow.focus()
  if (threadId) {
    mainWindow.webContents.send('open-thread', { threadId, type })
  }
}

function showStandardNotification(payload, iconPath = ICON_PATH) {
  const notification = new Notification({
    title: payload.title || 'Szalo',
    body: payload.body || '',
    icon: iconPath,
    silent: false,
    timeoutType: 'default',
  })

  notification.on('click', () => focusThreadFromNotification(payload.threadId, payload.type))
  notification.show()
  return notification
}

async function showNativeNotification(payload) {
  if (!Notification.isSupported()) return

  const normalized = {
    title: typeof payload?.title === 'string' ? payload.title : 'Szalo',
    body: typeof payload?.body === 'string' ? payload.body : '',
    threadId: payload?.threadId,
    type: payload?.type,
    avatar: payload?.avatar,
  }
  const avatarIconPath = await resolveNotificationAvatarIcon(normalized.avatar)

  if (process.platform !== 'win32' || !avatarIconPath) {
    showStandardNotification(normalized, avatarIconPath || ICON_PATH)
    return
  }

  let fallbackShown = false
  const notification = new Notification({
    toastXml: createWindowsToastXml({
      title: normalized.title,
      body: normalized.body,
      avatarIconPath,
    }),
  })

  notification.on('click', () => focusThreadFromNotification(normalized.threadId, normalized.type))
  notification.on('failed', (_event, error) => {
    logToFile('NOTIFICATION_TOAST_XML_FAILED', error || '')
    if (!fallbackShown) {
      fallbackShown = true
      showStandardNotification(normalized, avatarIconPath)
    }
  })
  notification.show()
}

function showRendererLoadError(window, title, details) {
  if (!window || window.isDestroyed()) return
  const body = `
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #101410; color: #edf3ec; font-family: Segoe UI, Arial, sans-serif; }
          main { width: min(680px, calc(100vw - 48px)); line-height: 1.5; }
          h1 { margin: 0 0 12px; font-size: 24px; }
          pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #171d17; border: 1px solid #2b382d; border-radius: 8px; padding: 14px; color: #c9d6c9; }
        </style>
      </head>
      <body>
        <main>
          <h1>${escapeHtml(title)}</h1>
          <p>Renderer failed to load. Please send this screen and <code>%TEMP%\\szalo.log</code>.</p>
          <pre>${escapeHtml(details)}</pre>
        </main>
      </body>
    </html>`
  window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(body)}`)
}

function attachWindowDiagnostics(window, name) {
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    logToFile('DID_FAIL_LOAD', name, { errorCode, errorDescription, validatedURL, isMainFrame })
    if (isMainFrame) {
      showRendererLoadError(window, 'Szalo load error', `${errorCode} ${errorDescription}\n${validatedURL || ''}`)
    }
  })

  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    logToFile('RENDERER_CONSOLE', name, { level, message, line, sourceId })
  })

  window.webContents.on('render-process-gone', (_event, details) => {
    logToFile('RENDER_PROCESS_GONE', name, details)
    showRendererLoadError(window, 'Szalo renderer crashed', JSON.stringify(details, null, 2))
  })
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
    icon: WINDOW_ICON_PATH,
    title: 'Szalo',
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#10110f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  })

  attachWindowDiagnostics(mainWindow, 'main')
  mainWindow.setMenuBarVisibility(false)

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

ipcMain.on('notification', (_event, payload) => {
  void showNativeNotification(payload)
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

ipcMain.on('window-close', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (window && !window.isDestroyed()) {
    window.close()
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
  Menu.setApplicationMenu(null)
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
