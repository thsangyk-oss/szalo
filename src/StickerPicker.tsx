/**
 * StickerPicker — search and send stickers.
 * Uses GET /api/stickers?q=keyword to search, POST /api/messages/sticker to send.
 */
import { useState } from 'react'
import { Search, X, Smile } from 'lucide-react'
import { apiUrl, authedInit } from './settings'

type Sticker = {
  id: number
  cateId: number
  type: number
  spriteUrl?: string
  url?: string
}

type Props = {
  threadId: string
  threadType: 'user' | 'group'
  onSent: () => void
  onClose: () => void
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(url), authedInit(init))
  const payload = await response.json().catch(() => null) as { error?: string } | null
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
  return payload as T
}

export default function StickerPicker({ threadId, threadType, onSent, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Sticker[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [sending, setSending] = useState<number | null>(null)

  function doSearch(q: string) {
    const trimmed = q.trim()
    if (!trimmed) {
      setResults([])
      setSearched(false)
      return
    }
    setLoading(true)
    setSearched(true)
    apiJson<Sticker[]>(`/api/stickers?q=${encodeURIComponent(trimmed)}`)
      .then((data) => setResults(Array.isArray(data) ? data : []))
      .catch(() => setResults([]))
      .finally(() => setLoading(false))
  }

  async function sendSticker(sticker: Sticker) {
    setSending(sticker.id)
    try {
      await apiJson('/api/messages/sticker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId,
          type: threadType,
          stickerId: sticker.id,
          cateId: sticker.cateId,
          stickerType: sticker.type ?? 7,
        }),
      })
      onSent()
    } catch { /* ignore */ }
    finally { setSending(null) }
  }

  return (
    <div className="stickerPicker">
      <div className="spHeader">
        <Smile size={14} /> <strong>Sticker</strong>
        <button type="button" onClick={onClose}><X size={14} /></button>
      </div>
      <div className="spSearch">
        <Search size={13} />
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); doSearch(e.target.value) }}
          placeholder="Tìm sticker..."
          autoFocus
        />
      </div>
      <div className="spGrid">
        {loading && <div className="spEmpty">Đang tìm...</div>}
        {!loading && searched && results.length === 0 && (
          <div className="spEmpty">Không tìm thấy sticker cho "{query}"</div>
        )}
        {!loading && !searched && (
          <div className="spEmpty">Gõ từ khóa để tìm sticker (VD: "hello", "love", "thanks")</div>
        )}
        {results.map((sticker) => (
          <button
            key={sticker.id}
            type="button"
            className="spItem"
            onClick={() => sendSticker(sticker)}
            disabled={sending === sticker.id}
            title={`Sticker #${sticker.id}`}
          >
            {(sticker.spriteUrl || sticker.url)
              ? <img src={sticker.spriteUrl || sticker.url} alt="" />
              : <span>🎨 {sticker.id}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}
