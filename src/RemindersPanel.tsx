/**
 * RemindersPanel — list/create/delete reminders for the current thread.
 * Shown in the chat thread info section. CRM use-case: follow-up khách hàng.
 */
import { useEffect, useState } from 'react'
import { Bell, Plus, Trash2, X, Calendar } from 'lucide-react'
import { apiUrl, authedInit } from './settings'

type ThreadKind = 'user' | 'group'

type Reminder = {
  reminderId: string
  params?: { title?: string }
  emoji?: string
  startTime?: number
  endTime?: number
  repeat?: number
  creatorUid?: string
}

type Props = {
  threadId: string
  threadType: ThreadKind
  onClose: () => void
}

const REPEAT_OPTIONS = [
  { value: 0, label: 'Không lặp' },
  { value: 1, label: 'Hàng ngày' },
  { value: 2, label: 'Hàng tuần' },
  { value: 3, label: 'Hàng tháng' },
]

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(url), authedInit(init))
  const payload = await response.json().catch(() => null) as { error?: string } | null
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
  return payload as T
}

function formatStartTime(ts?: number) {
  if (!ts) return ''
  return new Date(ts).toLocaleString('vi-VN', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

// Local date-time → epoch ms. <input type="datetime-local"> gives "YYYY-MM-DDTHH:MM"
function localToEpoch(value: string): number {
  if (!value) return Date.now()
  return new Date(value).getTime()
}

function epochToLocalInput(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function RemindersPanel({ threadId, threadType, onClose }: Props) {
  const [list, setList] = useState<Reminder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Create-form state
  const [showForm, setShowForm] = useState(false)
  const [title, setTitle] = useState('')
  const [emoji, setEmoji] = useState('📅')
  const [whenLocal, setWhenLocal] = useState(() => epochToLocalInput(Date.now() + 60 * 60 * 1000))
  const [repeat, setRepeat] = useState(0)
  const [submitting, setSubmitting] = useState(false)

  function refresh() {
    setLoading(true)
    apiJson<Reminder[]>(`/api/reminders/${threadType}/${threadId}?count=50`)
      .then((data) => setList(Array.isArray(data) ? data : []))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    let cancelled = false
    apiJson<Reminder[]>(`/api/reminders/${threadType}/${threadId}?count=50`)
      .then((data) => {
        if (cancelled) return
        setList(Array.isArray(data) ? data : [])
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [threadId, threadType])

  async function createReminder() {
    if (!title.trim()) return
    setSubmitting(true)
    setError('')
    try {
      await apiJson('/api/reminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId, type: threadType,
          title: title.trim(),
          emoji,
          startTime: localToEpoch(whenLocal),
          repeat,
        }),
      })
      setTitle('')
      setShowForm(false)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  async function removeReminder(reminderId: string) {
    if (!confirm('Xóa reminder này?')) return
    try {
      await apiJson(`/api/reminders/${threadType}/${threadId}/${encodeURIComponent(reminderId)}`, {
        method: 'DELETE',
      })
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="modalBackdrop" onClick={onClose}>
      <div className="reminderModal" onClick={(e) => e.stopPropagation()}>
        <header className="reminderHeader">
          <Bell size={16} />
          <strong>Reminder / Follow-up</strong>
          <button type="button" onClick={onClose}><X size={16} /></button>
        </header>

        <div className="reminderToolbar">
          <button type="button" className="primary" onClick={() => setShowForm(!showForm)}>
            <Plus size={14} /> {showForm ? 'Hủy' : 'Tạo reminder mới'}
          </button>
        </div>

        {showForm && (
          <div className="reminderForm">
            <div className="formRow">
              <input
                value={emoji}
                onChange={(e) => setEmoji(e.target.value)}
                className="emojiInput"
                maxLength={2}
              />
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Nội dung reminder (VD: Gọi lại khách)"
                autoFocus
              />
            </div>
            <div className="formRow">
              <label>
                <Calendar size={12} /> Khi nào
                <input
                  type="datetime-local"
                  value={whenLocal}
                  onChange={(e) => setWhenLocal(e.target.value)}
                />
              </label>
              <label>
                Lặp lại
                <select value={repeat} onChange={(e) => setRepeat(Number(e.target.value))}>
                  {REPEAT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="formActions">
              <button type="button" onClick={createReminder} disabled={submitting || !title.trim()} className="primary">
                {submitting ? 'Đang tạo...' : 'Tạo reminder'}
              </button>
            </div>
          </div>
        )}

        {error && <div className="reminderError">{error}</div>}

        <div className="reminderList">
          {loading && <div className="reminderEmpty">Đang tải...</div>}
          {!loading && list.length === 0 && !error && (
            <div className="reminderEmpty">
              <Bell size={28} />
              <p>Chưa có reminder nào</p>
              <small>Tạo reminder để follow-up khách hàng</small>
            </div>
          )}
          {list.map((r) => (
            <div key={r.reminderId} className="reminderRow">
              <span className="reminderEmoji">{r.emoji || '📅'}</span>
              <div className="reminderBody">
                <strong>{r.params?.title || '(không có nội dung)'}</strong>
                <small>{formatStartTime(r.startTime)}</small>
                {r.repeat ? <small className="reminderRepeat">{REPEAT_OPTIONS[r.repeat]?.label || `Repeat ${r.repeat}`}</small> : null}
              </div>
              <button type="button" className="reminderDel" onClick={() => removeReminder(r.reminderId)}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
