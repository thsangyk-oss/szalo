const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Send native notification
  sendNotification: (data) => {
    ipcRenderer.send('notification', data)
  },

  // Update unread count (for tray badge)
  setUnreadCount: (count) => {
    ipcRenderer.send('unread-count', count)
  },

  // Flash taskbar icon
  flashFrame: () => {
    ipcRenderer.send('flash-frame')
  },

  closeWindow: () => {
    ipcRenderer.send('window-close')
  },

  // Listen for open-thread from main (when user clicks notification)
  onOpenThread: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('open-thread', listener)
    return () => ipcRenderer.removeListener('open-thread', listener)
  },

  onMainWindowVisibility: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('main-window-visibility', listener)
    return () => ipcRenderer.removeListener('main-window-visibility', listener)
  },

  // Bubble chat - dock
  openBubble: (data) => {
    ipcRenderer.send('open-bubble', data)
  },

  openBubblePanel: () => {
    ipcRenderer.send('open-bubble-panel')
  },

  closeBubblePanel: () => {
    ipcRenderer.send('close-bubble-panel')
  },

  removeBubble: (threadId) => {
    ipcRenderer.send('remove-bubble', threadId)
  },

  closeAllBubbles: () => {
    ipcRenderer.send('close-all-bubbles')
  },

  moveBubbleDock: (dx, dy) => {
    ipcRenderer.send('move-bubble-dock', { dx, dy })
  },

  beginBubbleDockDrag: () => {
    ipcRenderer.send('begin-bubble-dock-drag')
  },

  endBubbleDockDrag: () => {
    ipcRenderer.send('end-bubble-dock-drag')
  },

  getBubbleThreads: () => {
    return ipcRenderer.sendSync('get-bubble-threads')
  },

  onBubbleThreads: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('bubble-threads', listener)
    return () => ipcRenderer.removeListener('bubble-threads', listener)
  },

  onBubbleClosed: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('bubble-closed', listener)
    return () => ipcRenderer.removeListener('bubble-closed', listener)
  },

  // Check if running in Electron
  isElectron: true,
})
