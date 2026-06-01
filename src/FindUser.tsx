/**
 * FindUser — search for Zalo users by phone number or username.
 * Allows sending friend requests and opening a chat.
 */
import { useState } from 'react'
import { Search, UserPlus, MessageCircle, X } from 'lucide-react'
import { apiUrl, authedInit } from './settings'

type FoundUser = {
  uid?: string
  userId?: string
  displayName?: string
  zaloName?: string
  avatar?: string
  phoneNumber?: string
  isFr?: number
}

type Props = {
  onOpenChat: (userId: string, name: string) => void
  onClose: () => void
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(url), authedInit(init))
  const payload = await response.json().catch(() => null) as { error?: string } | null
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
  return payload as T
}

export default function FindUser({ onOpenChat, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<FoundUser | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [friendSent, setFriendSent] = useState(false)

  async function doSearch() {
    const trimmed = query.trim()
    if (!trimmed) return
    setLoading(true)
    setError('')
    setResult(null)
    setFriendSent(false)
    try {
      const isPhone = /^[+0-9\s-]{8,}$/.test(trimmed)
      const params = isPhone ? `phone=${encodeURIComponent(trimmed)}` : `username=${encodeURIComponent(trimmed)}`
      const data = await apiJson<FoundUser>(`/api/users/find?${params}`)
      setResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function sendFriendRequest() {
    if (!result) return
    const userId = result.uid || result.userId || ''
    if (!userId) return
    try {
      await apiJson('/api/friends/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, message: 'Xin chào, tôi muốn kết bạn!' }),
      })
      setFriendSent(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const userId = result?.uid || result?.userId || ''
  const displayName = result?.displayName || result?.zaloName || userId

  return (
    <div className="findUserPanel">
      <header className="fuHeader">
        <Search size={16} />
        <strong>Tìm người dùng Zalo</strong>
        <button type="button" onClick={onClose}><X size={16} /></button>
      </header>
      <div className="fuBody">
        <div className="fuSearch">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') doSearch() }}
            placeholder="Nhập số điện thoại hoặc username..."
            autoFocus
          />
          <button type="button" onClick={doSearch} disabled={loading} className="primary">
            {loading ? '...' : 'Tìm'}
          </button>
        </div>

        {error && <div className="fuError">{error}</div>}

        {result && (
          <div className="fuResult">
            <div className="fuAvatar">
              {result.avatar
                ? <img src={result.avatar} alt="" />
                : <span>{displayName.slice(0, 1).toUpperCase()}</span>}
            </div>
            <div className="fuInfo">
              <strong>{displayName}</strong>
              {result.zaloName && result.zaloName !== displayName && <small>{result.zaloName}</small>}
              {result.phoneNumber && <small>📱 {result.phoneNumber}</small>}
              <small>{result.isFr === 1 ? '✔ Đã là bạn bè' : 'Chưa kết bạn'}</small>
            </div>
            <div className="fuActions">
              {result.isFr === 1 ? (
                <button type="button" onClick={() => onOpenChat(userId, displayName)}>
                  <MessageCircle size={14} /> Chat
                </button>
              ) : (
                <>
                  <button type="button" onClick={sendFriendRequest} disabled={friendSent}>
                    <UserPlus size={14} /> {friendSent ? 'Đã gửi' : 'Kết bạn'}
                  </button>
                  <button type="button" onClick={() => onOpenChat(userId, displayName)}>
                    <MessageCircle size={14} /> Chat
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {!result && !loading && !error && (
          <div className="fuHint">
            Nhập số điện thoại (VD: 0966299100) hoặc username Zalo để tìm kiếm.
          </div>
        )}
      </div>
    </div>
  )
}
