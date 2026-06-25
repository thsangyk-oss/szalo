import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClipboardEvent, DragEvent, MouseEvent as ReactMouseEvent } from 'react'
import { lazy, memo, Suspense, useDeferredValue } from 'react'
import { Activity, Bell, BellOff, Calendar, CheckCheck, CircleDot, CreditCard, FileUp, Info, LogOut, MessageCircle, Mic, MoreHorizontal, Paperclip, Pin, PinOff, Plus, Power, RefreshCw, Search, Send, Settings as SettingsIcon, Smile, Tag, X, Users } from 'lucide-react'
import type { Socket } from 'socket.io-client'
import { apiUrl, authedInit, getSettings, isConfigured } from './settings'
import { forceReconnectSocket, subscribeSocket } from './socket'
import MessageActions from './MessageActions'
import type { GroupMember } from './MentionPicker'
import { parseStyles, applyFormatting } from './formatting'
import './App.css'
import './ui/shell.css'
import './ui/sidebar.css'
import './ui/chat.css'
import './ui/composer.css'
import './ui/modals.css'
import './ui/chrome.css'

const SettingsScreen = lazy(() => import('./SettingsScreen'))
const GlobalSearch = lazy(() => import('./GlobalSearch'))
const QuickReplyPicker = lazy(() => import('./QuickReplyPicker'))
const FindUser = lazy(() => import('./FindUser'))
const MentionPicker = lazy(() => import('./MentionPicker'))
const GroupMembersModal = lazy(() => import('./GroupMembersModal'))
const StickerPicker = lazy(() => import('./StickerPicker'))
const RemindersPanel = lazy(() => import('./RemindersPanel'))
const AutoReplyPanel = lazy(() => import('./AutoReplyPanel'))
const BankCardForm = lazy(() => import('./BankCardForm'))
const VoiceRecorder = lazy(() => import('./VoiceRecorder'))

// Electron bridge (available when running inside Electron shell)
const electron = (window as unknown as { electronAPI?: {
  sendNotification: (data: { title: string; body: string; threadId?: string; type?: string; avatar?: string }) => void
  setUnreadCount: (count: number) => void
  flashFrame: () => void
  closeWindow?: () => void
  minimizeWindow?: () => void
  toggleMaximizeWindow?: () => void
  isWindowMaximized?: () => boolean
  onWindowMaximizeChange?: (cb: (isMaximized: boolean) => void) => () => void
  onOpenThread: (cb: (data: { threadId: string; type: string }) => void) => () => void
  onMainWindowVisibility?: (cb: (data: { visible: boolean; focused: boolean; reason?: string }) => void) => () => void
  openBubble: (data: { threadId: string; type: string; name: string; avatar?: string }) => void
  openBubblePanel: () => void
  closeBubblePanel: () => void
  removeBubble: (threadId: string) => void
  closeAllBubbles: () => void
  moveBubbleDock: (dx: number, dy: number) => void
  getBubbleThreads: () => Array<{ threadId: string; type: string; name: string; avatar?: string }>
  onBubbleThreads: (cb: (data: Array<{ threadId: string; type: string; name: string; avatar?: string }>) => void) => () => void
  onBubbleClosed: (cb: () => void) => () => void
  isElectron: boolean
} }).electronAPI

const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_FILE_COUNT = 10
const SOCKET_HEARTBEAT_INTERVAL_MS = 60 * 1000
const SOCKET_STALE_MS = 5 * 60 * 1000
const MESSAGE_RENDER_BATCH = 160
const MESSAGE_RENDER_STEP = 160
const MESSAGE_PAGE_LIMIT = 220
const CONVERSATION_RENDER_BATCH = 180
const CONVERSATION_RENDER_STEP = 180
const CONTACT_RENDER_BATCH = 180
const CONTACT_RENDER_STEP = 180

type ThreadKind = 'user' | 'group'
type ConversationFilter = 'all' | ThreadKind
type DeliveryStatus = 'sent' | 'delivered' | 'seen'

type Status = {
  state: 'offline' | 'waiting_qr' | 'scanned' | 'online' | 'error'
  account: unknown
  selfId: string
  qrImage: string
  error: string
  serverStartedAt?: string
  counts?: {
    total: number
    users: number
    groups: number
  }
}

type Conversation = {
  id: string
  type: ThreadKind
  name: string
  avatar?: string
  lastMessage?: string
  lastTimestamp?: number
  unread: number
  manualUnread?: boolean
  muted?: boolean
  pinned?: boolean
}

type ZaloContact = {
  id?: string | number
  userId?: string | number
  displayName?: string
  zaloName?: string
  avatar?: string
  phoneNumber?: string | number
  status?: string
}

type ChatMessage = {
  id: string
  threadId: string
  type: ThreadKind
  senderId?: string
  senderName?: string
  text: string
  timestamp: number
  isSelf: boolean
  deliveryStatus?: DeliveryStatus
  attachments: Array<{ title?: string; href?: string; thumb?: string; type?: string; size?: string }>
  reactions?: Record<string, string[]>  // icon → [userId, ...]
  raw?: unknown
}

type MessagePage = {
  messages: ChatMessage[]
  hasMore: boolean
  total: number
}

type TypingEvent = {
  threadId: string
  isSelf: boolean
}

type MessageStatusEvent = {
  threadId: string
  ids: string[]
  status: DeliveryStatus
}

type Health = {
  state: Status['state']
  selfId: string
  serverStartedAt: string
  counts: { total: number; users: number; groups: number }
  messageStats: { total: number; self: number; received: number; lastSelfTimestamp?: number }
  recentSends: Array<{ ts: number; threadId: string; type: ThreadKind; textLength: number; fileCount: number; status: string; error?: string }>
  recentClientEvents: Array<{ ts: number; event: string; detail?: unknown }>
  recentListenerEvents: Array<{ ts: number; event: string; detail?: unknown }>
}

type GroupDetail = {
  id: string
  name: string
  description?: string
  avatar?: string
  totalMember: number
  maxMember: number
  adminIds: string[]
  creatorId: string
  createdTime: number
  setting: {
    lockSendMsg: number
    joinAppr: number
    lockViewMember: number
    signAdminMsg: number
  }
  members: Array<{
    id: string
    displayName: string
    zaloName?: string
    avatar?: string
    isAdmin?: boolean
  }>
  truncated: boolean
  warning?: string
}

type UserDetail = {
  id: string
  username?: string
  displayName: string
  zaloName?: string
  avatar?: string
  cover?: string
  phoneNumber?: string
  status?: string
  gender?: number
  birthday?: string
  isFriend: boolean
  isBlocked: boolean
  isActive: boolean
  isActivePC: boolean
  isActiveWeb: boolean
  accountStatus?: number
  lastActionTime?: number
  lastUpdateTime?: number
}

type AppNotification = {
  id: string
  ts: number
  kind: 'message' | 'group' | 'friend' | 'system'
  title: string
  body: string
  threadId?: string
  type?: ThreadKind
  avatar?: string
  read: boolean
}

type Category = {
  id: string
  name: string
  color: string
  threadIds: string[]
}

const CATEGORY_COLORS = ['#7c5cff', '#ff4d6a', '#34d399', '#fbbf24', '#3b82f6', '#f97316', '#ec4899', '#06b6d4']

// Categories are now stored server-side keyed by the Zalo account, so logging
// into the same account on any machine restores the same channels. We keep a
// localStorage copy as an offline cache / first-paint value, but the server is
// authoritative once the account is known.
function loadCategories(): Category[] {
  try {
    const raw = localStorage.getItem('zalo-categories')
    return raw ? JSON.parse(raw) as Category[] : []
  } catch { return [] }
}

function cacheCategories(categories: Category[]) {
  try {
    localStorage.setItem('zalo-categories', JSON.stringify(categories))
  } catch { /* ignore quota */ }
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(url), authedInit(init))
  const payload = await response.json().catch(() => null) as { error?: string } | null
  if (!response.ok) {
    throw new Error(payload?.error || `HTTP ${response.status}`)
  }
  return payload as T
}

function reportClientEvent(event: string, detail?: unknown) {
  if (!isConfigured()) return
  fetch(apiUrl('/api/client-events'), authedInit({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, detail }),
  })).catch(() => undefined)
}

function attachmentUrl(href?: string, title?: string) {
  if (!href) return undefined
  const settings = getSettings()
  const key = settings.apiKey ? `&api_key=${encodeURIComponent(settings.apiKey)}` : ''
  if (!href.startsWith('http')) {
    // Relative server path (e.g. /downloads/...) — append the key as a query
    // param because <img>/<a> don't carry our auth header.
    const sep = href.includes('?') ? '&' : '?'
    return `${apiUrl(href)}${settings.apiKey ? `${sep}api_key=${encodeURIComponent(settings.apiKey)}` : ''}`
  }
  const params = new URLSearchParams({ url: href })
  if (title) params.set('name', title)
  return `${apiUrl('/api/attachments/proxy')}?${params.toString()}${key}`
}

function isImageAttachment(attachment: ChatMessage['attachments'][number]) {
  const value = `${attachment.type ?? ''} ${attachment.href ?? ''} ${attachment.thumb ?? ''}`.toLowerCase()
  return value.includes('image') || /\.(png|jpe?g|gif|webp)(\?|$)/.test(value)
}

function appendMessage(list: ChatMessage[], message: ChatMessage) {
  if (list.some((item) => item.id === message.id)) return list
  return [...list, message]
}

function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]) {
  if (incoming.length === 0) return existing
  const byId = new Map(existing.map((message) => [message.id, message]))
  let changed = false
  for (const message of incoming) {
    const current = byId.get(message.id)
    if (!current) {
      byId.set(message.id, message)
      changed = true
    } else if (current !== message) {
      byId.set(message.id, { ...current, ...message })
      changed = true
    }
  }
  if (!changed) return existing
  return Array.from(byId.values()).sort((a, b) => a.timestamp - b.timestamp)
}

function latestMessageTimestamp(list: ChatMessage[]) {
  return list.reduce((latest, message) => Math.max(latest, message.timestamp || 0), 0)
}

function trimSet<T>(set: Set<T>, maxSize: number, keepSize: number) {
  if (set.size <= maxSize) return
  let removeCount = set.size - keepSize
  for (const item of set) {
    set.delete(item)
    removeCount -= 1
    if (removeCount <= 0) break
  }
}

function deliveryLabel(status?: DeliveryStatus) {
  if (status === 'seen') return 'Đã xem'
  if (status === 'delivered') return 'Đã nhận'
  if (status === 'sent') return 'Đã gửi'
  return ''
}

function deliveryRank(status?: DeliveryStatus) {
  if (status === 'seen') return 3
  if (status === 'delivered') return 2
  if (status === 'sent') return 1
  return 0
}

function updateMessageStatus(list: ChatMessage[], event: MessageStatusEvent) {
  let changed = false
  const updated = list.map((message) => {
    if (message.threadId !== event.threadId || !event.ids.includes(message.id) || deliveryRank(message.deliveryStatus) >= deliveryRank(event.status)) return message
    changed = true
    return { ...message, deliveryStatus: event.status }
  })
  return changed ? updated : list
}

function markConversationRead(list: Conversation[], threadId: string) {
  let changed = false
  const updated = list.map((conversation) => {
    if (conversation.id !== threadId) return conversation
    if (conversation.unread === 0 && !conversation.manualUnread) return conversation
    changed = true
    return { ...conversation, unread: 0, manualUnread: false }
  })
  return changed ? updated : list
}

function sameStatus(a: Status, b: Status) {
  return a.state === b.state
    && a.selfId === b.selfId
    && a.qrImage === b.qrImage
    && a.error === b.error
    && a.serverStartedAt === b.serverStartedAt
    && (a.counts?.total ?? 0) === (b.counts?.total ?? 0)
    && (a.counts?.users ?? 0) === (b.counts?.users ?? 0)
    && (a.counts?.groups ?? 0) === (b.counts?.groups ?? 0)
}

function sameConversation(a: Conversation, b: Conversation) {
  return a.id === b.id
    && a.type === b.type
    && a.name === b.name
    && a.avatar === b.avatar
    && a.lastMessage === b.lastMessage
    && a.lastTimestamp === b.lastTimestamp
    && a.unread === b.unread
    && a.manualUnread === b.manualUnread
    && a.muted === b.muted
    && a.pinned === b.pinned
}

function sameConversationList(a: Conversation[], b: Conversation[]) {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    if (!sameConversation(a[index], b[index])) return false
  }
  return true
}

function replaceConversation(list: Conversation[], nextConversation: Conversation) {
  let changed = false
  const updated = list.map((conversation) => {
    if (conversation.id !== nextConversation.id) return conversation
    if (sameConversation(conversation, nextConversation)) return conversation
    changed = true
    return nextConversation
  })
  return changed ? updated : list
}

function groupConversationsFirst(list: Conversation[]) {
  return list
    .map((conversation, index) => ({ conversation, index }))
    .sort((a, b) => {
      const aRank = a.conversation.type === 'group' ? 0 : 1
      const bRank = b.conversation.type === 'group' ? 0 : 1
      return aRank === bRank ? a.index - b.index : aRank - bRank
    })
    .map(({ conversation }) => conversation)
}

function sortConversationsByLatest(list: Conversation[]) {
  return list
    .map((conversation, index) => ({ conversation, index }))
    .sort((a, b) => {
      const aTime = a.conversation.lastTimestamp ?? 0
      const bTime = b.conversation.lastTimestamp ?? 0
      if (aTime !== bTime) return bTime - aTime
      if ((a.conversation.unread ?? 0) !== (b.conversation.unread ?? 0)) return (b.conversation.unread ?? 0) - (a.conversation.unread ?? 0)
      return a.index - b.index
    })
    .map(({ conversation }) => conversation)
}

function contactId(contact: ZaloContact) {
  return String(contact.userId ?? contact.id ?? '')
}

function contactName(contact: ZaloContact) {
  return contact.displayName || contact.zaloName || contactId(contact)
}

function sortContacts(list: ZaloContact[]) {
  const seen = new Set<string>()
  return list
    .filter((contact) => {
      const id = contactId(contact)
      if (!id || seen.has(id)) return false
      seen.add(id)
      return true
    })
    .sort((a, b) => contactName(a).localeCompare(contactName(b), 'vi', { sensitivity: 'base' }))
}

