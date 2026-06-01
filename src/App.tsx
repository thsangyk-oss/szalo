import { useEffect, useMemo, useRef, useState } from 'react'
import type { ClipboardEvent, DragEvent } from 'react'
import { Activity, Bell, BellOff, CheckCheck, CircleDot, FileUp, Info, LogOut, MessageCircle, Paperclip, Pin, PinOff, Plus, RefreshCw, Search, Send, Tag, X, Users } from 'lucide-react'
import { io } from 'socket.io-client'
import './App.css'

// Electron bridge (available when running inside Electron shell)
const electron = (window as unknown as { electronAPI?: {
  sendNotification: (data: { title: string; body: string; threadId?: string; type?: string }) => void
  setUnreadCount: (count: number) => void
  flashFrame: () => void
  onOpenThread: (cb: (data: { threadId: string; type: string }) => void) => () => void
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

const API_URL = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:4010' : '')
const socket = io(API_URL, { transports: ['websocket'] })
const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_FILE_COUNT = 10

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

type ChatMessage = {
  id: string
  threadId: string
  type: ThreadKind
  senderName?: string
  text: string
  timestamp: number
  isSelf: boolean
  deliveryStatus?: DeliveryStatus
  attachments: Array<{ title?: string; href?: string; thumb?: string; type?: string; size?: string }>
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
  read: boolean
}

type Category = {
  id: string
  name: string
  color: string
  threadIds: string[]
}

const CATEGORY_COLORS = ['#7c5cff', '#ff4d6a', '#34d399', '#fbbf24', '#3b82f6', '#f97316', '#ec4899', '#06b6d4']

function loadCategories(): Category[] {
  try {
    const raw = localStorage.getItem('zalo-categories')
    return raw ? JSON.parse(raw) as Category[] : []
  } catch { return [] }
}

function saveCategories(categories: Category[]) {
  localStorage.setItem('zalo-categories', JSON.stringify(categories))
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${url}`, init)
  const payload = await response.json().catch(() => null) as { error?: string } | null
  if (!response.ok) {
    throw new Error(payload?.error || `HTTP ${response.status}`)
  }
  return payload as T
}

function reportClientEvent(event: string, detail?: unknown) {
  fetch(`${API_URL}/api/client-events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, detail }),
  }).catch(() => undefined)
}

function attachmentUrl(href?: string, title?: string) {
  if (!href) return undefined
  if (!href.startsWith('http')) return `${API_URL}${href}`
  const params = new URLSearchParams({ url: href })
  if (title) params.set('name', title)
  return `${API_URL}/api/attachments/proxy?${params.toString()}`
}

function isImageAttachment(attachment: ChatMessage['attachments'][number]) {
  const value = `${attachment.type ?? ''} ${attachment.href ?? ''} ${attachment.thumb ?? ''}`.toLowerCase()
  return value.includes('image') || /\.(png|jpe?g|gif|webp)(\?|$)/.test(value)
}

