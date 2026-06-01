/**
 * QuickReplyPicker — shows saved quick replies when user types "/" in composer.
 * Clicking one inserts the reply text into the message field.
 */
import { useEffect, useState } from 'react'
import { Zap, X } from 'lucide-react'
import { apiUrl, authedInit } from './settings'

type QuickMessage = {
  id: number
  keyword: string
  title: string
}

type Props = {
  filter: string
  onSelect: (text: string) => void
  onClose: () => void
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(url), authedInit(init))
  const payload = await response.json().catch(() => null) as { error?: string } | null
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
  return payload as T
}

export default function QuickReplyPicker({ filter, onSelect, onClose }: Props) {
  const [items, setItems] = useState<QuickMessage[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiJson<{ items?: QuickMessage[]; item?: QuickMessage[] }>('/api/quick-messages')
      .then((data) => {
        const list = data.items ?? data.item ?? []
        setItems(Array.isArray(list) ? list : [])
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }, [])

  const query = filter.replace(/^\//, '').toLowerCase()
  const filtered = query
    ? items.filter((item) => item.keyword.toLowerCase().includes(query) || item.title.toLowerCase().includes(query))
    : items

  if (loading) {
    return (
      <div className="quickReplyPicker">
        <div className="qrpHeader">
          <Zap size={14} /> <strong>Trả lời nhanh</strong>
          <button type="button" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="qrpEmpty">Đang tải...</div>
      </div>
    )
  }

  return (
    <div className="quickReplyPicker">
      <div className="qrpHeader">
        <Zap size={14} /> <strong>Trả lời nhanh</strong>
        <small>{filtered.length}/{items.length}</small>
        <button type="button" onClick={onClose}><X size={14} /></button>
      </div>
      {filtered.length === 0 ? (
        <div className="qrpEmpty">
          {items.length === 0
            ? 'Chưa có mẫu nào. Tạo trong Zalo → Cài đặt → Tin nhắn nhanh.'
            : `Không tìm thấy mẫu cho "${query}"`}
        </div>
      ) : (
        <div className="qrpList">
          {filtered.map((item) => (
            <button
              key={item.id}
              type="button"
              className="qrpItem"
              onClick={() => onSelect(item.title)}
            >
              <span className="qrpKeyword">/{item.keyword}</span>
              <span className="qrpTitle">{item.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