function messageNotificationTitle(message: ChatMessage, conversation?: Conversation) {
  if (conversation?.name) return conversation.name
  return message.senderName || message.threadId
}

function messageNotificationBody(message: ChatMessage, conversation?: Conversation) {
  const body = message.text || (message.attachments.length ? `${message.attachments.length} file mới` : 'Tin nhắn mới')
  if (conversation?.type === 'group' && message.senderName) return `${message.senderName}: ${body}`
  return body
}

function formatEventTime(ts: number) {
  return new Date(ts).toLocaleTimeString('vi-VN')
}

function compactDetail(detail: unknown) {
  if (detail === undefined) return ''
  if (typeof detail === 'string') return detail
  try {
    const text = JSON.stringify(detail)
    return text.length > 110 ? `${text.slice(0, 107)}...` : text
  } catch {
    return String(detail)
  }
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function sameFile(a: File, b: File) {
  return a.name === b.name && a.size === b.size && a.lastModified === b.lastModified
}

function genderLabel(value?: number) {
  if (value === 1) return 'Nam'
  if (value === 2) return 'Nữ'
  return ''
}

const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #7c5cff 0%, #b45cff 100%)',
  'linear-gradient(135deg, #5cb3ff 0%, #5c7cff 100%)',
  'linear-gradient(135deg, #34d399 0%, #06b6d4 100%)',
  'linear-gradient(135deg, #fbbf24 0%, #f97316 100%)',
  'linear-gradient(135deg, #ec4899 0%, #f43f5e 100%)',
  'linear-gradient(135deg, #8b5cf6 0%, #d946ef 100%)',
  'linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%)',
  'linear-gradient(135deg, #10b981 0%, #84cc16 100%)',
]

function avatarGradient(seed: string) {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(i)
    hash |= 0
  }
  return AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length]
}

function NotificationIcon({ item }: { item: AppNotification }) {
  const [avatarFailed, setAvatarFailed] = useState(false)
  if (item.avatar && !avatarFailed) {
    return (
      <span className="notificationIcon hasAvatar" aria-hidden>
        <img src={item.avatar} alt="" onError={() => setAvatarFailed(true)} />
      </span>
    )
  }

  return (
    <span className="notificationIcon" aria-hidden>
      {item.kind === 'message' ? <MessageCircle size={14} /> : item.kind === 'group' ? <Users size={14} /> : item.kind === 'friend' ? <Bell size={14} /> : <Activity size={14} />}
    </span>
  )
}

type MessageRowProps = {
  message: ChatMessage
  selectedType?: ThreadKind
  userConversationById: Map<string, Conversation>
  onOpenConversation: (conversation: Conversation) => void
  onReply: (message: ChatMessage) => void
  onUndone: (messageId: string) => void
  onNotice: (message: string) => void
}

const MessageRow = memo(function MessageRow({
  message,
  selectedType,
  userConversationById,
  onOpenConversation,
  onReply,
  onUndone,
  onNotice,
}: MessageRowProps) {
  return (
    <article className={message.isSelf ? 'message self' : 'message'}>
      <span
        className={!message.isSelf && selectedType === 'group' ? 'sender clickable' : 'sender'}
        onClick={() => {
          if (!message.isSelf && selectedType === 'group' && message.senderId) {
            const existing = userConversationById.get(message.senderId)
            const target = existing ?? {
              id: message.senderId,
              type: 'user' as ThreadKind,
              name: message.senderName || message.senderId,
              unread: 0,
            }
            onOpenConversation(target as Conversation)
          }
        }}
      >
        {message.isSelf ? 'Bạn' : message.senderName || message.threadId}
      </span>
      {message.text && <p>{message.text}</p>}
      {message.attachments.map((attachment, index) => {
        const url = attachmentUrl(attachment.href, attachment.title)
        const preview = attachment.thumb ? attachmentUrl(attachment.thumb, attachment.title) : (isImageAttachment(attachment) ? url : undefined)
        const isImage = isImageAttachment(attachment)
        const externalUrl = attachment.href && attachment.href.startsWith('http') ? attachment.href : url
        if (isImage && preview) {
          return (
            <img key={`${attachment.href}-${index}`} className="msgImage" src={preview} alt={attachment.title || ''} onContextMenu={(event) => {
              event.preventDefault()
              const original = attachment.href || attachment.thumb
              if (original) navigator.clipboard.writeText(original).then(() => onNotice('Đã copy link ảnh')).catch(() => onNotice('Không copy được link'))
            }} onClick={(event) => {
              event.preventDefault()
              if (externalUrl) window.open(externalUrl, '_blank', 'noopener,noreferrer')
            }} />
          )
        }
        return externalUrl ? (
          <a key={`${attachment.href}-${index}`} href={externalUrl} target="_blank" rel="noreferrer" className="fileAttachment">
            <FileUp size={15} /> {attachment.title || 'Tệp đính kèm'} {attachment.size ? `(${attachment.size} bytes)` : ''}
          </a>
        ) : (
          <span className="fileAttachment" key={`${attachment.title}-${index}`}>
            <FileUp size={15} /> {attachment.title || 'Tệp đính kèm'} {attachment.size ? `(${attachment.size} bytes)` : ''}
          </span>
        )
      })}
      {message.reactions && Object.keys(message.reactions).length > 0 && (
        <span className="msgReactions">
          {Object.entries(message.reactions).map(([icon, users]) => (
            <span key={icon} className="reactionBubble" title={users.join(', ')}>
              {icon} <small>{users.length}</small>
            </span>
          ))}
        </span>
      )}
      <span className="messageMeta">
        <time>{new Date(message.timestamp).toLocaleString('vi-VN')}</time>
        {message.isSelf && deliveryLabel(message.deliveryStatus) && (
          <span className="receipt"><CheckCheck size={13} /> {deliveryLabel(message.deliveryStatus)}</span>
        )}
      </span>
      <MessageActions message={message} onReply={onReply} onUndone={onUndone} />
    </article>
  )
})

type ConversationRowProps = {
  conversation: Conversation
  active: boolean
  channel?: boolean
  typing: boolean
  onOpenConversation: (conversation: Conversation) => void
}

