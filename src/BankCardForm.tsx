/**
 * BankCardForm — modal to compose and send a Vietnamese bank account card
 * to the current thread. Uses /api/bank-bins for the bank dropdown and
 * /api/messages/bank-card to send.
 */
import { useEffect, useState } from 'react'
import { X, CreditCard } from 'lucide-react'
import { apiUrl, authedInit } from './settings'

type Bank = { name: string; bin: number }

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

export default function BankCardForm({ threadId, threadType, onSent, onClose }: Props) {
  const [banks, setBanks] = useState<Bank[]>([])
  const [bin, setBin] = useState<number>(0)
  const [accountNumber, setAccountNumber] = useState('')
  const [accountName, setAccountName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    apiJson<Bank[]>('/api/bank-bins')
      .then((data) => {
        if (cancelled) return
        const sorted = [...data].sort((a, b) => a.name.localeCompare(b.name))
        setBanks(sorted)
        if (sorted.length > 0) setBin(sorted[0].bin)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => { cancelled = true }
  }, [])

  async function send() {
    if (!bin || !accountNumber.trim()) return
    setSubmitting(true)
    setError('')
    try {
      await apiJson('/api/messages/bank-card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId,
          type: threadType,
          binBank: bin,
          numAccBank: accountNumber.trim(),
          nameAccBank: accountName.trim() || undefined,
        }),
      })
      onSent()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modalBackdrop" onClick={onClose}>
      <div className="reminderModal" onClick={(e) => e.stopPropagation()}>
        <header className="reminderHeader">
          <CreditCard size={16} />
          <strong>Gửi STK Ngân hàng</strong>
          <button type="button" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="reminderForm">
          <label style={{ fontSize: '0.78rem', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 4 }}>
            Ngân hàng
            <select value={bin} onChange={(e) => setBin(Number(e.target.value))}>
              {banks.map((b) => (
                <option key={b.bin} value={b.bin}>{b.name} ({b.bin})</option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: '0.78rem', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 4 }}>
            Số tài khoản
            <input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder="VD: 0123456789" autoFocus />
          </label>
          <label style={{ fontSize: '0.78rem', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 4 }}>
            Tên chủ tài khoản (tùy chọn)
            <input value={accountName} onChange={(e) => setAccountName(e.target.value)} placeholder="VD: NGUYEN VAN A" />
          </label>
          {error && <div className="reminderError">{error}</div>}
          <div className="formActions">
            <button type="button" onClick={send} disabled={submitting || !accountNumber.trim()} className="primary">
              {submitting ? 'Đang gửi...' : 'Gửi STK'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
