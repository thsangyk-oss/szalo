/**
 * Server connection settings — URL + API key.
 *
 * Lives in localStorage so the user only enters them once. Other modules read
 * the current values via `getSettings()`, build URLs through `apiUrl()`, and
 * subscribe to changes via `onSettingsChange()` to rebuild the socket.
 */

const STORAGE_KEY = 'szalo-server-settings'

export type ServerSettings = {
  baseUrl: string
  apiKey: string
}

const EMPTY: ServerSettings = { baseUrl: '', apiKey: '' }

let cached: ServerSettings = loadFromStorage()
const listeners = new Set<(settings: ServerSettings) => void>()

function loadFromStorage(): ServerSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...EMPTY }
    const parsed = JSON.parse(raw) as Partial<ServerSettings>
    return {
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl.trim() : '',
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '',
    }
  } catch {
    return { ...EMPTY }
  }
}

export function getSettings(): ServerSettings {
  return cached
}

export function isConfigured(): boolean {
  return Boolean(cached.baseUrl) && Boolean(cached.apiKey)
}

export function saveSettings(next: ServerSettings) {
  // Strip trailing slash so apiUrl() can append paths without doubling up.
  const normalized: ServerSettings = {
    baseUrl: next.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: next.apiKey.trim(),
  }
  cached = normalized
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    /* quota or disabled storage — ignore, in-memory copy still works */
  }
  for (const listener of listeners) listener(normalized)
}

export function clearSettings() {
  saveSettings({ ...EMPTY })
}

export function onSettingsChange(listener: (settings: ServerSettings) => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function apiUrl(path: string): string {
  if (!path) return cached.baseUrl
  if (/^https?:\/\//i.test(path)) return path
  const prefix = path.startsWith('/') ? '' : '/'
  return `${cached.baseUrl}${prefix}${path}`
}

/**
 * Inject the API key into a fetch request. Header has the highest precedence
 * server-side, so we always send it that way.
 */
export function authedInit(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers)
  if (cached.apiKey) headers.set('x-api-key', cached.apiKey)
  return { ...init, headers }
}

/**
 * Probe an arbitrary base URL + key. Used by the settings screen to validate
 * input before saving. The health/ping endpoint is intentionally public (no
 * key needed) so we can distinguish "wrong URL" from "wrong key".
 */
export async function probeServer(baseUrl: string, apiKey: string): Promise<{
  reachable: boolean
  authorized: boolean
  service?: string
  error?: string
}> {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (!trimmed) return { reachable: false, authorized: false, error: 'URL trống' }

  let pingResponse: Response
  try {
    pingResponse = await fetch(`${trimmed}/api/health/ping`, { method: 'GET' })
  } catch (error) {
    return {
      reachable: false,
      authorized: false,
      error: error instanceof Error ? error.message : 'Không kết nối được',
    }
  }

  if (!pingResponse.ok) {
    return { reachable: false, authorized: false, error: `HTTP ${pingResponse.status}` }
  }

  let service: string | undefined
  try {
    const payload = await pingResponse.json() as { service?: string }
    service = payload.service
  } catch { /* ignore */ }

  // Now check the key against an authed endpoint.
  try {
    const statusResponse = await fetch(`${trimmed}/api/status`, {
      method: 'GET',
      headers: { 'x-api-key': apiKey },
    })
    if (statusResponse.status === 401) return { reachable: true, authorized: false, service, error: 'API key không đúng' }
    if (!statusResponse.ok) return { reachable: true, authorized: false, service, error: `HTTP ${statusResponse.status}` }
    return { reachable: true, authorized: true, service }
  } catch (error) {
    return {
      reachable: true,
      authorized: false,
      service,
      error: error instanceof Error ? error.message : 'Lỗi xác thực',
    }
  }
}
