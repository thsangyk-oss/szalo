/**
 * MessageActions — hover overlay on each message bubble.
 * Shows: reply, reaction (quick pick), undo (if self).
 */
import { useState } from 'react'
import { CornerUpLeft, Smile, Trash2 } from 'lucide-react'
import { apiUrl, authedInit } from './settings'

type ThreadKind = 'user' | 'group'
type DeliveryStatus = 'sent' | 'delivered' | 'seen'

type ChatMessage = {
  id: string
  threadId: string
  type: ThreadKind
  senderName?: string
  senderId?: string
  text: string
  timestamp: number
  isSelf: boolean
  deliveryStatus?: DeliveryStatus
  attachments: Array<{ title?: string; href?: string; thumb?: string; type?: string; size?: string }>
  raw?: unknown
}

type Props = {
  message: ChatMessage
  onReply: (message: ChatMessage) => void
  onUndone: (messageId: string) => void
}

const QUICK_REACTIONS = [
  { key: 'HEART', emoji: '❤️' },
  { key: 'LIKE', emoji: '👍' },
  { key: 'HAHA', emoji: '😂' },
  { key: 'WOW', emoji: '😮' },
  { key: 'CRY', emoji: '😢' },
  { key: 'ANGRY', emoji: '😡' },
]

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(url), authedInit(init))
  const payload = await response.json().catch(() => null) as { error?: string } | null
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
  return payload as T
}

export default function MessageActions({ message, onReply, onUndone }: Props) {
  const [showReactions, setShowReactions] = useState(false)
  const [busy, setBusy] = useState(false)

  async function react(icon: string) {
    setShowReactions(false)
    try {
      await apiJson('/api/messages/reaction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId: message.threadId,
          type: message.type,
          msgId: message.id,
          icon,
        }),
      })
    } catch { /* ignore */ }
  }

  async function undo() {
    if (!confirm('Thu hồi tin nhắn này?')) return
    setBusy(true)
    try {
      // Extract cliMsgId from raw if available
      const raw = message.raw as { data?: { cliMsgId?: string } } | undefined
      await apiJson('/api/messages/undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId: message.threadId,
          type: message.type,
          msgId: message.id,
          cliMsgId: raw?.data?.cliMsgId || message.id,
        }),
      })
      onUndone(message.id)
    } catch { /* ignore */ }
    finally { setBusy(false) }
  }

  return (
    <span className="msgActions">
      <button type="button" className="msgActionBtn" onClick={() => onReply(message)} title="Trả lời">
        <CornerUpLeft size={13} />
      </button>
      <button type="button" className="msgActionBtn" onClick={() => setShowReactions(!showReactions)} title="Thả cảm xúc">
        <Smile size={13} />
      </button>
      {message.isSelf && (
        <button type="button" className="msgActionBtn danger" onClick={undo} disabled={busy} title="Thu hồi">
          <Trash2 size={13} />
        </button>
      )}
      {showReactions && (
        <span className="reactionPicker">
          {QUICK_REACTIONS.map((r) => (
            <button key={r.key} type="button" onClick={() => react(r.key)} title={r.key}>
              {r.emoji}
            </button>
          ))}
        </span>
      )}
    </span>
  )
}

export { QUICK_REACTIONS }
export type { ChatMessage as ActionChatMessage }
