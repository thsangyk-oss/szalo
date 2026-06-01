/**
 * GroupMembersModal — full list of group members with search + click-to-chat.
 *
 * Triggered from the group info section. Loads from GET /api/groups/:id which
 * already returns up to 200 members (truncated for very large groups).
 */
import { useEffect, useState } from 'react'
import { Search, X, MessageCircle, Users, Crown } from 'lucide-react'
import { apiUrl, authedInit } from './settings'

type Member = {
  id: string
  displayName: string
  zaloName?: string
  avatar?: string
  isAdmin?: boolean
}

type GroupDetail = {
  id: string
  name: string
  totalMember: number
  adminIds: string[]
  members: Member[]
  truncated: boolean
}

type Props = {
  groupId: string
  groupName: string
  onOpenChat: (userId: string, displayName: string, avatar?: string) => void
  onClose: () => void
}

async function apiJson<T>(url: string): Promise<T> {
  const response = await fetch(apiUrl(url), authedInit())
  const payload = await response.json().catch(() => null) as { error?: string } | null
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
  return payload as T
}

const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #7c5cff 0%, #b45cff 100%)',
  'linear-gradient(135deg, #5cb3ff 0%, #5c7cff 100%)',
  'linear-gradient(135deg, #34d399 0%, #06b6d4 100%)',
  'linear-gradient(135deg, #fbbf24 0%, #f97316 100%)',
  'linear-gradient(135deg, #ec4899 0%, #f43f5e 100%)',
  'linear-gradient(135deg, #8b5cf6 0%, #d946ef 100%)',
]
function avatarGradient(seed: string) {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = ((hash << 5) - hash) + seed.charCodeAt(i)
  return AVATAR_GRADIENTS[Math.abs(hash | 0) % AVATAR_GRADIENTS.length]
}

export default function GroupMembersModal({ groupId, groupName, onOpenChat, onClose }: Props) {
  const [detail, setDetail] = useState<GroupDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')

  useEffect(() => {
    let cancelled = false
    apiJson<GroupDetail>(`/api/groups/${groupId}`)
      .then((data) => {
        if (cancelled) return
        setDetail(data)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [groupId])

  const query = filter.trim().toLowerCase()
  const allMembers = detail?.members ?? []
  // Admins first, then alpha by name. Admins get a crown icon.
  const sorted = [...allMembers].sort((a, b) => {
    if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1
    return a.displayName.localeCompare(b.displayName, 'vi')
  })
  const filtered = query
    ? sorted.filter((m) => m.displayName.toLowerCase().includes(query) || m.id.includes(query))
    : sorted

  return (
    <div className="modalBackdrop" onClick={onClose}>
      <div className="memberModal" onClick={(e) => e.stopPropagation()}>
        <header className="memberModalHeader">
          <div>
            <strong>{groupName}</strong>
            <small>
              {detail
                ? `${filtered.length} / ${detail.totalMember || allMembers.length} thành viên${detail.truncated ? ' (đã giới hạn)' : ''}`
                : 'Đang tải...'}
            </small>
          </div>
          <button type="button" onClick={onClose}><X size={16} /></button>
        </header>

        <div className="memberModalSearch">
          <Search size={14} />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Tìm thành viên theo tên hoặc ID..."
            autoFocus
          />
        </div>

        <div className="memberModalList">
          {loading && <div className="memberModalEmpty"><Users size={28} /><p>Đang tải...</p></div>}
          {error && <div className="memberModalEmpty"><p style={{ color: '#fca5a5' }}>{error}</p></div>}
          {!loading && !error && filtered.length === 0 && (
            <div className="memberModalEmpty">
              <Users size={28} />
              <p>{query ? `Không tìm thấy "${query}"` : 'Nhóm chưa có thành viên'}</p>
            </div>
          )}
          {filtered.map((member) => (
            <div key={member.id} className="memberRow">
              <span className="memberAvatarLg" style={!member.avatar ? { background: avatarGradient(member.id) } : undefined}>
                {member.avatar
                  ? <img src={member.avatar} alt="" />
                  : member.displayName.slice(0, 1).toUpperCase()}
              </span>
              <div className="memberInfo">
                <strong>
                  {member.displayName}
                  {member.isAdmin && <Crown size={11} style={{ marginLeft: 6, color: '#fbbf24' }} />}
                </strong>
                {member.zaloName && member.zaloName !== member.displayName && <small>{member.zaloName}</small>}
                <small className="memberId">{member.id}</small>
              </div>
              <button
                type="button"
                className="memberChatBtn"
                onClick={() => onOpenChat(member.id, member.displayName, member.avatar)}
                title="Mở chat 1-1"
              >
                <MessageCircle size={14} /> Chat
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
