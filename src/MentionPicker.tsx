/**
 * MentionPicker — group chat @mention autocomplete.
 *
 * When the user types "@" in a group composer, this dropdown appears showing
 * group members; typing more characters filters by name. Selecting a member
 * inserts "@<name> " into the composer at the cursor position and reports
 * the mention back so the parent can include {pos, uid, len} in the
 * sendMessage payload.
 */
import { useEffect, useState } from 'react'
import { Users, X } from 'lucide-react'
import { apiUrl, authedInit } from './settings'

export type GroupMember = {
  id: string
  displayName: string
  avatar?: string
  isAdmin?: boolean
}

type Props = {
  groupId: string
  query: string  // text after the "@" up to cursor (without "@")
  onSelect: (member: GroupMember) => void
  onClose: () => void
}

async function apiJson<T>(url: string): Promise<T> {
  const response = await fetch(apiUrl(url), authedInit())
  const payload = await response.json().catch(() => null) as { error?: string } | null
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
  return payload as T
}

const memberCache = new Map<string, GroupMember[]>()

export default function MentionPicker({ groupId, query, onSelect, onClose }: Props) {
  // We seed state from the cache so a re-open of the same group is instant.
  // The cache also doubles as our "is loaded?" flag.
  const cached = memberCache.get(groupId)
  const [members, setMembers] = useState<GroupMember[]>(cached ?? [])
  const [loading, setLoading] = useState<boolean>(!cached)

  useEffect(() => {
    if (memberCache.has(groupId)) return
    let cancelled = false
    apiJson<{ members?: GroupMember[] }>(`/api/groups/${groupId}`)
      .then((data) => {
        if (cancelled) return
        const list = data.members ?? []
        memberCache.set(groupId, list)
        setMembers(list)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setMembers([])
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [groupId])

  const lower = query.toLowerCase()
  const filtered = lower
    ? members.filter((m) => m.displayName.toLowerCase().includes(lower) || m.id.includes(lower))
    : members
  const top = filtered.slice(0, 10)

  return (
    <div className="mentionPicker">
      <div className="mpHeader">
        <Users size={13} /> <strong>Tag thành viên</strong>
        <small>{filtered.length}/{members.length}</small>
        <button type="button" onClick={onClose}><X size={12} /></button>
      </div>
      {loading ? (
        <div className="mpEmpty">Đang tải thành viên...</div>
      ) : top.length === 0 ? (
        <div className="mpEmpty">{query ? `Không có ai khớp "${query}"` : 'Nhóm chưa có thành viên'}</div>
      ) : (
        <div className="mpList">
          {top.map((member) => (
            <button
              key={member.id}
              type="button"
              className="mpItem"
              onMouseDown={(e) => {
                // mousedown so the click registers before the textarea blur
                e.preventDefault()
                onSelect(member)
              }}
            >
              <span className="mpAvatar">
                {member.avatar ? <img src={member.avatar} alt="" /> : member.displayName.slice(0, 1).toUpperCase()}
              </span>
              <span className="mpName">{member.displayName}</span>
              {member.isAdmin && <small className="mpAdmin">Admin</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
