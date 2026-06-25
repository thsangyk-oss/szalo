import { useState } from 'react'
import { CheckCircle2, KeyRound, Save, Server, X } from 'lucide-react'
import { getSettings, probeServer, saveSettings, type ServerSettings } from './settings'
import './SettingsScreen.css'

type Status = { kind: 'idle' | 'testing' | 'ok' | 'warn' | 'err'; message?: string }

type Props = {
  // When true, this is shown as a modal that can be dismissed.
  // When false (initial setup), it locks the screen until the user saves valid settings.
  dismissible: boolean
  onClose?: () => void
  onSaved?: (settings: ServerSettings) => void
}

const DEFAULT_URL_PLACEHOLDER = 'http://localhost:13113'

export default function Settings({ dismissible, onClose, onSaved }: Props) {
  const initial = getSettings()
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl)
  const [apiKey, setApiKey] = useState(initial.apiKey)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [saving, setSaving] = useState(false)

  async function handleTest() {
    if (!baseUrl.trim() || !apiKey.trim()) {
      setStatus({ kind: 'err', message: 'Nhập URL và API key trước khi kiểm tra' })
      return
    }
    setStatus({ kind: 'testing', message: 'Đang kiểm tra...' })
    const result = await probeServer(baseUrl, apiKey)
    if (result.reachable && result.authorized) {
      setStatus({ kind: 'ok', message: `Kết nối OK${result.service ? ` (${result.service})` : ''}` })
    } else if (result.reachable) {
      setStatus({ kind: 'warn', message: result.error || 'Server trả lời nhưng API key không hợp lệ' })
    } else {
      setStatus({ kind: 'err', message: result.error || 'Không kết nối được tới server' })
    }
  }

  async function handleSave() {
    if (!baseUrl.trim() || !apiKey.trim()) {
      setStatus({ kind: 'err', message: 'URL và API key không được để trống' })
      return
    }
    setSaving(true)
    setStatus({ kind: 'testing', message: 'Đang xác thực với server...' })
    const result = await probeServer(baseUrl, apiKey)
    setSaving(false)
    if (!result.reachable) {
      setStatus({ kind: 'err', message: result.error || 'Không kết nối được tới server' })
      return
    }
    if (!result.authorized) {
      setStatus({ kind: 'err', message: result.error || 'API key không hợp lệ' })
      return
    }
    const next: ServerSettings = { baseUrl: baseUrl.trim(), apiKey: apiKey.trim() }
    saveSettings(next)
    setStatus({ kind: 'ok', message: 'Đã lưu — đang kết nối...' })
    onSaved?.(next)
    onClose?.()
  }

  return (
    <div className="settings" role="dialog" aria-modal="true">
      <div className="settingsCard">
        <h1>
          <Server size={20} />
          Kết nối server Szalo
        </h1>
        <p className="lead">
          Nhập URL và API key của Szalo server. Server chạy độc lập và giữ phiên đăng nhập Zalo —
          desktop app này chỉ là giao diện.
        </p>

        <div className="settingsField">
          <label htmlFor="szalo-url">Server URL</label>
          <input
            id="szalo-url"
            type="url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={DEFAULT_URL_PLACEHOLDER}
            autoFocus
          />
          <small>Ví dụ: <code>http://192.168.1.50:13113</code></small>
        </div>

        <div className="settingsField">
          <label htmlFor="szalo-key">
            <KeyRound size={12} />
            API key
          </label>
          <input
            id="szalo-key"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="Khóa được cấu hình ở server"
            autoComplete="off"
          />
          <small>Khớp với <code>API_KEY</code> trong file <code>.env</code> của server.</small>
        </div>

        {status.kind !== 'idle' && status.message && (
          <div className={`settingsStatus ${status.kind}`}>
            {status.kind === 'ok' && <CheckCircle2 size={14} />}
            {status.message}
          </div>
        )}

        <div className="settingsActions">
          {dismissible && (
            <button type="button" className="ghost" onClick={onClose}>
              <X size={14} /> Đóng
            </button>
          )}
          <button type="button" onClick={handleTest} disabled={saving}>
            Kiểm tra
          </button>
          <button type="button" className="primary" onClick={handleSave} disabled={saving}>
            <Save size={14} /> Lưu &amp; kết nối
          </button>
        </div>
      </div>
    </div>
  )
}