function appendMessage(list: ChatMessage[], message: ChatMessage) {
  if (list.some((item) => item.id === message.id)) return list
  return [...list, message]
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
  return list.map((conversation) => conversation.id === threadId ? { ...conversation, unread: 0, manualUnread: false } : conversation)
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

function App() {
  const [status, setStatus] = useState<Status>({ state: 'offline', account: null, selfId: '', qrImage: '', error: '' })
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [selected, setSelected] = useState<Conversation | null>(null)
  const [filter, setFilter] = useState('')
  const [conversationFilter, setConversationFilter] = useState<ConversationFilter>('all')
  const [messageFilter, setMessageFilter] = useState('')
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [notice, setNotice] = useState('')
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [showNotifications, setShowNotifications] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [opening, setOpening] = useState(false)
  const [sending, setSending] = useState(false)
  const [socketConnected, setSocketConnected] = useState(socket.connected)
  const [typingThreads, setTypingThreads] = useState<Record<string, number>>({})
  const [dragActive, setDragActive] = useState(false)
  const [showAttachments, setShowAttachments] = useState(false)
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [health, setHealth] = useState<Health | null>(null)
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false)
  const [groupDetail, setGroupDetail] = useState<GroupDetail | null>(null)
  const [groupDetailLoading, setGroupDetailLoading] = useState(false)
  const [userDetail, setUserDetail] = useState<UserDetail | null>(null)
  const [userDetailLoading, setUserDetailLoading] = useState(false)
  const lastTypingRef = useRef(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const selectedRef = useRef<Conversation | null>(null)
  const conversationsRef = useRef<Conversation[]>([])

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

  const filteredConversations = useMemo(() => {
    const query = filter.trim().toLowerCase()
    return conversations.filter((item) => {
      const matchesType = conversationFilter === 'all' || item.type === conversationFilter
      const matchesQuery = !query || item.name.toLowerCase().includes(query) || item.id.includes(query)
      const matchesCategory = !selectedCategory || categories.find((c) => c.id === selectedCategory)?.threadIds.includes(item.id)
      return matchesType && matchesQuery && matchesCategory
    })
  }, [conversationFilter, conversations, filter, selectedCategory, categories])

  const userCount = conversations.filter((item) => item.type === 'user').length
  const groupCount = conversations.filter((item) => item.type === 'group').length
  const unreadCount = conversations.reduce((total, item) => total + item.unread, 0)
  const unreadNotificationCount = notifications.filter((item) => !item.read).length
  const filteredMessages = useMemo(() => {
    const query = messageFilter.trim().toLowerCase()
    if (!query) return messages
    return messages.filter((message) => {
      const attachmentText = message.attachments
        .map((attachment) => `${attachment.title ?? ''} ${attachment.href ?? ''} ${attachment.type ?? ''}`)
        .join(' ')
      return `${message.senderName ?? ''} ${message.text} ${attachmentText}`.toLowerCase().includes(query)
    })
  }, [messageFilter, messages])

  const attachmentItems = useMemo(() => {
    return messages
      .flatMap((message) => message.attachments.map((attachment, index) => {
        const url = attachmentUrl(attachment.href, attachment.title)
        const preview = attachment.thumb ? attachmentUrl(attachment.thumb, attachment.title) : (isImageAttachment(attachment) ? url : undefined)
        return { message, attachment, index, url, preview, isImage: isImageAttachment(attachment) }
      }))
      .reverse()
  }, [messages])

  function pushNotification(item: Omit<AppNotification, 'id' | 'ts' | 'read'>) {
    setNotifications((current) => [
      { ...item, id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, ts: Date.now(), read: false },
      ...current,
    ].slice(0, 60))
  }

  useEffect(() => {
    selectedRef.current = selected
  }, [selected])

  useEffect(() => {
    conversationsRef.current = conversations
  }, [conversations])

  useEffect(() => {
    const handleConnect = () => {
      setSocketConnected(true)
      reportClientEvent('socket-connect', { socketId: socket.id })
    }
    const handleDisconnect = (reason: string) => {
      setSocketConnected(false)
      reportClientEvent('socket-disconnect', { reason })
    }
    const handleConversations = (items: Conversation[]) => {
      const currentSelected = selectedRef.current
      setConversations(currentSelected ? markConversationRead(items, currentSelected.id) : items)
      // Sync selected with latest conversation data (name/avatar may change)
      if (currentSelected) {
        const updated = items.find((item) => item.id === currentSelected.id)
        if (updated && (updated.name !== currentSelected.name || updated.avatar !== currentSelected.avatar)) {
          setSelected({ ...updated, unread: 0, manualUnread: false })
        }
      }
    }
    const handleMessage = (message: ChatMessage) => {
      const currentSelected = selectedRef.current
      const isOpenThread = currentSelected?.id === message.threadId
      setMessages((current) => {
        if (!isOpenThread) return current
        return appendMessage(current, message)
      })
      if (isOpenThread) {
        setConversations((current) => markConversationRead(current, message.threadId))
        if (!message.isSelf) {
          apiJson('/api/events/seen', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ threadId: message.threadId, type: message.type }),
          }).catch(() => undefined)
        }
      }
      if (!message.isSelf && (!isOpenThread || document.hidden)) {
        const conv = conversationsRef.current.find((c) => c.id === message.threadId)
        const isMuted = conv?.muted
        const title = messageNotificationTitle(message, conv)
        const body = messageNotificationBody(message, conv)
        pushNotification({ kind: 'message', title, body, threadId: message.threadId, type: message.type })
        if (!isMuted) {
          setNotice(`${title}: ${body}`)
          if (electron) {
            electron.sendNotification({ title, body, threadId: message.threadId, type: message.type })
            electron.flashFrame()
          } else if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('Zalo Manager', { body: `${title}: ${body}` })
          }
        }
      }
    }
    const handleMessageStatus = (event: MessageStatusEvent) => {
      setMessages((current) => updateMessageStatus(current, event))
    }
    const handleGroupEvent = (event: { threadId?: string; type?: unknown }) => {
      pushNotification({ kind: 'group', title: 'Cập nhật nhóm', body: 'Có thay đổi trong nhóm', threadId: event.threadId, type: event.threadId ? 'group' : undefined })
      setNotice('Có cập nhật trong nhóm')
    }
    const handleFriendEvent = () => {
      pushNotification({ kind: 'friend', title: 'Cập nhật bạn bè', body: 'Có thay đổi từ bạn bè' })
      setNotice('Có cập nhật bạn bè')
    }
    const handleTyping = (typing: TypingEvent) => {
      if (typing.isSelf) return
      setTypingThreads((current) => ({ ...current, [typing.threadId]: Date.now() + 3500 }))
    }
    const handleBrowserError = (event: ErrorEvent) => {
      reportClientEvent('browser-error', { message: event.message, source: event.filename, line: event.lineno, column: event.colno })
    }
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      reportClientEvent('browser-unhandled-rejection', { reason: event.reason instanceof Error ? event.reason.message : String(event.reason) })
    }

    reportClientEvent('app-open', {
      href: window.location.href,
      apiUrl: API_URL,
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
      setMessageFilter('')
      setOpening(true)
      reportClientEvent('notification-open-thread', { threadId, type: safeType })
      apiJson<ChatMessage[]>(`/api/messages/${safeType}/${threadId}`)
        .then((data) => setMessages(Array.isArray(data) ? data : []))
        .catch(() => setMessages([]))
        .finally(() => setOpening(false))
      apiJson('/api/events/seen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId, type: safeType }),
      }).catch(() => undefined)
    })
    apiJson<Status>('/api/status').then(setStatus).catch((error: Error) => setNotice(error.message))
    socket.on('connect', handleConnect)
    socket.on('disconnect', handleDisconnect)
    socket.on('status', setStatus)
    socket.on('conversations', handleConversations)
    socket.on('message', handleMessage)
    socket.on('message_status', handleMessageStatus)
    socket.on('group_event', handleGroupEvent)
    socket.on('friend_event', handleFriendEvent)
    socket.on('typing', handleTyping)
    window.addEventListener('error', handleBrowserError)
    window.addEventListener('unhandledrejection', handleUnhandledRejection)
    return () => {
      socket.off('status', setStatus)
      socket.off('connect', handleConnect)
      socket.off('disconnect', handleDisconnect)
      socket.off('conversations', handleConversations)
      socket.off('message', handleMessage)
      socket.off('message_status', handleMessageStatus)
      socket.off('group_event', handleGroupEvent)
      socket.off('friend_event', handleFriendEvent)
      socket.off('typing', handleTyping)
      cleanupOpenThread?.()
      window.removeEventListener('error', handleBrowserError)
      window.removeEventListener('unhandledrejection', handleUnhandledRejection)
    }
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now()
      setTypingThreads((current) => Object.fromEntries(Object.entries(current).filter(([, expires]) => expires > now)))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages])

  useEffect(() => {
    document.title = unreadCount > 0 ? `(${unreadCount}) Zalo Manager` : 'Zalo Manager'
    if (electron) electron.setUnreadCount(unreadCount)
  }, [unreadCount])

  useEffect(() => {
    if (status.state !== 'online') return
    apiJson<Conversation[]>('/api/conversations')
      .then(setConversations)
      .catch((error: Error) => setNotice(error.message))
  }, [status.state])

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

  async function loadGroupDetail(threadId: string) {
    setGroupDetailLoading(true)
    try {
      const detail = await apiJson<GroupDetail>(`/api/groups/${threadId}`)
      setGroupDetail(detail)
      setConversations((current) => current.map((item) => item.id === detail.id ? { ...item, name: detail.name || item.name, avatar: detail.avatar || item.avatar } : item))
      setSelected((current) => current?.id === detail.id ? { ...current, name: detail.name || current.name, avatar: detail.avatar || current.avatar } : current)
      reportClientEvent('group-detail', { threadId, members: detail.members.length, truncated: detail.truncated, warning: detail.warning || '' })
    } catch (error) {
      setGroupDetail(null)
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setGroupDetailLoading(false)
    }
  }

  async function loadUserDetail(threadId: string) {
    setUserDetailLoading(true)
    try {
      const detail = await apiJson<UserDetail>(`/api/users/${threadId}`)
      setUserDetail(detail)
      const displayName = detail.displayName || detail.zaloName || detail.id
      setConversations((current) => current.map((item) => item.id === detail.id ? { ...item, name: displayName, avatar: detail.avatar || item.avatar } : item))
      setSelected((current) => current?.id === detail.id ? { ...current, name: displayName, avatar: detail.avatar || current.avatar } : current)
      reportClientEvent('user-detail', { threadId, hasPhone: Boolean(detail.phoneNumber), isFriend: detail.isFriend, isBlocked: detail.isBlocked })
    } catch (error) {
      setUserDetail(null)
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setUserDetailLoading(false)
    }
  }

  async function syncContacts() {
    setSyncing(true)
    try {
      const results = await Promise.allSettled([
        apiJson('/api/friends'),
        apiJson('/api/groups'),
      ])
      const list = await apiJson<Conversation[]>('/api/conversations')
      setConversations(list)
      const failed = results.filter((result) => result.status === 'rejected')
      setNotice(failed.length ? `Đồng bộ một phần: ${list.length} hội thoại` : `Đã đồng bộ ${list.length} hội thoại`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setSyncing(false)
    }
  }

  async function openConversation(conversation: Conversation, refresh = false) {
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
    setMessageFilter('')
    setOpening(true)
    reportClientEvent('conversation-open', { threadId: conversation.id, type: conversation.type, refresh })
    try {
      const suffix = refresh ? '?refresh=1' : ''
      const data = await apiJson<ChatMessage[]>(`/api/messages/${conversation.type}/${conversation.id}${suffix}`)
      setMessages(Array.isArray(data) ? data : [])
      await apiJson('/api/events/seen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: conversation.id, type: conversation.type }),
      }).catch(() => undefined)
    } catch (error) {
      setMessages([])
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setOpening(false)
    }
  }

  async function conversationAction(action: 'mark_unread' | 'mark_read' | 'mute' | 'unmute' | 'pin' | 'unpin') {
    if (!selected) return
    try {
      const data = await apiJson<{ conversation: Conversation; action: string }>(`/api/conversations/${selected.type}/${selected.id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      setSelected(data.conversation)
      setConversations((current) => current.map((item) => item.id === selected.id ? data.conversation : item))
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
    if (!selected || Date.now() - lastTypingRef.current < 2500) return
    lastTypingRef.current = Date.now()
    apiJson('/api/events/typing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: selected.id, type: selected.type }),
    }).catch(() => undefined)
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
    const form = new FormData()
    form.append('threadId', selected.id)
    form.append('type', selected.type)
    form.append('text', draftText)
    files.forEach((file) => form.append('files', file))
    try {
      setNotice('Đang gửi tin...')
      reportClientEvent('send-request', { threadId: selected.id, type: selected.type, textLength: draftText.length, fileCount: files.length })
      const response = await apiJson<{ message?: ChatMessage }>('/api/messages', { method: 'POST', body: form })
      if (response.message) setMessages((current) => appendMessage(current, response.message as ChatMessage))
      setText('')
      setFiles([])
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

  function addCategory() {
    if (!newCategoryName.trim()) return
    const next = [...categories, { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, name: newCategoryName.trim(), color: newCategoryColor, threadIds: [] }]
    setCategories(next)
    saveCategories(next)
    setNewCategoryName('')
    setNewCategoryColor(CATEGORY_COLORS[(next.length) % CATEGORY_COLORS.length])
  }

  function deleteCategory(id: string) {
    const next = categories.filter((c) => c.id !== id)
    setCategories(next)
    saveCategories(next)
    if (selectedCategory === id) setSelectedCategory(null)
  }

  function toggleThreadInCategory(categoryId: string, threadId: string) {
    const next = categories.map((c) => {
      if (c.id !== categoryId) return c
      const has = c.threadIds.includes(threadId)
      return { ...c, threadIds: has ? c.threadIds.filter((t) => t !== threadId) : [...c.threadIds, threadId] }
    })
    setCategories(next)
    saveCategories(next)
  }

  function bulkAddToCategory(categoryId: string, threadIds: string[]) {
    const next = categories.map((c) => {
      if (c.id !== categoryId) return c
      const merged = Array.from(new Set([...c.threadIds, ...threadIds]))
      return { ...c, threadIds: merged }
    })
    setCategories(next)
    saveCategories(next)
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
    apiJson<Conversation[]>('/api/conversations').then(setConversations).catch(() => undefined)
  }

  return (
    <main className="shell">
      {/* === ICON RAIL === */}
      <nav className="iconRail">
        <img className="appLogo" src="/szalo-icon.png" alt="Zalo Manager" />
        <button className={!showCategoryManager && !showNotifications && !showDiagnostics && selectedCategory === null ? 'railButton active' : 'railButton'} onClick={() => { setShowCategoryManager(false); setShowNotifications(false); setShowDiagnostics(false); setSelectedCategory(null); setConversationFilter('all') }} title="Tất cả chat">
          <MessageCircle size={20} />
          {unreadCount > 0 && <span className="badge">{unreadCount > 99 ? '99+' : unreadCount}</span>}
        </button>

        {/* Workspaces (Discord-style) */}
        {categories.length > 0 && <span className="railDivider" />}
        {categories.map((cat) => {
          const workspaceUnread = conversations.filter((c) => cat.threadIds.includes(c.id)).reduce((sum, c) => sum + c.unread, 0)
          return (
            <button
              key={cat.id}
              className={selectedCategory === cat.id && !showCategoryManager && !showNotifications && !showDiagnostics ? 'railWorkspace active' : 'railWorkspace'}
              onClick={() => { setShowCategoryManager(false); setShowNotifications(false); setShowDiagnostics(false); setSelectedCategory(cat.id); setConversationFilter('all') }}
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
          if (next) { setShowCategoryManager(false); setShowDiagnostics(false); setNotifications((items) => items.map((item) => ({ ...item, read: true }))) }
        }} title="Thông báo">
          <Bell size={20} />
          {unreadNotificationCount > 0 && <span className="badge">{unreadNotificationCount > 99 ? '99+' : unreadNotificationCount}</span>}
        </button>
        <button className={showCategoryManager ? 'railButton active' : 'railButton'} onClick={() => {
          const next = !showCategoryManager
          setShowCategoryManager(next)
          if (next) { setShowNotifications(false); setShowDiagnostics(false) }
        }} title="Quản lý phân loại">
          <Tag size={20} />
        </button>
        <button className={showDiagnostics ? 'railButton active' : 'railButton'} onClick={() => {
          const next = !showDiagnostics
          setShowDiagnostics(next)
          if (next) { setShowNotifications(false); setShowCategoryManager(false); void loadDiagnostics() }
        }} title="Chẩn đoán">
          <Activity size={20} />
        </button>
        <span className="railSpacer" />
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
            {selectedCategory && !showCategoryManager && !showNotifications && !showDiagnostics ? (
              <>
                <h1 className="workspaceName">
                  <span className="workspaceColor" style={{ background: categories.find((c) => c.id === selectedCategory)?.color }} />
                  {categories.find((c) => c.id === selectedCategory)?.name}
                </h1>
                <p>{filteredConversations.length} hội thoại</p>
              </>
            ) : (
              <>
                <h1>Zalo Manager</h1>
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
                    <span className="notificationIcon" aria-hidden>
                      {item.kind === 'message' ? <MessageCircle size={14} /> : item.kind === 'group' ? <Users size={14} /> : item.kind === 'friend' ? <Bell size={14} /> : <Activity size={14} />}
                    </span>
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
              <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Tìm chat, group, ID" />
            </label>
            {!selectedCategory && (
              <div className="segments">
                <button className={conversationFilter === 'all' ? 'active' : ''} onClick={() => setConversationFilter('all')}>Tất cả {conversations.length}</button>
                <button className={conversationFilter === 'user' ? 'active' : ''} onClick={() => setConversationFilter('user')}>Cá nhân {userCount}</button>
                <button className={conversationFilter === 'group' ? 'active' : ''} onClick={() => setConversationFilter('group')}>Nhóm {groupCount}</button>
              </div>
            )}
            {selectedCategory && (
              <button className="addToChannelBtn" onClick={openChannelPicker}>
                <Plus size={14} />
                Thêm chat vào kênh
              </button>
            )}
            <nav className="conversationList">
              {filteredConversations.length === 0 ? (
                <div className="emptyState">
                  <MessageCircle size={28} />
                  <p>Không có hội thoại</p>
                  <small>{filter ? 'Thử từ khóa khác' : selectedCategory ? 'Chưa có chat nào trong phân loại này' : 'Đồng bộ để tải danh sách'}</small>
                </div>
              ) : selectedCategory ? (
                // Discord-style: group by type within workspace
                <>
                  {filteredConversations.filter((c) => c.type === 'user').length > 0 && (
                    <div className="channelSection">
                      <div className="channelSectionHeader">
                        <span>Cá nhân</span>
                        <small>{filteredConversations.filter((c) => c.type === 'user').length}</small>
                      </div>
                      {filteredConversations.filter((c) => c.type === 'user').map((conversation) => (
                        <button
                          key={`${conversation.type}-${conversation.id}`}
                          className={selected?.id === conversation.id ? 'conversation channel active' : 'conversation channel'}
                          onClick={() => openConversation(conversation)}
                        >
                          <span className="channelHash">@</span>
                          <span className="conversationText">
                            <strong>{conversation.name}</strong>
                            <small>
                              {conversation.pinned && <Pin size={11} />}
                              {conversation.muted && <BellOff size={11} />}
                              {typingThreads[conversation.id] ? <em>Đang gõ...</em> : (conversation.lastMessage || ' ')}
                            </small>
                          </span>
                          {conversation.unread > 0 && <span className="badge">{conversation.unread}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                  {filteredConversations.filter((c) => c.type === 'group').length > 0 && (
                    <div className="channelSection">
                      <div className="channelSectionHeader">
                        <span>Nhóm</span>
                        <small>{filteredConversations.filter((c) => c.type === 'group').length}</small>
                      </div>
                      {filteredConversations.filter((c) => c.type === 'group').map((conversation) => (
                        <button
                          key={`${conversation.type}-${conversation.id}`}
                          className={selected?.id === conversation.id ? 'conversation channel active' : 'conversation channel'}
                          onClick={() => openConversation(conversation)}
                        >
                          <span className="channelHash">#</span>
                          <span className="conversationText">
                            <strong>{conversation.name}</strong>
                            <small>
                              {conversation.pinned && <Pin size={11} />}
                              {conversation.muted && <BellOff size={11} />}
                              {typingThreads[conversation.id] ? <em>Đang gõ...</em> : (conversation.lastMessage || ' ')}
                            </small>
                          </span>
                          {conversation.unread > 0 && <span className="badge">{conversation.unread}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                filteredConversations.map((conversation) => (
                  <button
                    key={`${conversation.type}-${conversation.id}`}
                    className={selected?.id === conversation.id ? 'conversation active' : 'conversation'}
                    onClick={() => openConversation(conversation)}
                  >
                    <span className="avatar" style={!conversation.avatar ? { background: avatarGradient(conversation.id) } : undefined}>
                      {conversation.avatar ? <img src={conversation.avatar} alt="" /> : conversation.type === 'group' ? <Users size={16} /> : conversation.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="conversationText">
                      <strong>{conversation.name}</strong>
                      <small>
                        {conversation.pinned && <Pin size={11} />}
                        {conversation.muted && <BellOff size={11} />}
                        {typingThreads[conversation.id] ? <em>Đang gõ...</em> : (conversation.lastMessage || conversation.id)}
                      </small>
                    </span>
                    {conversation.unread > 0 && <span className="badge">{conversation.unread}</span>}
                  </button>
                ))
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
                  <input value={messageFilter} onChange={(event) => setMessageFilter(event.target.value)} placeholder="Tìm tin nhắn" />
                </label>
                <div className="iconGroup">
                  {electron && (
                    <button className="iconButton" onClick={() => electron.openBubble({ threadId: selected.id, type: selected.type, name: selected.name, avatar: selected.avatar })} title="Bong bóng chat">
                      <CircleDot size={16} />
                    </button>
                  )}
                  {categories.length > 0 && (
                    <button className="iconButton" onClick={() => {
                      setShowCategoryManager(true)
                      setShowNotifications(false)
                      setShowDiagnostics(false)
                    }} title="Thêm vào kênh">
                      <Tag size={16} />
                    </button>
                  )}
                  <button className={showAttachments ? 'iconButton active' : 'iconButton'} onClick={() => {
                    const next = !showAttachments
                    setShowAttachments(next)
                    reportClientEvent('attachments-panel', { open: next, count: attachmentItems.length })
                  }} title="Tệp trong chat">
                    <FileUp size={16} />
                  </button>
                  <button className={selected.pinned ? 'iconButton active' : 'iconButton'} onClick={() => conversationAction(selected.pinned ? 'unpin' : 'pin')} title={selected.pinned ? 'Bỏ ghim' : 'Ghim'}>
                    {selected.pinned ? <PinOff size={16} /> : <Pin size={16} />}
                  </button>
                  <button className={selected.muted ? 'iconButton active' : 'iconButton'} onClick={() => conversationAction(selected.muted ? 'unmute' : 'mute')} title={selected.muted ? 'Bật thông báo' : 'Tắt thông báo'}>
                    {selected.muted ? <BellOff size={16} /> : <Bell size={16} />}
                  </button>
                  <button className="iconButton" onClick={() => conversationAction(selected.unread > 0 ? 'mark_read' : 'mark_unread')} title={selected.unread > 0 ? 'Đánh dấu đã đọc' : 'Đánh dấu chưa đọc'}>
                    <CheckCheck size={16} />
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
                        <span className="memberItem" key={member.id} title={member.displayName}>
                          <span className="memberAvatar" style={!member.avatar ? { background: avatarGradient(member.id) } : undefined}>
                            {member.avatar ? <img src={member.avatar} alt="" /> : member.displayName.slice(0, 1).toUpperCase()}
                          </span>
                          <small>{member.displayName}</small>
                          {member.isAdmin && <em>Admin</em>}
                        </span>
                      ))}
                      {groupDetail.truncated && <span className="moreMembers">+{groupDetail.totalMember - groupDetail.members.length}</span>}
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
                    {attachmentItems.map((item) => (
                      <a
                        key={`${item.message.id}-${item.index}-${item.attachment.href ?? item.attachment.title}`}
                        href={item.url}
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
                    ))}
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
              {filteredMessages.map((message) => (
                <article key={message.id} className={message.isSelf ? 'message self' : 'message'}>
                  <span className="sender">{message.isSelf ? 'Bạn' : message.senderName || message.threadId}</span>
                  {message.text && <p>{message.text}</p>}
                  {message.attachments.map((attachment, index) => {
                    const url = attachmentUrl(attachment.href, attachment.title)
                    const preview = attachment.thumb ? attachmentUrl(attachment.thumb, attachment.title) : (isImageAttachment(attachment) ? url : undefined)
                    const isImage = isImageAttachment(attachment)
                    if (isImage && preview) {
                      return (
                        <img key={`${attachment.href}-${index}`} className="msgImage" src={preview} alt={attachment.title || ''} onContextMenu={(e) => {
                          e.preventDefault()
                          const original = attachment.href || attachment.thumb
                          if (original) navigator.clipboard.writeText(original).then(() => setNotice('Đã copy link ảnh')).catch(() => setNotice('Không copy được link'))
                        }} onClick={(e) => {
                          e.preventDefault()
                          if (url) window.open(url, '_blank', 'noopener,noreferrer')
                        }} />
                      )
                    }
                    return url ? (
                      <a key={`${attachment.href}-${index}`} href={url} target="_blank" rel="noreferrer" className="fileAttachment">
                        <FileUp size={15} /> {attachment.title || 'Tệp đính kèm'} {attachment.size ? `(${attachment.size} bytes)` : ''}
                      </a>
                    ) : (
                      <span className="fileAttachment" key={`${attachment.title}-${index}`}>
                        <FileUp size={15} /> {attachment.title || 'Tệp đính kèm'} {attachment.size ? `(${attachment.size} bytes)` : ''}
                      </span>
                    )
                  })}
                  <span className="messageMeta">
                    <time>{new Date(message.timestamp).toLocaleString('vi-VN')}</time>
                    {message.isSelf && deliveryLabel(message.deliveryStatus) && (
                      <span className="receipt"><CheckCheck size={13} /> {deliveryLabel(message.deliveryStatus)}</span>
                    )}
                  </span>
                </article>
              ))}
              <div ref={endRef} />
            </div>
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
              <div className="dropHint">Kéo file vào đây hoặc paste ảnh/file từ clipboard. Tối đa {MAX_FILE_COUNT} file, {formatBytes(MAX_FILE_BYTES)}/file.</div>
              {files.length > 0 && <div className="fileQueue">{files.map((file, index) => (
                <span key={`${file.name}-${index}`} title={`${file.name} - ${formatBytes(file.size)}`}>
                  <strong>{file.name}</strong>
                  <small>{formatBytes(file.size)}</small>
                  <button type="button" onClick={() => removeQueuedFile(file.name, index)} title="Remove file"><X size={13} /></button>
                </span>
              ))}</div>}
              <form className="composeRow" onSubmit={(event) => {
                event.preventDefault()
                sendMessage()
              }}>
                <input ref={fileInput} type="file" multiple hidden onChange={(event) => addQueuedFiles(event.target.files ?? [], 'picker')} />
                <button type="button" className="attachButton" onClick={() => fileInput.current?.click()} title="Đính kèm file"><Paperclip size={18} /></button>
                <textarea value={text} disabled={sending} onPaste={handleComposerPaste} onChange={(event) => updateText(event.target.value)} placeholder="Nhập tin nhắn..." onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    sendMessage()
                  }
                }} />
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
      {showChannelPicker && selectedCategory && (() => {
        const currentCategory = categories.find((c) => c.id === selectedCategory)
        const existingIds = new Set(currentCategory?.threadIds ?? [])
        const query = pickerSearch.trim().toLowerCase()
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
    </main>
  )
}

export default App
