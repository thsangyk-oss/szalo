/**
 * AutoReplyPanel — manage automatic reply rules.
 *
 * Wraps zca-js's auto-reply API (already exposed by the server at
 * /api/auto-reply). Useful for "ngoài giờ làm việc" replies in CRM mode.
 */
import { useEffect, useState } from 'react'
import { Plus, Trash2, X, Clock } from 'lucide-react'
import { apiUrl, authedInit } from './settings'

type AutoReplyItem = {
  id: number
  enable: boolean
  startTime: number
  endTime: number
  content: string
  scope: number
  uids: string[] | null
}

type Props = {
  onClose: () => void
}

const SCOPE_OPTIONS = [
  { value: 0, label: 'Mọi người' },
  { value: 1, label: 'Người lạ' },
  { value: 2, label: 'Bạn bè cụ thể' },
  { value: 3, label: 'Bạn bè trừ những người này' },
]

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(url), authedInit(init))
  const payload = await response.json().catch(() => null) as { error?: string } | null
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
  return payload as T
}

function formatRange(start?: number, end?: number) {
  if (!start && !end) return 'Luôn bật'
  const fmt = (t: number) => new Date(t).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  return `${start ? fmt(start) : '—'} → ${end ? fmt(end) : '—'}`
}

function epochToLocalInput(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function AutoReplyPanel({ onClose }: Props) {
  const [items, setItems] = useState<AutoReplyItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Create-form state
  const [showForm, setShowForm] = useState(false)
  const [content, setContent] = useState('Cảm ơn bạn đã nhắn. Hiện tôi không có mặt, sẽ phản hồi sớm nhất.')
  const [scope, setScope] = useState(0)
  const [enable, setEnable] = useState(true)
  const [useSchedule, setUseSchedule] = useState(false)
  const [startLocal, setStartLocal] = useState(() => epochToLocalInput(Date.now()))
  const [endLocal, setEndLocal] = useState(() => epochToLocalInput(Date.now() + 8 * 60 * 60 * 1000))
  const [submitting, setSubmitting] = useState(false)

  function refresh() {
    setLoading(true)
    apiJson<{ item?: AutoReplyItem[]; items?: AutoReplyItem[] }>(`/api/auto-reply`)
      .then((data) => {
        const list = data.items ?? data.item ?? []
        setItems(Array.isArray(list) ? list : [])
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    let cancelled = false
    apiJson<{ item?: AutoReplyItem[]; items?: AutoReplyItem[] }>(`/api/auto-reply`)
      .then((data) => {
        if (cancelled) return
        const list = data.items ?? data.item ?? []
        setItems(Array.isArray(list) ? list : [])
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  async function createRule() {
    if (!content.trim()) return
    setSubmitting(true)
    setError('')
    try {
      const body: Record<string, unknown> = { content: content.trim(), isEnable: enable, scope }
      if (useSchedule) {
        body.startTime = new Date(startLocal).getTime()
        body.endTime = new Date(endLocal).getTime()
      }
      await apiJson('/api/auto-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      setShowForm(false)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  async function removeRule(id: number) {
    if (!confirm('Xóa rule auto-reply này?')) return
    try {
      await apiJson(`/api/auto-reply/${id}`, { method: 'DELETE' })
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="modalBackdrop" onClick={onClose}>
      <div className="reminderModal" onClick={(e) => e.stopPropagation()}>
        <header className="reminderHeader">
          <Clock size={16} />
          <strong>Auto-Reply</strong>
          <small style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>{items.length} rule</small>
          <button type="button" onClick={onClose}><X size={16} /></button>
        </header>

        <div className="reminderToolbar">
          <button type="button" className="primary" onClick={() => setShowForm(!showForm)}>
            <Plus size={14} /> {showForm ? 'Hủy' : 'Tạo rule mới'}
          </button>
        </div>

        {showForm && (
          <div className="reminderForm">
            <div>
              <label style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Nội dung trả lời</label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={3}
                style={{
                  width: '100%', padding: '8px 11px',
                  border: '1px solid var(--border-light)', borderRadius: 9,
                  background: 'var(--bg-primary)', color: 'var(--text-primary)',
                  font: 'inherit', fontSize: '0.85rem', outline: 'none', resize: 'vertical',
                }}
              />
            </div>
            <div className="formRow">
              <label>
                Phạm vi
                <select value={scope} onChange={(e) => setScope(Number(e.target.value))}>
                  {SCOPE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </label>
              <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={enable} onChange={(e) => setEnable(e.target.checked)} />
                Bật ngay
              </label>
            </div>
            <div className="formRow" style={{ alignItems: 'center' }}>
              <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={useSchedule} onChange={(e) => setUseSchedule(e.target.checked)} />
                Lịch (chỉ trả lời trong khoảng thời gian)
              </label>
            </div>
            {useSchedule && (
              <div className="formRow">
                <label>
                  Bắt đầu
                  <input type="datetime-local" value={startLocal} onChange={(e) => setStartLocal(e.target.value)} />
                </label>
                <label>
                  Kết thúc
                  <input type="datetime-local" value={endLocal} onChange={(e) => setEndLocal(e.target.value)} />
                </label>
              </div>
            )}
            <div className="formActions">
              <button type="button" onClick={createRule} disabled={submitting || !content.trim()} className="primary">
                {submitting ? 'Đang tạo...' : 'Tạo rule'}
              </button>
            </div>
          </div>
        )}

        {error && <div className="reminderError">{error}</div>}

        <div className="reminderList">
          {loading && <div className="reminderEmpty">Đang tải...</div>}
          {!loading && items.length === 0 && !error && (
            <div className="reminderEmpty">
              <Clock size={28} />
              <p>Chưa có rule auto-reply</p>
              <small>Tạo rule để trả lời tự động ngoài giờ hoặc với người lạ</small>
            </div>
          )}
          {items.map((rule) => (
            <div key={rule.id} className="reminderRow">
              <span className="reminderEmoji">{rule.enable ? '🟢' : '⚪'}</span>
              <div className="reminderBody">
                <strong>{rule.content}</strong>
                <small>{SCOPE_OPTIONS[rule.scope]?.label || `Scope ${rule.scope}`}</small>
                <small className="reminderRepeat">{formatRange(rule.startTime, rule.endTime)}</small>
              </div>
              <button type="button" className="reminderDel" onClick={() => removeRule(rule.id)}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
