import { io, type Socket } from 'socket.io-client'
import { getSettings, isConfigured, onSettingsChange } from './settings'

/**
 * Single socket reference, rebuilt whenever the user changes server settings.
 * Components subscribe via subscribe() so they always talk to the live socket.
 */

let current: Socket | null = null
const listeners = new Set<(socket: Socket | null) => void>()

function build(): Socket | null {
  if (!isConfigured()) return null
  const { baseUrl, apiKey } = getSettings()
  return io(baseUrl, {
    transports: ['websocket', 'polling'],
    auth: { apiKey },
    reconnection: true,
    reconnectionAttempts: Infinity,
    timeout: 10000,
  })
}

function rebuild() {
  if (current) {
    try { current.disconnect() } catch { /* ignore */ }
    current = null
  }
  current = build()
  for (const listener of listeners) listener(current)
}

// Initial build + react to settings changes
rebuild()
onSettingsChange(rebuild)

export function getSocket(): Socket | null {
  return current
}

export function forceReconnectSocket() {
  if (current) {
    try { current.disconnect() } catch { /* ignore */ }
    try { current.connect() } catch { /* ignore */ }
    return
  }

  rebuild()
}

export function subscribeSocket(listener: (socket: Socket | null) => void) {
  listeners.add(listener)
  // Fire once with the current value so subscribers don't miss the initial state.
  listener(current)
  return () => { listeners.delete(listener) }
}