const ConversationRow = memo(function ConversationRow({
  conversation,
  active,
  channel = false,
  typing,
  onOpenConversation,
}: ConversationRowProps) {
  const className = channel
    ? active ? 'conversation channel active' : 'conversation channel'
    : active ? 'conversation active' : 'conversation'

  return (
    <button
      className={className}
      onClick={() => onOpenConversation(conversation)}
    >
      {channel ? (
        <span className="channelHash">{conversation.type === 'group' ? '#' : '@'}</span>
      ) : (
        <span className="avatar" style={!conversation.avatar ? { background: avatarGradient(conversation.id) } : undefined}>
          {conversation.avatar ? <img src={conversation.avatar} alt="" /> : conversation.type === 'group' ? <Users size={16} /> : conversation.name.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="conversationText">
        <strong>{conversation.name}</strong>
        <small>
          {conversation.pinned && <Pin size={11} />}
          {conversation.muted && <BellOff size={11} />}
          {typing ? <em>Đang gõ...</em> : (conversation.lastMessage || (channel ? ' ' : conversation.id))}
        </small>
      </span>
      {conversation.unread > 0 && <span className="badge">{conversation.unread}</span>}
    </button>
  )
})

function App() {
  const [configured, setConfigured] = useState(isConfigured())
  const [windowMaximized, setWindowMaximized] = useState(() => electron?.isWindowMaximized?.() ?? false)
  useEffect(() => {
    const unsub = electron?.onWindowMaximizeChange?.((isMaximized) => setWindowMaximized(isMaximized))
    return () => { unsub?.() }
  }, [])
  const [showSettings, setShowSettings] = useState(false)
  const [socket, setSocket] = useState<Socket | null>(null)
  const [status, setStatus] = useState<Status>({ state: 'offline', account: null, selfId: '', qrImage: '', error: '' })
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [contacts, setContacts] = useState<ZaloContact[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [visibleConversationLimit, setVisibleConversationLimit] = useState(CONVERSATION_RENDER_BATCH)
  const [visibleContactLimit, setVisibleContactLimit] = useState(CONTACT_RENDER_BATCH)
  const [visibleMessageLimit, setVisibleMessageLimit] = useState(MESSAGE_RENDER_BATCH)
  const [hasOlderMessages, setHasOlderMessages] = useState(false)
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false)
  const [selected, setSelected] = useState<Conversation | null>(null)
  const [filter, setFilter] = useState('')
  const [contactFilter, setContactFilter] = useState('')
  const [conversationFilter, setConversationFilter] = useState<ConversationFilter>('all')
  const [messageFilter, setMessageFilter] = useState('')
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [notice, setNotice] = useState('')
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [showNotifications, setShowNotifications] = useState(false)
  const [showContacts, setShowContacts] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [opening, setOpening] = useState(false)
  const [sending, setSending] = useState(false)
  const [socketConnected, setSocketConnected] = useState(false)
  const [typingThreads, setTypingThreads] = useState<Record<string, number>>({})
  const [dragActive, setDragActive] = useState(false)
  const [showAttachments, setShowAttachments] = useState(false)
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [showGlobalSearch, setShowGlobalSearch] = useState(false)
  const [showFindUser, setShowFindUser] = useState(false)
  const [showQuickReply, setShowQuickReply] = useState(false)
  const [showAllMembers, setShowAllMembers] = useState(false)
  const [showStickers, setShowStickers] = useState(false)
  const [showReminders, setShowReminders] = useState(false)
  const [showAutoReply, setShowAutoReply] = useState(false)
  const [showBankCard, setShowBankCard] = useState(false)
  const [recordingVoice, setRecordingVoice] = useState(false)
  // @mention picker state for group composer
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)  // null = closed; "" or "alice" when active
  // Collected mentions {pos, uid, len} for the current draft, sent with the message
  const [pendingMentions, setPendingMentions] = useState<Array<{ pos: number; uid: string; len: number }>>([])
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false)
  const [contactsLoading, setContactsLoading] = useState(false)
  const [groupDetail, setGroupDetail] = useState<GroupDetail | null>(null)
  const [groupDetailLoading, setGroupDetailLoading] = useState(false)
  const [userDetail, setUserDetail] = useState<UserDetail | null>(null)
  const [userDetailLoading, setUserDetailLoading] = useState(false)
  const lastTypingRef = useRef(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const selectedRef = useRef<Conversation | null>(null)
  const conversationsRef = useRef<Conversation[]>([])
  const messagesRef = useRef<ChatMessage[]>([])
  const openConversationRef = useRef<(conversation: Conversation, refresh?: boolean) => void>(() => undefined)
  const mainWindowVisibleRef = useRef(!document.hidden && document.hasFocus())
  // Bookkeeping for reconnect recovery and notification dedupe.
  const conversationTimestampsRef = useRef<Map<string, number>>(new Map())
  const conversationSnapshotReadyRef = useRef(false)
  const handledNotificationIdsRef = useRef<Set<string>>(new Set())
  const messageSyncInFlightRef = useRef<Set<string>>(new Set())
  const lastSocketActivityRef = useRef(0)
  // Threads whose history we've already force-refreshed this session, so we
  // only hit Zalo for fresh history on the first open of each thread.
  const refreshedThreadsRef = useRef<Set<string>>(new Set())

  // Category state
  const [categories, setCategories] = useState<Category[]>(loadCategories)
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [showCategoryManager, setShowCategoryManager] = useState(false)
  const [newCategoryName, setNewCategoryName] = useState('')
  const [newCategoryColor, setNewCategoryColor] = useState(CATEGORY_COLORS[0])
  const [showThreadInfo, setShowThreadInfo] = useState(false)
  const [showChannelPicker, setShowChannelPicker] = useState(false)
  const [pickerSelected, setPickerSelected] = useState<Set<string>>(new Set())
  const [pickerSearch, setPickerSearch] = useState('')
  const deferredFilter = useDeferredValue(filter)
  const deferredContactFilter = useDeferredValue(contactFilter)
  const deferredMessageFilter = useDeferredValue(messageFilter)
  const deferredPickerSearch = useDeferredValue(pickerSearch)

  const selectedCategoryData = useMemo(() => {
    return selectedCategory ? categories.find((category) => category.id === selectedCategory) ?? null : null
  }, [categories, selectedCategory])

  const selectedCategoryThreadIds = useMemo(() => {
    return new Set(selectedCategoryData?.threadIds ?? [])
  }, [selectedCategoryData])

  const filteredConversations = useMemo(() => {
    const query = deferredFilter.trim().toLowerCase()
    const matched = conversations.filter((item) => {
      const matchesType = conversationFilter === 'all' || item.type === conversationFilter
      const matchesQuery = !query || item.name.toLowerCase().includes(query) || item.id.includes(query)
      const matchesCategory = !selectedCategory || selectedCategoryThreadIds.has(item.id)
      return matchesType && matchesQuery && matchesCategory
    })
    return selectedCategory ? groupConversationsFirst(matched) : sortConversationsByLatest(matched)
  }, [conversationFilter, conversations, deferredFilter, selectedCategory, selectedCategoryThreadIds])

  const hiddenConversationCount = Math.max(0, filteredConversations.length - visibleConversationLimit)
  const visibleConversations = useMemo(() => {
    if (hiddenConversationCount === 0) return filteredConversations
    return filteredConversations.slice(0, visibleConversationLimit)
  }, [filteredConversations, hiddenConversationCount, visibleConversationLimit])

  const categoryUnreadById = useMemo(() => {
    const unreadByThread = new Map(conversations.map((conversation) => [conversation.id, conversation.unread ?? 0]))
    const unreadByCategory = new Map<string, number>()
    for (const category of categories) {
      let unread = 0
      for (const threadId of category.threadIds) unread += unreadByThread.get(threadId) ?? 0
      unreadByCategory.set(category.id, unread)
    }
    return unreadByCategory
  }, [categories, conversations])

  const workspaceConversations = useMemo(() => {
    if (!selectedCategory) return { groups: [] as Conversation[], users: [] as Conversation[] }
    const groups: Conversation[] = []
    const users: Conversation[] = []
    for (const conversation of visibleConversations) {
      if (conversation.type === 'group') groups.push(conversation)
      else users.push(conversation)
    }
    return { groups, users }
  }, [visibleConversations, selectedCategory])

  const contactSearchRows = useMemo(() => {
    return contacts.map((contact) => {
      const id = contactId(contact)
      const name = contactName(contact)
      const phone = String(contact.phoneNumber ?? '')
      return {
        contact,
        id,
        name,
        searchText: `${name} ${id} ${phone}`.toLowerCase(),
      }
    })
  }, [contacts])

  const filteredContacts = useMemo(() => {
    const query = deferredContactFilter.trim().toLowerCase()
    if (!query) return contacts
    return contactSearchRows
      .filter((row) => row.searchText.includes(query))
      .map((row) => row.contact)
  }, [contactSearchRows, contacts, deferredContactFilter])

  const hiddenContactCount = Math.max(0, filteredContacts.length - visibleContactLimit)
  const visibleContacts = useMemo(() => {
    if (hiddenContactCount === 0) return filteredContacts
    return filteredContacts.slice(0, visibleContactLimit)
  }, [filteredContacts, hiddenContactCount, visibleContactLimit])

  const userConversationById = useMemo(() => {
    const map = new Map<string, Conversation>()
    for (const conversation of conversations) {
      if (conversation.type === 'user') map.set(conversation.id, conversation)
    }
    return map
  }, [conversations])

  const conversationStats = useMemo(() => {
    return conversations.reduce((stats, item) => {
      if (item.type === 'user') stats.userCount += 1
      else stats.groupCount += 1
      stats.unreadCount += item.unread
      return stats
    }, { userCount: 0, groupCount: 0, unreadCount: 0 })
  }, [conversations])
  const { userCount, groupCount, unreadCount } = conversationStats

  const unreadNotificationCount = useMemo(() => notifications.reduce((count, item) => count + (item.read ? 0 : 1), 0), [notifications])
  const filteredMessages = useMemo(() => {
    const query = deferredMessageFilter.trim().toLowerCase()
    if (!query) return messages
    return messages.filter((message) => {
      const attachmentText = message.attachments
        .map((attachment) => `${attachment.title ?? ''} ${attachment.href ?? ''} ${attachment.type ?? ''}`)
        .join(' ')
      return `${message.senderName ?? ''} ${message.text} ${attachmentText}`.toLowerCase().includes(query)
    })
  }, [deferredMessageFilter, messages])

  const hiddenMessageCount = Math.max(0, filteredMessages.length - visibleMessageLimit)
  const visibleMessages = useMemo(() => {
    if (hiddenMessageCount === 0) return filteredMessages
    return filteredMessages.slice(hiddenMessageCount)
  }, [filteredMessages, hiddenMessageCount])
  const lastRenderedMessageId = visibleMessages[visibleMessages.length - 1]?.id ?? ''

  const attachmentCount = useMemo(() => messages.reduce((total, message) => total + message.attachments.length, 0), [messages])

  const attachmentItems = useMemo(() => {
    if (!showAttachments) return []
    return messages
      .flatMap((message) => message.attachments.map((attachment, index) => {
        const url = attachmentUrl(attachment.href, attachment.title)
        const preview = attachment.thumb ? attachmentUrl(attachment.thumb, attachment.title) : (isImageAttachment(attachment) ? url : undefined)
        return { message, attachment, index, url, preview, isImage: isImageAttachment(attachment) }
      }))
      .reverse()
  }, [messages, showAttachments])

  const loadConversationMessages = useCallback((conversation: Pick<Conversation, 'id' | 'type'>, options: { refresh?: boolean; markRead?: boolean; limit?: number; beforeTs?: number; page?: boolean } = {}) => {
    const params = new URLSearchParams()
    if (options.refresh) params.set('refresh', '1')
    if (options.markRead === false) params.set('markRead', '0')
    if (options.page !== false) params.set('page', '1')
    if (options.limit) params.set('limit', String(options.limit))
    if (options.beforeTs) params.set('before', String(options.beforeTs))
    const query = params.toString()
    return apiJson<MessagePage | ChatMessage[]>(`/api/messages/${conversation.type}/${conversation.id}${query ? `?${query}` : ''}`)
      .then((payload) => {
        if (Array.isArray(payload)) return { messages: payload, hasMore: false, total: payload.length }
        return {
          messages: Array.isArray(payload.messages) ? payload.messages : [],
          hasMore: Boolean(payload.hasMore),
          total: Number(payload.total ?? payload.messages?.length ?? 0),
        }
      })
  }, [])

  const markThreadSeen = useCallback((threadId: string, type: ThreadKind) => {
    return apiJson('/api/events/seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId, type }),
    }).catch(() => undefined)
  }, [])

  const pushNotification = useCallback((item: Omit<AppNotification, 'id' | 'ts' | 'read'>) => {
    setNotifications((current) => [
      { ...item, id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, ts: Date.now(), read: false },
      ...current,
    ].slice(0, 60))
  }, [])

  const setStatusIfChanged = useCallback((nextStatus: Status) => {
    setStatus((current) => sameStatus(current, nextStatus) ? current : nextStatus)
  }, [])

  const markNotificationHandled = useCallback((messageId: string) => {
    if (!messageId) return
    handledNotificationIdsRef.current.add(messageId)
    trimSet(handledNotificationIdsRef.current, 600, 500)
  }, [])

  const notifyIncomingMessage = useCallback((message: ChatMessage, conversation?: Conversation) => {
    if (message.isSelf || handledNotificationIdsRef.current.has(message.id)) return
    markNotificationHandled(message.id)

    const currentSelected = selectedRef.current
    const activeSelectedThread = currentSelected?.id === message.threadId && mainWindowVisibleRef.current && !document.hidden
    if (activeSelectedThread) return

    const conv = conversation ?? conversationsRef.current.find((c) => c.id === message.threadId)
    const isMuted = conv?.muted
    const title = messageNotificationTitle(message, conv)
    const body = messageNotificationBody(message, conv)
    const avatar = conv?.avatar
    pushNotification({ kind: 'message', title, body, threadId: message.threadId, type: message.type, avatar })
    if (!isMuted) {
      setNotice(`${title}: ${body}`)
      if (electron) {
        electron.sendNotification({ title, body, threadId: message.threadId, type: message.type, avatar })
        electron.flashFrame()
      } else if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body, icon: avatar })
      }
    }
  }, [markNotificationHandled, pushNotification])

  const syncConversationMessages = useCallback(async (
    conversation: Conversation,
    options: { sinceTs?: number; updateSelected?: boolean; markRead?: boolean; notify?: boolean; refresh?: boolean } = {},
  ) => {
    const key = `${conversation.type}:${conversation.id}`
    if (messageSyncInFlightRef.current.has(key)) return
    messageSyncInFlightRef.current.add(key)
    try {
      const data = await loadConversationMessages(conversation, {
        refresh: options.refresh,
        markRead: options.markRead ?? false,
        limit: MESSAGE_PAGE_LIMIT,
      })
      const list = data.messages
      const stillSelected = selectedRef.current?.id === conversation.id

      if (options.updateSelected && stillSelected) {
        setMessages((current) => mergeMessages(current, list))
        setHasOlderMessages((current) => current || data.hasMore)
      }
      if (options.markRead && stillSelected) {
        setConversations((current) => markConversationRead(current, conversation.id))
        void markThreadSeen(conversation.id, conversation.type)
      }

      const candidates = list
        .filter((message) => !message.isSelf)
        .filter((message) => !options.sinceTs || message.timestamp > options.sinceTs)
        .filter((message) => !handledNotificationIdsRef.current.has(message.id))
        .sort((a, b) => a.timestamp - b.timestamp)

      if (candidates.length === 0) return
      const latest = candidates[candidates.length - 1]
      for (const message of candidates.slice(0, -1)) markNotificationHandled(message.id)
      if (options.notify) notifyIncomingMessage(latest, conversation)
      else markNotificationHandled(latest.id)
    } catch (error) {
      reportClientEvent('message-sync-error', {
        threadId: conversation.id,
        type: conversation.type,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      messageSyncInFlightRef.current.delete(key)
    }
  }, [loadConversationMessages, markNotificationHandled, markThreadSeen, notifyIncomingMessage])

  // Socket.IO replays conversation snapshots after reconnect, not every missed
  // message event. Use timestamp changes to fetch just the threads that moved.
  const reconcileConversations = useCallback((items: Conversation[], previousTimestamps: Map<string, number>) => {
    const currentSelected = selectedRef.current
    const selectedActive = Boolean(currentSelected && mainWindowVisibleRef.current && !document.hidden)
    for (const conversation of items) {
      const lastTimestamp = conversation.lastTimestamp ?? 0
      if (!lastTimestamp) continue

      const previousTimestamp = previousTimestamps.get(conversation.id) ?? 0
      const changedSinceSnapshot = lastTimestamp > previousTimestamp
      const isSelected = currentSelected?.id === conversation.id
      const selectedIsStale = isSelected && lastTimestamp > latestMessageTimestamp(messagesRef.current)
      if (!changedSinceSnapshot && !selectedIsStale) continue

      const shouldMarkRead = Boolean(isSelected && selectedActive)
      const shouldNotify = Boolean(changedSinceSnapshot && !shouldMarkRead && conversation.unread > 0 && !conversation.manualUnread)
      const shouldRefresh = conversation.type === 'group' && (changedSinceSnapshot || selectedIsStale)
      void syncConversationMessages(conversation, {
        sinceTs: previousTimestamp || undefined,
        updateSelected: isSelected,
        markRead: shouldMarkRead,
        notify: shouldNotify,
        refresh: shouldRefresh,
      })
    }
  }, [syncConversationMessages])

  const applyConversationSnapshot = useCallback((items: Conversation[]) => {
    const previousTimestamps = new Map(conversationTimestampsRef.current)
    const wasReady = conversationSnapshotReadyRef.current
    const currentSelected = selectedRef.current
    const selectedThreadVisible = Boolean(currentSelected && mainWindowVisibleRef.current && !document.hidden)
    const nextConversations = selectedThreadVisible && currentSelected ? markConversationRead(items, currentSelected.id) : items
    setConversations((current) => sameConversationList(current, nextConversations) ? current : nextConversations)
    if (wasReady) reconcileConversations(items, previousTimestamps)

    if (currentSelected) {
      const updated = items.find((item) => item.id === currentSelected.id)
      if (updated && (updated.name !== currentSelected.name || updated.avatar !== currentSelected.avatar || selectedThreadVisible)) {
        const nextSelected = selectedThreadVisible ? { ...updated, unread: 0, manualUnread: false } : updated
        setSelected((current) => current && sameConversation(current, nextSelected) ? current : nextSelected)
      }
    }
  }, [reconcileConversations])

  useEffect(() => {
    selectedRef.current = selected
  }, [selected])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    lastSocketActivityRef.current = Date.now()
  }, [])

  useEffect(() => {
    conversationsRef.current = conversations
    conversationTimestampsRef.current = new Map(conversations.map((conversation) => [conversation.id, conversation.lastTimestamp ?? 0]))
    if (conversations.length > 0) conversationSnapshotReadyRef.current = true
  }, [conversations])

  useEffect(() => {
    const selectedThreadIsVisible = () => mainWindowVisibleRef.current && !document.hidden
    const markCurrentSelectedRead = () => {
      if (!selectedThreadIsVisible()) return
      const current = selectedRef.current
      if (!current) return
      setConversations((list) => markConversationRead(list, current.id))
      void markThreadSeen(current.id, current.type)
    }
    const handleDocumentVisibility = () => {
      if (!electron) mainWindowVisibleRef.current = !document.hidden && document.hasFocus()
      markCurrentSelectedRead()
    }
    const handleWindowFocus = () => {
      if (!electron) mainWindowVisibleRef.current = !document.hidden
      markCurrentSelectedRead()
    }
    const handleWindowBlur = () => {
      if (!electron) mainWindowVisibleRef.current = false
    }
    const cleanupVisibility = electron?.onMainWindowVisibility?.((state) => {
      mainWindowVisibleRef.current = Boolean(state.visible && state.focused)
      markCurrentSelectedRead()
    })

    document.addEventListener('visibilitychange', handleDocumentVisibility)
    window.addEventListener('focus', handleWindowFocus)
    window.addEventListener('blur', handleWindowBlur)
    return () => {
      cleanupVisibility?.()
      document.removeEventListener('visibilitychange', handleDocumentVisibility)
      window.removeEventListener('focus', handleWindowFocus)
      window.removeEventListener('blur', handleWindowBlur)
    }
  }, [markThreadSeen])

  useEffect(() => {
    // Subscribe to the live socket. The socket module rebuilds it whenever
    // the user changes settings, so the App re-runs all socket-bound effects.
    return subscribeSocket((next) => {
      setSocket(next)
      setSocketConnected(Boolean(next?.connected))
      setConfigured(isConfigured())
    })
  }, [])

  useEffect(() => {
    if (!configured || !socket) return

    const handleConnect = () => {
      lastSocketActivityRef.current = Date.now()
      setSocketConnected(true)
      reportClientEvent('socket-connect', { socketId: socket.id })
      void apiJson<Status>('/api/status').then(setStatusIfChanged).catch(() => undefined)
      void apiJson<Conversation[]>('/api/conversations').then(applyConversationSnapshot).catch(() => undefined)
    }
    const handleDisconnect = (reason: string) => {
      setSocketConnected(false)
      reportClientEvent('socket-disconnect', { reason })
    }
    const handleConnectError = (error: Error) => {
      setSocketConnected(false)
      reportClientEvent('socket-connect-error', { message: error.message })
    }
    const handleStatus = (nextStatus: Status) => {
      lastSocketActivityRef.current = Date.now()
      setStatusIfChanged(nextStatus)
    }
    const handleConversations = (items: Conversation[]) => {
      lastSocketActivityRef.current = Date.now()
      applyConversationSnapshot(items)
    }
    const handleMessage = (message: ChatMessage) => {
      lastSocketActivityRef.current = Date.now()
      const knownTimestamp = conversationTimestampsRef.current.get(message.threadId) ?? 0
      if ((message.timestamp ?? 0) > knownTimestamp) {
        conversationTimestampsRef.current.set(message.threadId, message.timestamp)
      }
      const currentSelected = selectedRef.current
      const isSelectedThread = currentSelected?.id === message.threadId
      const isOpenThread = Boolean(isSelectedThread && mainWindowVisibleRef.current && !document.hidden)
      setMessages((current) => {
        if (!isSelectedThread) return current
        return appendMessage(current, message)
      })
      if (isOpenThread) {
        setConversations((current) => markConversationRead(current, message.threadId))
        if (!message.isSelf) {
          markNotificationHandled(message.id)
          void markThreadSeen(message.threadId, message.type)
        }
      }
      if (!message.isSelf && !isOpenThread) {
        notifyIncomingMessage(message)
      }
    }
    const handleMessageStatus = (event: MessageStatusEvent) => {
      lastSocketActivityRef.current = Date.now()
      setMessages((current) => updateMessageStatus(current, event))
    }
    const handleGroupEvent = (event: { threadId?: string; type?: unknown }) => {
      lastSocketActivityRef.current = Date.now()
      const conv = event.threadId ? conversationsRef.current.find((c) => c.id === event.threadId) : undefined
      pushNotification({ kind: 'group', title: 'Cập nhật nhóm', body: 'Có thay đổi trong nhóm', threadId: event.threadId, type: event.threadId ? 'group' : undefined, avatar: conv?.avatar })
      setNotice('Có cập nhật trong nhóm')
    }
    const handleFriendEvent = () => {
      lastSocketActivityRef.current = Date.now()
      pushNotification({ kind: 'friend', title: 'Cập nhật bạn bè', body: 'Có thay đổi từ bạn bè' })
      setNotice('Có cập nhật bạn bè')
    }
    const handleTyping = (typing: TypingEvent) => {
      lastSocketActivityRef.current = Date.now()
      if (typing.isSelf) return
      const expiresAt = Date.now() + 3500
      setTypingThreads((current) => {
        if ((current[typing.threadId] ?? 0) >= expiresAt - 250) return current
        return { ...current, [typing.threadId]: expiresAt }
      })
    }
    const handleUndo = (data: { threadId?: string; msgId?: string; cliMsgId?: string }) => {
      lastSocketActivityRef.current = Date.now()
      const targetId = String(data.msgId ?? data.cliMsgId ?? '')
      if (targetId) setMessages((prev) => prev.filter((m) => m.id !== targetId))
    }
    const handleReaction = (data: { threadId?: string; msgId?: string; icon?: string; userId?: string }) => {
      lastSocketActivityRef.current = Date.now()
      if (!data.threadId || !data.msgId || !data.icon) return
      setMessages((prev) => prev.map((msg) => {
        if (msg.id !== data.msgId) return msg
        const reactions = { ...(msg.reactions || {}) }
        const users = [...(reactions[data.icon!] || [])]
        if (!users.includes(data.userId || '')) users.push(data.userId || '')
        reactions[data.icon!] = users
        return { ...msg, reactions }
      }))
    }
    const handleBrowserError = (event: ErrorEvent) => {
      reportClientEvent('browser-error', { message: event.message, source: event.filename, line: event.lineno, column: event.colno })
    }
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      reportClientEvent('browser-unhandled-rejection', { reason: event.reason instanceof Error ? event.reason.message : String(event.reason) })
    }

    reportClientEvent('app-open', {
      href: window.location.href,
      apiUrl: getSettings().baseUrl,
      notificationPermission: 'Notification' in window ? Notification.permission : 'unsupported',
      userAgent: navigator.userAgent,
      isElectron: Boolean(electron),
    })
    const cleanupOpenThread = electron?.onOpenThread(({ threadId, type }) => {
      const safeType: ThreadKind = type === 'group' ? 'group' : 'user'
      const target = conversationsRef.current.find((conversation) => conversation.id === threadId) ?? {
        id: threadId,
        type: safeType,
        name: threadId,
        unread: 0,
        manualUnread: false,
      }
      setSelected({ ...target, unread: 0, manualUnread: false })
      setConversations((current) => markConversationRead(current, threadId))
      setMessages([])
      setGroupDetail(null)
      setUserDetail(null)
      setShowAttachments(false)
      setVisibleMessageLimit(MESSAGE_RENDER_BATCH)
      setHasOlderMessages(false)
      setLoadingOlderMessages(false)
      setMessageFilter('')
      setOpening(true)
      reportClientEvent('notification-open-thread', { threadId, type: safeType })
      loadConversationMessages({ id: threadId, type: safeType }, { markRead: true, limit: MESSAGE_PAGE_LIMIT })
        .then((data) => {
          setMessages(data.messages)
          setHasOlderMessages(data.hasMore)
        })
        .catch(() => {
          setMessages([])
          setHasOlderMessages(false)
        })
        .finally(() => setOpening(false))
      void markThreadSeen(threadId, safeType)
    })
    socket.on('connect', handleConnect)
    socket.on('disconnect', handleDisconnect)
    socket.on('connect_error', handleConnectError)
    socket.on('status', handleStatus)
    socket.on('conversations', handleConversations)
    socket.on('message', handleMessage)
    socket.on('message_status', handleMessageStatus)
    socket.on('group_event', handleGroupEvent)
    socket.on('friend_event', handleFriendEvent)
    socket.on('typing', handleTyping)
    socket.on('undo', handleUndo)
    socket.on('reaction', handleReaction)
    window.addEventListener('error', handleBrowserError)
    window.addEventListener('unhandledrejection', handleUnhandledRejection)
    if (socket.connected) {
      handleConnect()
    } else {
      apiJson<Status>('/api/status').then(setStatusIfChanged).catch((error: Error) => setNotice(error.message))
      apiJson<Conversation[]>('/api/conversations').then(applyConversationSnapshot).catch(() => undefined)
    }
    return () => {
      socket.off('status', handleStatus)
      socket.off('connect', handleConnect)
      socket.off('disconnect', handleDisconnect)
      socket.off('connect_error', handleConnectError)
      socket.off('conversations', handleConversations)
      socket.off('message', handleMessage)
      socket.off('message_status', handleMessageStatus)
      socket.off('group_event', handleGroupEvent)
      socket.off('friend_event', handleFriendEvent)
      socket.off('typing', handleTyping)
      socket.off('undo', handleUndo)
      socket.off('reaction', handleReaction)
      cleanupOpenThread?.()
      window.removeEventListener('error', handleBrowserError)
      window.removeEventListener('unhandledrejection', handleUnhandledRejection)
    }
  }, [applyConversationSnapshot, configured, loadConversationMessages, markNotificationHandled, markThreadSeen, notifyIncomingMessage, pushNotification, setStatusIfChanged, socket])

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now()
      setTypingThreads((current) => {
        let changed = false
        const next: Record<string, number> = {}
        for (const [threadId, expires] of Object.entries(current)) {
          if (expires > now) {
            next[threadId] = expires
          } else {
            changed = true
          }
        }
        return changed ? next : current
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
  }, [lastRenderedMessageId, selected?.id])

  useEffect(() => {
    document.title = unreadCount > 0 ? `(${unreadCount}) Szalo` : 'Szalo'
    if (electron) electron.setUnreadCount(unreadCount)
  }, [unreadCount])

  useEffect(() => {
    if (!configured) return
    let stopped = false

    const heartbeat = async () => {
      if (stopped || !isConfigured()) return
      const idleMs = Date.now() - lastSocketActivityRef.current
      if (socket && (!socket.connected || idleMs > SOCKET_STALE_MS)) {
        reportClientEvent('socket-heartbeat-reconnect', { connected: socket.connected, idleMs })
        forceReconnectSocket()
      }

      try {
        const [nextStatus, nextConversations] = await Promise.all([
          apiJson<Status>('/api/status'),
          apiJson<Conversation[]>('/api/conversations'),
        ])
        if (stopped) return
        setStatusIfChanged(nextStatus)
        applyConversationSnapshot(nextConversations)
        lastSocketActivityRef.current = Date.now()
      } catch (error) {
        reportClientEvent('socket-heartbeat-error', { error: error instanceof Error ? error.message : String(error) })
      }
    }

    const timer = window.setInterval(() => {
      void heartbeat()
    }, SOCKET_HEARTBEAT_INTERVAL_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [applyConversationSnapshot, configured, setStatusIfChanged, socket])

  useEffect(() => {
    if (!configured || status.state !== 'online') return
    apiJson<Conversation[]>('/api/conversations')
      .then(applyConversationSnapshot)
      .catch((error: Error) => setNotice(error.message))
  }, [applyConversationSnapshot, configured, status.state])

  // Load server-side categories for the logged-in Zalo account. This is what
  // makes channels follow the account across machines — on login we pull the
  // saved grouping and replace the local cache with it.
  useEffect(() => {
    if (!configured || status.state !== 'online') return
    apiJson<{ selfId: string; categories: Category[] }>('/api/categories')
      .then((data) => {
        if (Array.isArray(data.categories)) {
          setCategories(data.categories)
          cacheCategories(data.categories)
        }
      })
      .catch(() => undefined)
  }, [configured, status.state, status.selfId])

  // Live category updates from other clients on the same account.
  useEffect(() => {
    if (!configured || !socket) return
    const handleCategories = (data: { selfId: string; categories: Category[] }) => {
      if (Array.isArray(data.categories)) {
        setCategories(data.categories)
        cacheCategories(data.categories)
      }
    }
    socket.on('categories', handleCategories)
    return () => { socket.off('categories', handleCategories) }
  }, [configured, socket])

  async function startLogin() {
    try {
      await apiJson('/api/login/qr', { method: 'POST' })
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  async function logout() {
    try {
      await apiJson('/api/logout', { method: 'POST' })
      setSelected(null)
      setMessages([])
      setConversations([])
      setContacts([])
      updateContactSearch('')
      setShowContacts(false)
      setHealth(null)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  async function loadDiagnostics() {
    setDiagnosticsLoading(true)
    try {
      const data = await apiJson<Health>('/api/health')
      setHealth(data)
      reportClientEvent('diagnostics-open', { sends: data.recentSends.length, clientEvents: data.recentClientEvents.length, listenerEvents: data.recentListenerEvents.length })
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setDiagnosticsLoading(false)
    }
  }

  const loadGroupDetail = useCallback(async (threadId: string) => {
    setGroupDetailLoading(true)
    try {
      const detail = await apiJson<GroupDetail>(`/api/groups/${threadId}`)
      setGroupDetail(detail)
      setConversations((current) => {
        const existing = current.find((item) => item.id === detail.id)
        if (!existing) return current
        return replaceConversation(current, { ...existing, name: detail.name || existing.name, avatar: detail.avatar || existing.avatar })
      })
      setSelected((current) => current?.id === detail.id ? { ...current, name: detail.name || current.name, avatar: detail.avatar || current.avatar } : current)
      reportClientEvent('group-detail', { threadId, members: detail.members.length, truncated: detail.truncated, warning: detail.warning || '' })
    } catch (error) {
      setGroupDetail(null)
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setGroupDetailLoading(false)
    }
  }, [])

  const loadUserDetail = useCallback(async (threadId: string) => {
    setUserDetailLoading(true)
    try {
      const detail = await apiJson<UserDetail>(`/api/users/${threadId}`)
      setUserDetail(detail)
      const displayName = detail.displayName || detail.zaloName || detail.id
      setConversations((current) => {
        const existing = current.find((item) => item.id === detail.id)
        if (!existing) return current
        return replaceConversation(current, { ...existing, name: displayName, avatar: detail.avatar || existing.avatar })
      })
      setSelected((current) => current?.id === detail.id ? { ...current, name: displayName, avatar: detail.avatar || current.avatar } : current)
      reportClientEvent('user-detail', { threadId, hasPhone: Boolean(detail.phoneNumber), isFriend: detail.isFriend, isBlocked: detail.isBlocked })
    } catch (error) {
      setUserDetail(null)
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setUserDetailLoading(false)
    }
  }, [])

  async function loadContacts(showDoneNotice = true) {
    setContactsLoading(true)
    try {
      const data = await apiJson<ZaloContact[]>('/api/friends?pages=all')
      const normalized = sortContacts(Array.isArray(data) ? data : [])
      setContacts(normalized)
      const list = await apiJson<Conversation[]>('/api/conversations')
      applyConversationSnapshot(list)
      if (showDoneNotice) setNotice(`Đã tải ${normalized.length} liên hệ`)
      return normalized
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
      return []
    } finally {
      setContactsLoading(false)
    }
  }

  async function syncContacts() {
    setSyncing(true)
    setContactsLoading(true)
    try {
      const results = await Promise.allSettled([
        apiJson<ZaloContact[]>('/api/friends?pages=all'),
        apiJson('/api/groups'),
      ])
      const friendsResult = results[0]
      if (friendsResult.status === 'fulfilled') {
        setContacts(sortContacts(Array.isArray(friendsResult.value) ? friendsResult.value : []))
      }
      const list = await apiJson<Conversation[]>('/api/conversations')
      applyConversationSnapshot(list)
      const failed = results.filter((result) => result.status === 'rejected')
      setNotice(failed.length ? `Đồng bộ một phần: ${list.length} hội thoại` : `Đã đồng bộ ${list.length} hội thoại`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setSyncing(false)
      setContactsLoading(false)
    }
  }

  function openContactConversation(contact: ZaloContact) {
    const id = contactId(contact)
    if (!id) return
    const existing = userConversationById.get(id)
    const target = existing ?? { id, type: 'user' as ThreadKind, name: contactName(contact), avatar: contact.avatar, unread: 0 }
    openConversation(target as Conversation)
  }

  const updateMessageFilter = useCallback((value: string) => {
    setVisibleMessageLimit(MESSAGE_RENDER_BATCH)
    setMessageFilter(value)
  }, [])

  const openConversation = useCallback(async (conversation: Conversation, refresh = false) => {
    setSelected({ ...conversation, unread: 0, manualUnread: false })
    setConversations((current) => markConversationRead(current, conversation.id))
    if (conversation.type === 'group') {
      void loadGroupDetail(conversation.id)
      setUserDetail(null)
    } else {
      void loadUserDetail(conversation.id)
      setGroupDetail(null)
    }
    setShowAttachments(false)
    updateMessageFilter('')
    setHasOlderMessages(false)
    setLoadingOlderMessages(false)
    setReplyTo(null)
    setPendingMentions([])
    setMentionQuery(null)
    setShowQuickReply(false)
    setOpening(true)
    // Force a server-side refresh the first time a thread is opened this session
    // so we pull the latest history from Zalo, not just whatever's cached.
    const firstOpen = !refreshedThreadsRef.current.has(conversation.id)
    const shouldRefresh = refresh || firstOpen
    refreshedThreadsRef.current.add(conversation.id)
    reportClientEvent('conversation-open', { threadId: conversation.id, type: conversation.type, refresh: shouldRefresh, firstOpen })
    try {
      const data = await loadConversationMessages(conversation, { refresh: shouldRefresh, markRead: true, limit: MESSAGE_PAGE_LIMIT })
      setMessages(data.messages)
      setHasOlderMessages(data.hasMore)
      await markThreadSeen(conversation.id, conversation.type)
    } catch (error) {
      setMessages([])
      setHasOlderMessages(false)
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setOpening(false)
    }
  }, [loadConversationMessages, loadGroupDetail, loadUserDetail, markThreadSeen, updateMessageFilter])
  useEffect(() => {
    openConversationRef.current = openConversation
  }, [openConversation])

  const openConversationFromMessage = useCallback((conversation: Conversation) => {
    openConversationRef.current(conversation)
  }, [])

  const handleMessageUndone = useCallback((id: string) => {
    setMessages((prev) => prev.filter((message) => message.id !== id))
  }, [])

  const loadOlderMessages = useCallback(async () => {
    if (hiddenMessageCount > 0) {
      setVisibleMessageLimit((current) => current + MESSAGE_RENDER_STEP)
      return
    }
    if (!selected || !hasOlderMessages || loadingOlderMessages || messageFilter) return
    const beforeTs = messages[0]?.timestamp
    if (!beforeTs) return

    setLoadingOlderMessages(true)
    try {
      const data = await loadConversationMessages(selected, {
        markRead: false,
        limit: MESSAGE_PAGE_LIMIT,
        beforeTs,
      })
      setMessages((current) => mergeMessages(current, data.messages))
      setHasOlderMessages(data.hasMore)
      setVisibleMessageLimit((current) => current + Math.max(data.messages.length, MESSAGE_RENDER_STEP))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingOlderMessages(false)
    }
  }, [hasOlderMessages, hiddenMessageCount, loadConversationMessages, loadingOlderMessages, messageFilter, messages, selected])

  const updateConversationSearch = useCallback((value: string) => {
    setVisibleConversationLimit(CONVERSATION_RENDER_BATCH)
    setFilter(value)
  }, [])

  const updateContactSearch = useCallback((value: string) => {
    setVisibleContactLimit(CONTACT_RENDER_BATCH)
    setContactFilter(value)
  }, [])

  const selectConversationFilter = useCallback((next: ConversationFilter) => {
    setVisibleConversationLimit(CONVERSATION_RENDER_BATCH)
    setConversationFilter(next)
  }, [])

  const selectCategory = useCallback((categoryId: string | null) => {
    setVisibleConversationLimit(CONVERSATION_RENDER_BATCH)
    setSelectedCategory(categoryId)
  }, [])

  const conversationListContent = useMemo(() => {
    const selectedId = selected?.id
    if (filteredConversations.length === 0) {
      return (
        <div className="emptyState">
          <MessageCircle size={28} />
          <p>Không có hội thoại</p>
          <small>{filter ? 'Thử từ khóa khác' : selectedCategory ? 'Chưa có chat nào trong phân loại này' : 'Đồng bộ để tải danh sách'}</small>
        </div>
      )
    }

    if (selectedCategory) {
      return (
        <>
          {workspaceConversations.groups.length > 0 && (
            <div className="channelSection">
              <div className="channelSectionHeader">
                <span>Nhóm</span>
                <small>{workspaceConversations.groups.length}</small>
              </div>
              {workspaceConversations.groups.map((conversation) => (
                <ConversationRow
                  key={`${conversation.type}-${conversation.id}`}
                  conversation={conversation}
                  active={selectedId === conversation.id}
                  channel
                  typing={Boolean(typingThreads[conversation.id])}
                  onOpenConversation={openConversationFromMessage}
                />
              ))}
            </div>
          )}
          {workspaceConversations.users.length > 0 && (
            <div className="channelSection">
              <div className="channelSectionHeader">
                <span>Cá nhân</span>
                <small>{workspaceConversations.users.length}</small>
              </div>
              {workspaceConversations.users.map((conversation) => (
                <ConversationRow
                  key={`${conversation.type}-${conversation.id}`}
                  conversation={conversation}
                  active={selectedId === conversation.id}
                  channel
                  typing={Boolean(typingThreads[conversation.id])}
                  onOpenConversation={openConversationFromMessage}
                />
              ))}
            </div>
          )}
        </>
      )
    }

    return visibleConversations.map((conversation) => (
      <ConversationRow
        key={`${conversation.type}-${conversation.id}`}
        conversation={conversation}
        active={selectedId === conversation.id}
        typing={Boolean(typingThreads[conversation.id])}
        onOpenConversation={openConversationFromMessage}
      />
    ))
  }, [filter, filteredConversations.length, openConversationFromMessage, selected?.id, selectedCategory, typingThreads, visibleConversations, workspaceConversations])

  async function conversationAction(action: 'mark_unread' | 'mark_read' | 'mute' | 'unmute' | 'pin' | 'unpin') {
    if (!selected) return
    try {
      const data = await apiJson<{ conversation: Conversation; action: string }>(`/api/conversations/${selected.type}/${selected.id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      setSelected(data.conversation)
      setConversations((current) => replaceConversation(current, data.conversation))
      setNotice(action === 'mark_unread'
        ? 'Đã đánh dấu chưa đọc'
        : action === 'mark_read'
          ? 'Đã đánh dấu đã đọc'
          : action === 'mute'
            ? 'Đã tắt thông báo hội thoại'
            : action === 'unmute'
              ? 'Đã bật thông báo hội thoại'
              : action === 'pin'
                ? 'Đã ghim hội thoại'
                : 'Đã bỏ ghim hội thoại')
      reportClientEvent('conversation-action', { action, threadId: selected.id, type: selected.type })
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  function updateText(value: string) {
    setText(value)
    // Show quick reply picker when text starts with "/"
    if (value.startsWith('/') && value.length >= 1) {
      setShowQuickReply(true)
    } else {
      setShowQuickReply(false)
    }
    // @mention picker: only in groups. Detect the most recent "@" before the
    // cursor position and the partial name typed after it.
    if (selected?.type === 'group') {
      const cursor = composerRef.current?.selectionStart ?? value.length
      const upToCursor = value.slice(0, cursor)
      // Match "@" followed by zero or more non-space chars at the end of the slice.
      // Require the "@" to be at the start or preceded by whitespace so emails like
      // "user@example.com" don't trigger the picker.
      const match = upToCursor.match(/(?:^|\s)@([^\s@]*)$/)
      if (match) {
        setMentionQuery(match[1])
      } else {
        setMentionQuery(null)
      }
    } else {
      setMentionQuery(null)
    }
    if (!selected || Date.now() - lastTypingRef.current < 2500) return
    lastTypingRef.current = Date.now()
    apiJson('/api/events/typing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: selected.id, type: selected.type }),
    }).catch(() => undefined)
  }

  function insertMention(member: GroupMember) {
    const textarea = composerRef.current
    if (!textarea) return
    const cursor = textarea.selectionStart ?? text.length
    const upToCursor = text.slice(0, cursor)
    const after = text.slice(cursor)
    // Replace the trailing "@<query>" with "@<displayName> "
    const replaced = upToCursor.replace(/@([^\s@]*)$/, `@${member.displayName} `)
    const next = replaced + after
    const mentionStart = replaced.length - member.displayName.length - 2  // "@" + name + " "
    setText(next)
    setMentionQuery(null)
    setPendingMentions((current) => [...current, { pos: mentionStart, uid: member.id, len: member.displayName.length + 1 }])
    // Restore focus and place cursor after the inserted mention
    requestAnimationFrame(() => {
      textarea.focus()
      const newCursor = replaced.length
      textarea.setSelectionRange(newCursor, newCursor)
    })
  }

  function addQueuedFiles(input: File[] | FileList, source: string) {
    const incoming = Array.from(input)
    if (incoming.length === 0) return

    const next = [...files]
    const rejected: string[] = []
    let accepted = 0

    for (const file of incoming) {
      if (next.length >= MAX_FILE_COUNT) {
        rejected.push(`${file.name}: tối đa ${MAX_FILE_COUNT} file`)
        continue
      }
      if (file.size > MAX_FILE_BYTES) {
        rejected.push(`${file.name}: lớn hơn ${formatBytes(MAX_FILE_BYTES)}`)
        continue
      }
      if (next.some((queued) => sameFile(queued, file))) {
        rejected.push(`${file.name}: trùng file`)
        continue
      }
      next.push(file)
      accepted += 1
    }

    setFiles(next)
    if (fileInput.current) fileInput.current.value = ''
    if (accepted > 0 && rejected.length > 0) setNotice(`Đã thêm ${accepted} file, bỏ qua ${rejected.length} file`)
    else if (accepted > 0) setNotice(`Đã thêm ${accepted} file`)
    else setNotice(rejected[0] || 'Không thể thêm file')
    reportClientEvent('files-queued', { source, accepted, rejected: rejected.length, total: next.length })
  }

  function handleComposerDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    setDragActive(false)
    addQueuedFiles(event.dataTransfer.files, 'drop')
  }

  function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (event.clipboardData.files.length === 0) return
    event.preventDefault()
    addQueuedFiles(event.clipboardData.files, 'paste')
  }

  function removeQueuedFile(name: string, index: number) {
    setFiles((current) => current.filter((file, fileIndex) => file.name !== name || fileIndex !== index))
    if (fileInput.current) fileInput.current.value = ''
  }

  function closeDisclosure(event: ReactMouseEvent<HTMLElement>) {
    event.currentTarget.closest('details')?.removeAttribute('open')
  }

  /**
   * Wrap the textarea selection (or insert empty markers) with a Markdown
   * formatting marker. Used by the format toolbar above the composer.
   */
  function wrapFormat(marker: '**' | '*' | '__' | '~~') {
    const textarea = composerRef.current
    if (!textarea) return
    const start = textarea.selectionStart ?? text.length
    const end = textarea.selectionEnd ?? text.length
    const next = applyFormatting(text, start, end, marker)
    setText(next.text)
    requestAnimationFrame(() => {
      textarea.focus()
      textarea.setSelectionRange(next.selectionStart, next.selectionEnd)
    })
  }

  async function sendMessage() {
    reportClientEvent('send-click', {
      selected: selected?.id,
      textLength: text.length,
      fileCount: files.length,
      sending,
    })
    if (!selected) {
      setNotice('Chưa chọn hội thoại')
      reportClientEvent('send-skip', { reason: 'no-selected' })
      return
    }
    if (status.state !== 'online') {
      setNotice('Zalo chưa online, không thể gửi tin')
      reportClientEvent('send-skip', { reason: 'offline', threadId: selected.id, state: status.state })
      return
    }
    if (sending) {
      reportClientEvent('send-skip', { reason: 'already-sending', threadId: selected.id })
      return
    }
    if (!text.trim() && files.length === 0) {
      setNotice('Nhập tin nhắn hoặc chọn file trước khi gửi')
      reportClientEvent('send-skip', { reason: 'empty-message', threadId: selected.id })
      return
    }
    setSending(true)
    const draftText = text
    // Parse markdown-like formatting (**bold**, *italic*, __underline__, ~~strike~~)
    // and convert to zca-js styles[]. Sent text has the markers stripped.
    const { text: cleanText, styles } = parseStyles(draftText)
    const form = new FormData()
    form.append('threadId', selected.id)
    form.append('type', selected.type)
    form.append('text', cleanText)
    if (styles.length > 0) {
      form.append('styles', JSON.stringify(styles))
    }
    if (replyTo) {
      const raw = replyTo.raw as { data?: Record<string, unknown> } | undefined
      form.append('quote', JSON.stringify({
        content: raw?.data?.content ?? replyTo.text,
        msgType: raw?.data?.msgType ?? "chat.text",
        propertyExt: raw?.data?.propertyExt ?? {},
        uidFrom: replyTo.senderId || "",
        msgId: replyTo.id,
        cliMsgId: String(raw?.data?.cliMsgId ?? replyTo.id),
        ts: String(replyTo.timestamp),
        ttl: 0,
      }))
    }
    // Mentions: keep only those whose recorded position still matches the
    // current text (i.e. the user didn't delete the @name segment afterward).
    const validMentions = pendingMentions.filter((m) =>
      draftText.slice(m.pos, m.pos + m.len + 1).startsWith('@')
    )
    if (validMentions.length > 0) {
      form.append('mentions', JSON.stringify(validMentions))
    }
    files.forEach((file) => form.append('files', file))
    try {
      setNotice('Đang gửi tin...')
      reportClientEvent('send-request', { threadId: selected.id, type: selected.type, textLength: draftText.length, fileCount: files.length, hasQuote: Boolean(replyTo) })
      const response = await apiJson<{ message?: ChatMessage }>('/api/messages', { method: 'POST', body: form })
      if (response.message) setMessages((current) => appendMessage(current, response.message as ChatMessage))
      setText('')
      setFiles([])
      setReplyTo(null)
      setPendingMentions([])
      if (fileInput.current) fileInput.current.value = ''
      setNotice('Đã gửi')
      reportClientEvent('send-success', { threadId: selected.id, hasMessage: Boolean(response.message) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setNotice(`Gửi thất bại: ${message}`)
      reportClientEvent('send-error', { threadId: selected.id, error: message })
      setText(draftText)
    } finally {
      setSending(false)
      // Refocus the composer so the user can keep typing/sending without
      // clicking back into it. requestAnimationFrame waits for the textarea to
      // re-enable after `sending` flips false.
      requestAnimationFrame(() => composerRef.current?.focus())
    }
  }

  function requestNotifications() {
    if ('Notification' in window) {
      Notification.requestPermission().then((permission) => {
        setNotice(permission === 'granted' ? 'Đã bật thông báo trình duyệt' : 'Trình duyệt chưa cấp quyền thông báo')
        reportClientEvent('notification-permission', { permission })
      })
    }
  }

  function openNotification(item: AppNotification) {
    setNotifications((current) => current.map((notification) => notification.id === item.id ? { ...notification, read: true } : notification))
    if (item.threadId && item.type) {
      const conversation = conversations.find((entry) => entry.id === item.threadId) ?? {
        id: item.threadId,
        type: item.type,
        name: item.title,
        unread: 0,
        manualUnread: false,
      }
      void openConversation(conversation)
    }
    setShowNotifications(false)
  }

  // Update categories everywhere: React state, localStorage cache, and the
  // server (keyed by Zalo account). Server is best-effort — offline edits still
  // persist locally and sync next time.
  function persistCategories(next: Category[]) {
    setCategories(next)
    cacheCategories(next)
    if (configured && status.state === 'online') {
      apiJson('/api/categories', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categories: next }),
      }).catch((error) => reportClientEvent('categories-save-error', { error: error instanceof Error ? error.message : String(error) }))
    }
  }

  function addCategory() {
    if (!newCategoryName.trim()) return
    const next = [...categories, { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, name: newCategoryName.trim(), color: newCategoryColor, threadIds: [] }]
    persistCategories(next)
    setNewCategoryName('')
    setNewCategoryColor(CATEGORY_COLORS[(next.length) % CATEGORY_COLORS.length])
  }

  function deleteCategory(id: string) {
    const next = categories.filter((c) => c.id !== id)
    persistCategories(next)
    if (selectedCategory === id) selectCategory(null)
  }

  function toggleThreadInCategory(categoryId: string, threadId: string) {
    const next = categories.map((c) => {
      if (c.id !== categoryId) return c
      const has = c.threadIds.includes(threadId)
      return { ...c, threadIds: has ? c.threadIds.filter((t) => t !== threadId) : [...c.threadIds, threadId] }
    })
    persistCategories(next)
  }

  function bulkAddToCategory(categoryId: string, threadIds: string[]) {
    const next = categories.map((c) => {
      if (c.id !== categoryId) return c
      const merged = Array.from(new Set([...c.threadIds, ...threadIds]))
      return { ...c, threadIds: merged }
    })
    persistCategories(next)
  }

  function openChannelPicker() {
    setPickerSelected(new Set())
    setPickerSearch('')
    setShowChannelPicker(true)
  }

  function confirmChannelPicker() {
    if (selectedCategory && pickerSelected.size > 0) {
      bulkAddToCategory(selectedCategory, Array.from(pickerSelected))
      setNotice(`Đã thêm ${pickerSelected.size} chat vào kênh`)
    }
    setShowChannelPicker(false)
    setPickerSelected(new Set())
  }

  async function muteGroupsInCategory(categoryId: string, mute: boolean) {
    const category = categories.find((c) => c.id === categoryId)
    if (!category) return
    const groupIds = category.threadIds.filter((id) => conversations.find((c) => c.id === id && c.type === 'group'))
    for (const threadId of groupIds) {
      try {
        await apiJson<{ conversation: Conversation }>(`/api/conversations/group/${threadId}/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: mute ? 'mute' : 'unmute' }),
        })
      } catch { /* skip failed */ }
    }
    setNotice(mute ? `Đã tắt thông báo ${groupIds.length} nhóm` : `Đã bật thông báo ${groupIds.length} nhóm`)
    // Refresh conversations
    apiJson<Conversation[]>('/api/conversations').then(applyConversationSnapshot).catch(() => undefined)
  }

  return (
    <main className="appFrame">
      {electron?.isElectron && (
        <header className="windowTitlebar">
          <div className="windowDrag" aria-hidden="true" />
          <div className="trafficLights" role="group" aria-label="Điều khiển cửa sổ">
            <button type="button" className="tl tlClose" onClick={() => electron.closeWindow?.()} title="Đóng" aria-label="Đóng cửa sổ" />
            <button type="button" className="tl tlMin" onClick={() => electron.minimizeWindow?.()} title="Thu nhỏ" aria-label="Thu nhỏ cửa sổ" />
            <button type="button" className="tl tlMax" onClick={() => electron.toggleMaximizeWindow?.()} title={windowMaximized ? 'Bỏ phóng to' : 'Phóng to'} aria-label="Phóng to cửa sổ" data-maximized={windowMaximized ? '' : undefined} />
          </div>
        </header>
      )}
      <section className="shell">
      {(!configured || showSettings) && (
        <Suspense fallback={<div className="loading">Đang tải cài đặt...</div>}>
          <SettingsScreen
            dismissible={configured}
            onClose={() => setShowSettings(false)}
            onSaved={() => { setShowSettings(false); setConfigured(true) }}
          />
        </Suspense>
      )}
      {showGlobalSearch && (
        <Suspense fallback={null}>
          <GlobalSearch
            onOpenThread={(threadId, type) => {
              setShowGlobalSearch(false)
              const existing = conversations.find((c) => c.id === threadId)
              const target = existing ?? { id: threadId, type, name: threadId, unread: 0 }
              openConversation(target as Conversation)
            }}
            onClose={() => setShowGlobalSearch(false)}
          />
        </Suspense>
      )}
      {showFindUser && (
        <Suspense fallback={null}>
          <FindUser
            onOpenChat={(userId, name) => {
              setShowFindUser(false)
              const existing = conversations.find((c) => c.id === userId)
              const target = existing ?? { id: userId, type: 'user' as ThreadKind, name, unread: 0 }
              openConversation(target as Conversation)
            }}
            onClose={() => setShowFindUser(false)}
          />
        </Suspense>
      )}
      {/* === ICON RAIL === */}
      <nav className="iconRail">
        <img className="appLogo" src="./szalo-icon.png" alt="Szalo" />
        <button className={!showCategoryManager && !showNotifications && !showDiagnostics && !showContacts && selectedCategory === null ? 'railButton active' : 'railButton'} onClick={() => { setShowCategoryManager(false); setShowNotifications(false); setShowDiagnostics(false); setShowContacts(false); selectCategory(null); selectConversationFilter('all') }} title="Tất cả chat">
          <MessageCircle size={20} />
          {unreadCount > 0 && <span className="badge">{unreadCount > 99 ? '99+' : unreadCount}</span>}
        </button>
        <button className={showContacts ? 'railButton active' : 'railButton'} onClick={() => {
          setShowContacts(true)
          setShowCategoryManager(false)
          setShowNotifications(false)
          setShowDiagnostics(false)
          selectCategory(null)
          selectConversationFilter('all')
          if (status.state === 'online' && contacts.length === 0 && !contactsLoading) void loadContacts(false)
        }} title="Danh bạ">
          <Users size={20} />
        </button>

        {/* Workspaces (Discord-style) */}
        {categories.length > 0 && <span className="railDivider" />}
        {categories.map((cat) => {
          const workspaceUnread = categoryUnreadById.get(cat.id) ?? 0
          return (
            <button
              key={cat.id}
              className={selectedCategory === cat.id && !showCategoryManager && !showNotifications && !showDiagnostics && !showContacts ? 'railWorkspace active' : 'railWorkspace'}
              onClick={() => { setShowCategoryManager(false); setShowNotifications(false); setShowDiagnostics(false); setShowContacts(false); selectCategory(cat.id); selectConversationFilter('all') }}
              title={cat.name}
              style={{ '--workspace-color': cat.color } as React.CSSProperties}
            >
              <span className="railWorkspaceIcon">{cat.name.slice(0, 1).toUpperCase()}</span>
              {workspaceUnread > 0 && <span className="badge">{workspaceUnread > 99 ? '99+' : workspaceUnread}</span>}
            </button>
          )
        })}

        <span className="railDivider" />

        <button className={showNotifications ? 'railButton active' : 'railButton'} onClick={() => {
          const next = !showNotifications
          setShowNotifications(next)
          if (next) { setShowCategoryManager(false); setShowDiagnostics(false); setShowContacts(false); setNotifications((items) => items.map((item) => ({ ...item, read: true }))) }
        }} title="Thông báo">
          <Bell size={20} />
          {unreadNotificationCount > 0 && <span className="badge">{unreadNotificationCount > 99 ? '99+' : unreadNotificationCount}</span>}
        </button>
        <button className={showCategoryManager ? 'railButton active' : 'railButton'} onClick={() => {
          const next = !showCategoryManager
          setShowCategoryManager(next)
          if (next) { setShowNotifications(false); setShowDiagnostics(false); setShowContacts(false) }
        }} title="Quản lý phân loại">
          <Tag size={20} />
        </button>
        <button className={showDiagnostics ? 'railButton active' : 'railButton'} onClick={() => {
          const next = !showDiagnostics
          setShowDiagnostics(next)
          if (next) { setShowNotifications(false); setShowCategoryManager(false); setShowContacts(false); void loadDiagnostics() }
        }} title="Chẩn đoán">
          <Activity size={20} />
        </button>
        <span className="railSpacer" />
        <button className="railButton" onClick={() => setShowGlobalSearch(true)} title="Tìm tin nhắn toàn cục">
          <Search size={20} />
        </button>
        <button className="railButton" onClick={() => setShowFindUser(true)} title="Tìm người dùng Zalo">
          <Plus size={20} />
        </button>
        <button className="railButton" onClick={() => setShowAutoReply(true)} title="Auto-reply (CRM)">
          <Power size={20} />
        </button>
        <button className="railButton" onClick={() => setShowSettings(true)} title="Cài đặt server">
          <SettingsIcon size={20} />
        </button>
        <button className="railButton" onClick={syncContacts} disabled={syncing} title={syncing ? 'Đang đồng bộ' : 'Đồng bộ'}>
          <RefreshCw size={20} />
        </button>
        {status.state === 'online' && (
          <button className="railButton" onClick={logout} title="Thoát">
            <LogOut size={20} />
          </button>
        )}
      </nav>

      {/* === SIDEBAR PANEL === */}
      <aside className="sidebar">
        <header className="brand">
          <div className="brandText">
            {showContacts ? (
              <>
                <h1>Danh bạ</h1>
                <p>{contactsLoading ? 'Đang tải liên hệ' : `${contacts.length} liên hệ`}</p>
              </>
            ) : selectedCategory && !showCategoryManager && !showNotifications && !showDiagnostics ? (
              <>
                <h1 className="workspaceName">
                  <span className="workspaceColor" style={{ background: selectedCategoryData?.color }} />
                  {selectedCategoryData?.name}
                </h1>
                <p>{filteredConversations.length} hội thoại</p>
              </>
            ) : (
              <>
                <h1>Szalo</h1>
                <p>{status.state === 'online' ? `${status.counts?.total ?? conversations.length} hội thoại` : 'Chưa đăng nhập'}</p>
              </>
            )}
          </div>
          <span className={socketConnected ? 'socketDot online' : 'socketDot offline'} title={socketConnected ? 'Online' : 'Offline'} />
        </header>

        {status.state !== 'online' ? (
          <section className="loginPanel">
            <MessageCircle size={34} />
            <h2>{status.error ? 'Đăng nhập lại Zalo' : 'Đăng nhập Zalo cá nhân'}</h2>
            <p>{status.error ? 'Session cũ đã hết hạn. Tạo QR mới để kết nối lại listener và gửi nhận tin.' : 'Quét QR bằng app Zalo để bắt đầu đồng bộ chat, group và file.'}</p>
            <button className="primary" onClick={startLogin}>{status.error ? 'Tạo QR mới' : 'Tạo QR đăng nhập'}</button>
            {status.qrImage && <img className="qr" src={status.qrImage} alt="Zalo QR login" />}
            {status.state === 'scanned' && <span className="pill">Đã quét, chờ xác nhận</span>}
            {status.error && <p className="error">{status.error}</p>}
          </section>
        ) : showNotifications ? (
          <section className="notificationPanel">
            <header>
              <strong>Thông báo</strong>
              <div>
                {'Notification' in window && Notification.permission !== 'granted' && (
                  <button type="button" onClick={requestNotifications}>Bật trình duyệt</button>
                )}
                {notifications.length > 0 && (
                  <button type="button" onClick={() => setNotifications([])}>Xóa hết</button>
                )}
              </div>
            </header>
            {notifications.length > 0 ? (
              <div className="notificationList">
                {notifications.map((item) => (
                  <button key={item.id} type="button" className={item.read ? 'notificationItem' : 'notificationItem unread'} onClick={() => openNotification(item)}>
                    <NotificationIcon item={item} />
                    <div className="notificationBody">
                      <strong>{item.title}</strong>
                      <span>{item.body}</span>
                      <small>{formatEventTime(item.ts)}</small>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="emptyState">
                <Bell size={28} />
                <p>Chưa có thông báo</p>
              </div>
            )}
          </section>
        ) : showDiagnostics ? (
          <section className="diagnostics">
            <header>
              <strong>Chẩn đoán</strong>
              <button type="button" onClick={loadDiagnostics} disabled={diagnosticsLoading} title="Refresh"><RefreshCw size={14} /></button>
            </header>
            {health ? (
              <>
                <div className="diagGrid">
                  <span>State</span><strong>{health.state}</strong>
                  <span>Self</span><strong>{health.selfId || '-'}</strong>
                  <span>Tin</span><strong>{health.messageStats.total} / self {health.messageStats.self}</strong>
                  <span>Listener</span><strong>{health.recentListenerEvents.length}</strong>
                </div>
                <div className="diagList">
                  <strong>Client</strong>
                  {(health.recentClientEvents.slice(0, 4)).map((event) => (
                    <small key={`${event.ts}-${event.event}`}>{formatEventTime(event.ts)} {event.event} {compactDetail(event.detail)}</small>
                  ))}
                  {health.recentClientEvents.length === 0 && <small>Chưa có event từ browser này</small>}
                </div>
                <div className="diagList">
                  <strong>Send</strong>
                  {(health.recentSends.slice(0, 4)).map((event) => (
                    <small key={`${event.ts}-${event.threadId}`}>{formatEventTime(event.ts)} {event.status} {event.type}:{event.threadId} {event.error || ''}</small>
                  ))}
                  {health.recentSends.length === 0 && <small>Chưa có request gửi tin</small>}
                </div>
                <div className="diagList">
                  <strong>Listener</strong>
                  {(health.recentListenerEvents.slice(0, 4)).map((event) => (
                    <small key={`${event.ts}-${event.event}`}>{formatEventTime(event.ts)} {event.event} {compactDetail(event.detail)}</small>
                  ))}
                </div>
              </>
            ) : (
              <small>{diagnosticsLoading ? 'Đang đọc...' : 'Bấm refresh để đọc'}</small>
            )}
          </section>
        ) : showContacts ? (
          <section className="contactsPanel">
            <header>
              <strong>Danh bạ Zalo</strong>
              <button type="button" onClick={() => loadContacts()} disabled={contactsLoading} title="Tải lại danh bạ">
                <RefreshCw size={14} />
              </button>
            </header>
            <label className="search contactSearch">
              <Search size={16} />
              <input value={contactFilter} onChange={(event) => updateContactSearch(event.target.value)} placeholder="Tìm liên hệ, số điện thoại, ID" />
            </label>
            <div className="contactsSummary">
              <span>{filteredContacts.length} / {contacts.length} liên hệ</span>
              {contactsLoading && <small>Đang tải...</small>}
            </div>
            {contactsLoading && contacts.length === 0 ? (
              <div className="emptyState">
                <RefreshCw size={28} />
                <p>Đang tải danh bạ</p>
              </div>
            ) : filteredContacts.length === 0 ? (
              <div className="emptyState">
                <Users size={28} />
                <p>Không có liên hệ</p>
                <small>{contactFilter ? 'Thử từ khóa khác' : 'Bấm tải lại danh bạ để đồng bộ'}</small>
              </div>
            ) : (
              <div className="contactList">
                {visibleContacts.map((contact) => {
                  const id = contactId(contact)
                  const name = contactName(contact)
                  const conversation = userConversationById.get(id)
                  return (
                    <button key={id} type="button" className={selected?.type === 'user' && selected.id === id ? 'contactItem active' : 'contactItem'} onClick={() => openContactConversation(contact)}>
                      <span className="avatar contactAvatar" style={!contact.avatar ? { background: avatarGradient(id) } : undefined}>
                        {contact.avatar ? <img src={contact.avatar} alt="" /> : name.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="contactText">
                        <strong>{name}</strong>
                        <small>{contact.phoneNumber || id}</small>
                      </span>
                      {conversation?.unread ? <span className="badge">{conversation.unread > 99 ? '99+' : conversation.unread}</span> : null}
                    </button>
                  )
                })}
                {hiddenContactCount > 0 && (
                  <button
                    type="button"
                    className="loadMoreRows"
                    onClick={() => setVisibleContactLimit((current) => current + CONTACT_RENDER_STEP)}
                  >
                    Hiện thêm {Math.min(CONTACT_RENDER_STEP, hiddenContactCount)} liên hệ
                  </button>
                )}
              </div>
            )}
          </section>
        ) : showCategoryManager ? (
          <section className="categoryManager">
            <header>
              <strong>Phân loại chat</strong>
            </header>
            <div className="addCategoryForm">
              <input value={newCategoryName} onChange={(e) => setNewCategoryName(e.target.value)} placeholder="Tên phân loại mới..." onKeyDown={(e) => { if (e.key === 'Enter') addCategory() }} />
              <div className="colorPicker">
                {CATEGORY_COLORS.map((color) => (
                  <button key={color} type="button" className={newCategoryColor === color ? 'colorDot active' : 'colorDot'} style={{ background: color }} onClick={() => setNewCategoryColor(color)} aria-label="Chọn màu" />
                ))}
              </div>
              <button type="button" className="primary" onClick={addCategory} disabled={!newCategoryName.trim()}>Thêm phân loại</button>
            </div>
            {categories.length > 0 && (
              <div className="categoryList">
                {categories.map((cat) => (
                  <div key={cat.id} className="categoryItem">
                    <span className="categoryBadge" style={{ background: cat.color }} />
                    <span className="categoryName">{cat.name}</span>
                    <small className="categoryCount">{cat.threadIds.length}</small>
                    <div className="categoryActions">
                      <button type="button" onClick={() => muteGroupsInCategory(cat.id, true)} title="Tắt thông báo nhóm"><BellOff size={13} /></button>
                      <button type="button" onClick={() => muteGroupsInCategory(cat.id, false)} title="Bật thông báo nhóm"><Bell size={13} /></button>
                      <button type="button" onClick={() => deleteCategory(cat.id)} title="Xóa"><X size={13} /></button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {selected && categories.length > 0 && (
              <div className="assignCategory">
                <small>Gán "{selected.name}" vào:</small>
                <div className="assignTags">
                  {categories.map((cat) => (
                    <button key={cat.id} type="button" className={cat.threadIds.includes(selected.id) ? 'categoryTag assigned' : 'categoryTag'} onClick={() => toggleThreadInCategory(cat.id, selected.id)}>
                      <span className="categoryBadge" style={{ background: cat.color }} />
                      {cat.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {categories.length === 0 && (
              <div className="emptyState">
                <Tag size={28} />
                <p>Chưa có phân loại nào</p>
                <small>Thêm phân loại ở trên để nhóm các cuộc trò chuyện</small>
              </div>
            )}
          </section>
        ) : (
          <>
            <label className="search">
              <Search size={16} />
              <input value={filter} onChange={(event) => updateConversationSearch(event.target.value)} placeholder="Tìm chat, group, ID" />
            </label>
            {!selectedCategory && (
              <div className="segments">
                <button className={conversationFilter === 'all' ? 'active' : ''} onClick={() => selectConversationFilter('all')}>Tất cả {conversations.length}</button>
                <button className={conversationFilter === 'user' ? 'active' : ''} onClick={() => selectConversationFilter('user')}>Cá nhân {userCount}</button>
                <button className={conversationFilter === 'group' ? 'active' : ''} onClick={() => selectConversationFilter('group')}>Nhóm {groupCount}</button>
              </div>
            )}
            {selectedCategory && (
              <button className="addToChannelBtn" onClick={openChannelPicker}>
                <Plus size={14} />
                Thêm chat vào kênh
              </button>
            )}
            <nav className="conversationList">
              {conversationListContent}
              {hiddenConversationCount > 0 && (
                <button
                  type="button"
                  className="loadMoreRows"
                  onClick={() => setVisibleConversationLimit((current) => current + CONVERSATION_RENDER_STEP)}
                >
                  Hiện thêm {Math.min(CONVERSATION_RENDER_STEP, hiddenConversationCount)} hội thoại
                </button>
              )}
            </nav>
          </>
        )}
      </aside>

      <section className="chat">
        {selected ? (
          <>
            <header className="chatHeader">
              <div className="chatHeaderTitle">
                <span className="chatHeaderAvatar" style={!selected.avatar ? { background: avatarGradient(selected.id) } : undefined}>
                  {selected.avatar ? <img src={selected.avatar} alt="" /> : selected.type === 'group' ? <Users size={16} /> : selected.name.slice(0, 1).toUpperCase()}
                </span>
                <div className="chatHeaderText">
                  <h2>{selected.name}</h2>
                  <p>{selected.type === 'group' ? 'Nhóm' : 'Cá nhân'} · {selected.id}</p>
                </div>
              </div>
              <div className="chatTools">
                <label className="messageSearch">
                  <Search size={14} />
                  <input value={messageFilter} onChange={(event) => updateMessageFilter(event.target.value)} placeholder="Tìm tin nhắn" />
                </label>
                <div className="iconGroup">
                  <button className={showAttachments ? 'iconButton active' : 'iconButton'} onClick={() => {
                    const next = !showAttachments
                    setShowAttachments(next)
                    reportClientEvent('attachments-panel', { open: next, count: attachmentCount })
                  }} title="Tệp trong chat">
                    <FileUp size={16} />
                  </button>
                  <button className={showThreadInfo ? 'iconButton active' : 'iconButton'} onClick={() => {
                    const next = !showThreadInfo
                    setShowThreadInfo(next)
                    if (next && selected.type === 'group' && !groupDetail) void loadGroupDetail(selected.id)
                    if (next && selected.type === 'user' && !userDetail) void loadUserDetail(selected.id)
                  }} title="Thông tin">
                    <Info size={16} />
                  </button>
                  <button className="iconButton" onClick={() => openConversation(selected, true)} disabled={opening} title="Tải lại">
                    <RefreshCw size={16} />
                  </button>
                  <details className="actionMenu">
                    <summary className="iconButton actionMenuTrigger" title="Thao tác khác" aria-label="Thao tác khác">
                      <MoreHorizontal size={16} />
                    </summary>
                    <div className="actionMenuPanel">
                      {electron && (
                        <button type="button" className="actionMenuItem" onClick={(event) => {
                          closeDisclosure(event)
                          electron.openBubble({ threadId: selected.id, type: selected.type, name: selected.name, avatar: selected.avatar })
                        }}>
                          <CircleDot size={15} />
                          <span>Bong bóng chat</span>
                        </button>
                      )}
                      {categories.length > 0 && (
                        <button type="button" className="actionMenuItem" onClick={(event) => {
                          closeDisclosure(event)
                          setShowCategoryManager(true)
                          setShowNotifications(false)
                          setShowDiagnostics(false)
                          setShowContacts(false)
                        }}>
                          <Tag size={15} />
                          <span>Thêm vào kênh</span>
                        </button>
                      )}
                      <button type="button" className={selected.pinned ? 'actionMenuItem active' : 'actionMenuItem'} onClick={(event) => {
                        closeDisclosure(event)
                        conversationAction(selected.pinned ? 'unpin' : 'pin')
                      }}>
                        {selected.pinned ? <PinOff size={15} /> : <Pin size={15} />}
                        <span>{selected.pinned ? 'Bỏ ghim' : 'Ghim hội thoại'}</span>
                      </button>
                      <button type="button" className={selected.muted ? 'actionMenuItem active' : 'actionMenuItem'} onClick={(event) => {
                        closeDisclosure(event)
                        conversationAction(selected.muted ? 'unmute' : 'mute')
                      }}>
                        {selected.muted ? <BellOff size={15} /> : <Bell size={15} />}
                        <span>{selected.muted ? 'Bật thông báo' : 'Tắt thông báo'}</span>
                      </button>
                      <button type="button" className="actionMenuItem" onClick={(event) => {
                        closeDisclosure(event)
                        setShowReminders(true)
                      }}>
                        <Calendar size={15} />
                        <span>Reminder</span>
                      </button>
                      <button type="button" className="actionMenuItem" onClick={(event) => {
                        closeDisclosure(event)
                        conversationAction(selected.unread > 0 ? 'mark_read' : 'mark_unread')
                      }}>
                        <CheckCheck size={15} />
                        <span>{selected.unread > 0 ? 'Đánh dấu đã đọc' : 'Đánh dấu chưa đọc'}</span>
                      </button>
                    </div>
                  </details>
                </div>
              </div>
            </header>
            {showThreadInfo && selected.type === 'group' && (
              <section className="groupInfo">
                {groupDetailLoading && !groupDetail ? (
                  <span>Đang tải thông tin nhóm...</span>
                ) : groupDetail ? (
                  <>
                    <div className="groupSummary">
                      <strong>{groupDetail.totalMember || groupDetail.members.length} thành viên</strong>
                      <span>{groupDetail.adminIds.length} quản trị viên</span>
                      {groupDetail.setting.lockSendMsg ? <span>Đang khóa gửi tin</span> : <span>Được gửi tin</span>}
                      {groupDetail.setting.joinAppr ? <span>Duyệt thành viên mới</span> : <span>Mở tham gia</span>}
                    </div>
                    {groupDetail.description && <p>{groupDetail.description}</p>}
                    <div className="memberStrip">
                      {groupDetail.members.slice(0, 12).map((member) => (
                        <span className="memberItem" key={member.id} title={member.displayName} onClick={() => {
                          const existing = conversations.find((c) => c.id === member.id)
                          const target = existing ?? { id: member.id, type: 'user' as ThreadKind, name: member.displayName, avatar: member.avatar, unread: 0 }
                          openConversation(target as Conversation)
                        }} style={{ cursor: 'pointer' }}>
                          <span className="memberAvatar" style={!member.avatar ? { background: avatarGradient(member.id) } : undefined}>
                            {member.avatar ? <img src={member.avatar} alt="" /> : member.displayName.slice(0, 1).toUpperCase()}
                          </span>
                          <small>{member.displayName}</small>
                          {member.isAdmin && <em>Admin</em>}
                        </span>
                      ))}
                      <button type="button" className="viewAllMembersBtn" onClick={() => setShowAllMembers(true)}>
                        Xem tất cả {groupDetail.totalMember || groupDetail.members.length}
                      </button>
                    </div>
                    {groupDetail.warning && <small className="warning">Thành viên tải một phần: {groupDetail.warning}</small>}
                  </>
                ) : (
                  <button type="button" onClick={() => loadGroupDetail(selected.id)}>Tải thông tin nhóm</button>
                )}
              </section>
            )}
            {showThreadInfo && selected.type === 'user' && (
              <section className="userInfo">
                {userDetailLoading && !userDetail ? (
                  <span>Đang tải hồ sơ...</span>
                ) : userDetail ? (
                  <>
                    <div className="userCard">
                      <span className="userAvatar" style={!userDetail.avatar ? { background: avatarGradient(userDetail.id) } : undefined}>
                        {userDetail.avatar ? <img src={userDetail.avatar} alt="" /> : userDetail.displayName.slice(0, 1).toUpperCase()}
                      </span>
                      <div>
                        <strong>{userDetail.displayName}</strong>
                        <small>{userDetail.zaloName || userDetail.username || userDetail.id}</small>
                      </div>
                    </div>
                    <div className="userFacts">
                      <span>{userDetail.isFriend ? 'Bạn bè' : 'Chưa kết bạn'}</span>
                      {userDetail.isBlocked && <span>Đã chặn</span>}
                      {userDetail.phoneNumber && <span>{userDetail.phoneNumber}</span>}
                      {genderLabel(userDetail.gender) && <span>{genderLabel(userDetail.gender)}</span>}
                      {userDetail.birthday && <span>{userDetail.birthday}</span>}
                      {userDetail.isActivePC && <span>Online PC</span>}
                      {userDetail.isActiveWeb && <span>Online Web</span>}
                    </div>
                    {userDetail.status && <p>{userDetail.status}</p>}
                  </>
                ) : (
                  <button type="button" onClick={() => loadUserDetail(selected.id)}>Tải hồ sơ</button>
                )}
              </section>
            )}
            {showAttachments && (
              <section className="attachmentPanel">
                <header>
                  <strong>{attachmentItems.length} tệp trong hội thoại</strong>
                  <button type="button" onClick={() => setShowAttachments(false)} title="Đóng danh sách tệp"><X size={14} /></button>
                </header>
                {attachmentItems.length > 0 ? (
                  <div className="attachmentGrid">
                    {attachmentItems.map((item) => {
                      // Use the original Zalo URL when opening externally so
                      // the browser fetches directly from Zalo's CDN.
                      const externalUrl = item.attachment.href && item.attachment.href.startsWith('http')
                        ? item.attachment.href
                        : item.url
                      return (
                        <a
                          key={`${item.message.id}-${item.index}-${item.attachment.href ?? item.attachment.title}`}
                          href={externalUrl}
                          target="_blank"
                          rel="noreferrer"
                          className={item.isImage ? 'attachmentTile imageTile' : 'attachmentTile'}
                        >
                          <span className="attachmentPreview">
                            {item.preview ? <img src={item.preview} alt="" /> : <FileUp size={20} />}
                          </span>
                          <span>
                            <strong>{item.attachment.title || item.attachment.href || 'Attachment'}</strong>
                            <small>{item.message.isSelf ? 'Bạn' : item.message.senderName || item.message.threadId} - {new Date(item.message.timestamp).toLocaleDateString('vi-VN')}</small>
                            {item.attachment.size && <small>{item.attachment.size} bytes</small>}
                          </span>
                        </a>
                      )
                    })}
                  </div>
                ) : (
                  <span className="emptyAttachment">Chưa có tệp nào trong tin đã tải của hội thoại này</span>
                )}
              </section>
            )}
            <div className="messages">
              {opening && <div className="loading">Đang tải tin nhắn...</div>}
              {selected && typingThreads[selected.id] && <div className="loading">Đang gõ...</div>}
              {messageFilter && filteredMessages.length === 0 && <div className="loading">Không có kết quả</div>}
              {(hiddenMessageCount > 0 || (hasOlderMessages && !messageFilter)) && (
                <button
                  type="button"
                  className="loadOlderMessages"
                  onClick={loadOlderMessages}
                  disabled={loadingOlderMessages}
                >
                  {loadingOlderMessages
                    ? 'Đang tải tin cũ...'
                    : hiddenMessageCount > 0
                      ? `Hiện thêm ${Math.min(MESSAGE_RENDER_STEP, hiddenMessageCount)} tin cũ`
                      : `Tải thêm ${MESSAGE_PAGE_LIMIT} tin cũ`}
                </button>
              )}
              {visibleMessages.map((message) => (
                <MessageRow
                  key={message.id}
                  message={message}
                  selectedType={selected?.type}
                  userConversationById={userConversationById}
                  onOpenConversation={openConversationFromMessage}
                  onReply={setReplyTo}
                  onUndone={handleMessageUndone}
                  onNotice={setNotice}
                />
              ))}
              <div ref={endRef} />
            </div>
            {replyTo && (
              <div className="replyPreview">
                <strong>{replyTo.isSelf ? 'Bạn' : replyTo.senderName || '?'}</strong>
                <span>{replyTo.text || (replyTo.attachments.length ? 'Tệp đính kèm' : 'Tin nhắn')}</span>
                <button type="button" onClick={() => setReplyTo(null)} title="Hủy trả lời"><X size={14} /></button>
              </div>
            )}
            <footer
              className={dragActive ? 'composer dragActive' : 'composer'}
              onDragEnter={(event) => {
                event.preventDefault()
                setDragActive(true)
              }}
              onDragOver={(event) => {
                event.preventDefault()
                setDragActive(true)
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleComposerDrop}
            >
              {showQuickReply && (
                <Suspense fallback={null}>
                  <QuickReplyPicker
                    filter={text}
                    onSelect={(reply) => { setText(reply); setShowQuickReply(false) }}
                    onClose={() => setShowQuickReply(false)}
                  />
                </Suspense>
              )}
              {mentionQuery !== null && selected?.type === 'group' && (
                <Suspense fallback={null}>
                  <MentionPicker
                    groupId={selected.id}
                    query={mentionQuery}
                    onSelect={insertMention}
                    onClose={() => setMentionQuery(null)}
                  />
                </Suspense>
              )}
              {showStickers && selected && (
                <Suspense fallback={null}>
                  <StickerPicker
                    threadId={selected.id}
                    threadType={selected.type}
                    onSent={() => setShowStickers(false)}
                    onClose={() => setShowStickers(false)}
                  />
                </Suspense>
              )}
              <div className="dropHint">Kéo file vào đây hoặc paste ảnh/file từ clipboard. Tối đa {MAX_FILE_COUNT} file, {formatBytes(MAX_FILE_BYTES)}/file.</div>
              {files.length > 0 && <div className="fileQueue">{files.map((file, index) => (
                <span key={`${file.name}-${index}`} title={`${file.name} - ${formatBytes(file.size)}`}>
                  <strong>{file.name}</strong>
                  <small>{formatBytes(file.size)}</small>
                  <button type="button" onClick={() => removeQueuedFile(file.name, index)} title="Remove file"><X size={13} /></button>
                </span>
              ))}</div>}
              {recordingVoice && selected && (
                <Suspense fallback={null}>
                  <VoiceRecorder
                    threadId={selected.id}
                    threadType={selected.type}
                    onSent={() => { setRecordingVoice(false); setNotice('Đã gửi voice') }}
                    onCancel={() => setRecordingVoice(false)}
                  />
                </Suspense>
              )}
              <form className="composeRow" onSubmit={(event) => {
                event.preventDefault()
                sendMessage()
              }}>
                <input ref={fileInput} type="file" multiple hidden onChange={(event) => addQueuedFiles(event.target.files ?? [], 'picker')} />
                <div className="composeActions" aria-label="Công cụ soạn tin">
                  <details className="composeMenu">
                    <summary className="attachButton composeMenuTrigger" title="Công cụ gửi" aria-label="Công cụ gửi">
                      <Paperclip size={18} />
                    </summary>
                    <div className="composeMenuPanel">
                      <button type="button" className="composeMenuItem" onClick={(event) => {
                        closeDisclosure(event)
                        fileInput.current?.click()
                      }}>
                        <Paperclip size={16} />
                        <span>Đính kèm file</span>
                      </button>
                      <button type="button" className={showStickers ? 'composeMenuItem active' : 'composeMenuItem'} onClick={(event) => {
                        closeDisclosure(event)
                        setShowStickers(!showStickers)
                      }}>
                        <Smile size={16} />
                        <span>Sticker</span>
                      </button>
                      <button type="button" className={recordingVoice ? 'composeMenuItem active' : 'composeMenuItem'} onClick={(event) => {
                        closeDisclosure(event)
                        setRecordingVoice(true)
                      }}>
                        <Mic size={16} />
                        <span>Ghi âm</span>
                      </button>
                      <button type="button" className="composeMenuItem" onClick={(event) => {
                        closeDisclosure(event)
                        setShowBankCard(true)
                      }}>
                        <CreditCard size={16} />
                        <span>Gửi STK ngân hàng</span>
                      </button>
                    </div>
                  </details>
                  <details className="composeMenu formatMenu">
                    <summary className="attachButton formatMenuTrigger" title="Định dạng" aria-label="Định dạng">Aa</summary>
                    <div className="composeMenuPanel formatMenuPanel">
                      <button type="button" className="composeMenuItem" onClick={(event) => { closeDisclosure(event); wrapFormat('**') }} title="Đậm (Ctrl+B)"><strong>B</strong><span>Đậm</span></button>
                      <button type="button" className="composeMenuItem" onClick={(event) => { closeDisclosure(event); wrapFormat('*') }} title="Nghiêng (Ctrl+I)"><em>I</em><span>Nghiêng</span></button>
                      <button type="button" className="composeMenuItem" onClick={(event) => { closeDisclosure(event); wrapFormat('__') }} title="Gạch chân (Ctrl+U)"><span style={{ textDecoration: 'underline' }}>U</span><span>Gạch chân</span></button>
                      <button type="button" className="composeMenuItem" onClick={(event) => { closeDisclosure(event); wrapFormat('~~') }} title="Gạch ngang"><s>S</s><span>Gạch ngang</span></button>
                    </div>
                  </details>
                </div>
                <div className="composeInput">
                  <textarea ref={composerRef} value={text} disabled={sending} onPaste={handleComposerPaste} onChange={(event) => updateText(event.target.value)} placeholder="Nhập tin nhắn..." onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      sendMessage()
                      return
                    }
                    // Ctrl+B/I/U formatting shortcuts
                    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
                      if (event.key === 'b' || event.key === 'B') {
                        event.preventDefault()
                        wrapFormat('**')
                      } else if (event.key === 'i' || event.key === 'I') {
                        event.preventDefault()
                        wrapFormat('*')
                      } else if (event.key === 'u' || event.key === 'U') {
                        event.preventDefault()
                        wrapFormat('__')
                      }
                    }
                  }} />
                </div>
                <button className="send" type="submit" disabled={sending || status.state !== 'online'} title={sending ? 'Đang gửi' : 'Gửi tin'}><Send size={18} /><span>Gửi</span></button>
              </form>
            </footer>
          </>
        ) : (
          <div className="empty">
            <MessageCircle size={44} />
            <h2>Chọn một cuộc trò chuyện</h2>
            <p>Đăng nhập, đồng bộ danh bạ/nhóm rồi mở chat để gửi nhận tin nhắn và file.</p>
          </div>
        )}
        {notice && <div className="toast" onAnimationEnd={() => setNotice('')}>{notice}</div>}
      </section>

      {/* Channel picker modal */}
      {showAllMembers && selected?.type === 'group' && (
        <Suspense fallback={null}>
          <GroupMembersModal
            groupId={selected.id}
            groupName={selected.name}
            onOpenChat={(userId, displayName, avatar) => {
              setShowAllMembers(false)
              const existing = conversations.find((c) => c.id === userId)
              const target = existing ?? { id: userId, type: 'user' as ThreadKind, name: displayName, avatar, unread: 0 }
              openConversation(target as Conversation)
            }}
            onClose={() => setShowAllMembers(false)}
          />
        </Suspense>
      )}
      {showReminders && selected && (
        <Suspense fallback={null}>
          <RemindersPanel
            threadId={selected.id}
            threadType={selected.type}
            onClose={() => setShowReminders(false)}
          />
        </Suspense>
      )}
      {showAutoReply && (
        <Suspense fallback={null}>
          <AutoReplyPanel onClose={() => setShowAutoReply(false)} />
        </Suspense>
      )}
      {showBankCard && selected && (
        <Suspense fallback={null}>
          <BankCardForm
            threadId={selected.id}
            threadType={selected.type}
            onSent={() => { setShowBankCard(false); setNotice('Đã gửi STK') }}
            onClose={() => setShowBankCard(false)}
          />
        </Suspense>
      )}
      {showChannelPicker && selectedCategory && (() => {
        const currentCategory = categories.find((c) => c.id === selectedCategory)
        const existingIds = new Set(currentCategory?.threadIds ?? [])
        const query = deferredPickerSearch.trim().toLowerCase()
        const candidates = conversations.filter((c) => {
          if (existingIds.has(c.id)) return false
          if (!query) return true
          return c.name.toLowerCase().includes(query) || c.id.includes(query)
        })
        const usersC = candidates.filter((c) => c.type === 'user')
        const groupsC = candidates.filter((c) => c.type === 'group')
        return (
          <div className="modalBackdrop" onClick={() => setShowChannelPicker(false)}>
            <div className="modalContent" onClick={(e) => e.stopPropagation()}>
              <header className="modalHeader">
                <div>
                  <strong>Thêm chat vào "{currentCategory?.name}"</strong>
                  <small>{pickerSelected.size} đã chọn</small>
                </div>
                <button onClick={() => setShowChannelPicker(false)}><X size={16} /></button>
              </header>
              <div className="modalSearch">
                <Search size={14} />
                <input value={pickerSearch} onChange={(e) => setPickerSearch(e.target.value)} placeholder="Tìm chat..." autoFocus />
              </div>
              <div className="modalList">
                {candidates.length === 0 ? (
                  <div className="emptyState">
                    <MessageCircle size={28} />
                    <p>{query ? 'Không tìm thấy' : 'Tất cả chat đã trong kênh'}</p>
                  </div>
                ) : (
                  <>
                    {groupsC.length > 0 && (
                      <>
                        <div className="modalSectionHeader">Nhóm ({groupsC.length})</div>
                        {groupsC.map((c) => (
                          <label key={c.id} className={pickerSelected.has(c.id) ? 'modalRow checked' : 'modalRow'}>
                            <input type="checkbox" checked={pickerSelected.has(c.id)} onChange={() => {
                              setPickerSelected((prev) => {
                                const next = new Set(prev)
                                if (next.has(c.id)) next.delete(c.id); else next.add(c.id)
                                return next
                              })
                            }} />
                            <span className="avatar small" style={!c.avatar ? { background: avatarGradient(c.id) } : undefined}>
                              {c.avatar ? <img src={c.avatar} alt="" /> : <Users size={14} />}
                            </span>
                            <span className="modalRowText">{c.name}</span>
                          </label>
                        ))}
                      </>
                    )}
                    {usersC.length > 0 && (
                      <>
                        <div className="modalSectionHeader">Cá nhân ({usersC.length})</div>
                        {usersC.map((c) => (
                          <label key={c.id} className={pickerSelected.has(c.id) ? 'modalRow checked' : 'modalRow'}>
                            <input type="checkbox" checked={pickerSelected.has(c.id)} onChange={() => {
                              setPickerSelected((prev) => {
                                const next = new Set(prev)
                                if (next.has(c.id)) next.delete(c.id); else next.add(c.id)
                                return next
                              })
                            }} />
                            <span className="avatar small" style={!c.avatar ? { background: avatarGradient(c.id) } : undefined}>
                              {c.avatar ? <img src={c.avatar} alt="" /> : c.name.slice(0, 1).toUpperCase()}
                            </span>
                            <span className="modalRowText">{c.name}</span>
                          </label>
                        ))}
                      </>
                    )}
                  </>
                )}
              </div>
              <footer className="modalFooter">
                <button className="modalBtn ghost" onClick={() => setShowChannelPicker(false)}>Hủy</button>
                <button className="modalBtn primary" disabled={pickerSelected.size === 0} onClick={confirmChannelPicker}>
                  Thêm {pickerSelected.size > 0 ? `${pickerSelected.size} chat` : ''}
                </button>
              </footer>
            </div>
          </div>
        )
      })()}
      </section>
    </main>
  )
}

export default App
