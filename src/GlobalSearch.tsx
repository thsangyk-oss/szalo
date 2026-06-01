/**
 * GlobalSearch — search messages across all threads.
 * Calls GET /api/search/messages?q=...
 */
import { useState, useRef } from 'react'
import { Search, X, MessageCircle } from 'lucide-react'
import { apiUrl, authedInit } from './settings'

type ThreadKind = 'user' | 'group'

type SearchResult = {
  id: string
  threadId: string
  type: ThreadKind
  senderName?: string
  text: string
  timestamp: number
  isSelf: boolean
  conversationName?: string
}

type Props = {
  onOpenThread: (threadId: string, type: ThreadKind) => void
  onClose: () => void
}

async function apiJson<T>(url: string): Promise<T> {
  const response = await fetch(apiUrl(url), authedInit())
  const payload = await response.json().catch(() => null) as { error?: string } | null
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
  return payload as T
}

export default function GlobalSearch({ onOpenThread, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function doSearch(q: string) {
    const trimmed = q.trim()
    if (trimmed.length < 2) {
      setResults([])
      setSearched(false)
      return
    }
    setLoading(true)
    setSearched(true)
    apiJson<SearchResult[]>(`/api/search/messages?q=${encodeURIComponent(trimmed)}&limit=50`)
      .then(setResults)
      .catch(() => setResults([]))
      .finally(() => setLoading(false))
  }

  function handleInput(value: string) {
    setQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(value), 400)
  }

  return (
    <div className="globalSearch">
      <header className="globalSearchHeader">
        <Search size={16} />
        <input
          value={query}
          onChange={(e) => handleInput(e.target.value)}
          placeholder="Tìm tin nhắn trong tất cả hội thoại..."
          autoFocus
        />
        <button type="button" onClick={onClose} title="Đóng"><X size={16} /></button>
      </header>
      <div className="globalSearchResults">
        {loading && <div className="gsEmpty">Đang tìm...</div>}
        {!loading && searched && results.length === 0 && (
          <div className="gsEmpty">
            <MessageCircle size={24} />
            <p>Không tìm thấy kết quả</p>
          </div>
        )}
        {results.map((result) => (
          <button
            key={`${result.id}-${result.threadId}`}
            type="button"
            className="gsResult"
            onClick={() => onOpenThread(result.threadId, result.type)}
          >
            <div className="gsResultHeader">
              <strong>{result.conversationName || result.threadId}</strong>
              <small>{new Date(result.timestamp).toLocaleString('vi-VN')}</small>
            </div>
            <div className="gsResultBody">
              <span className="gsResultSender">{result.isSelf ? 'Bạn' : (result.senderName || '?')}: </span>
              <span>{result.text.length > 120 ? result.text.slice(0, 117) + '...' : result.text}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
