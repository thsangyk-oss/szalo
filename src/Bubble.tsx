import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { Socket } from 'socket.io-client'
import { Send, X, ArrowLeft, MessageCircle, Image as ImageIcon, FileText } from 'lucide-react'
import { apiUrl, authedInit, getSettings, isConfigured } from './settings'
import { subscribeSocket } from './socket'
import './Bubble.css'

const electron = (window as unknown as { electronAPI?: {
  openBubblePanel: () => void
  closeBubblePanel: () => void
  removeBubble: (threadId: string) => void
  getBubbleThreads: () => BubbleThread[]
  onBubbleThreads: (cb: (data: BubbleThread[]) => void) => () => void
  beginBubbleDockDrag?: () => void
  endBubbleDockDrag?: () => void
} }).electronAPI

type BubbleThread = {
  threadId: string
  type: string
  name: string
  avatar?: string
}

type ChatMessage = {
  id: string
  threadId: string
  type: string
  senderName?: string
  text: string
  timestamp: number
  isSelf: boolean
  attachments: Array<{ title?: string; href?: string; thumb?: string; type?: string }>
}

type Conversation = {
  id: string
  type: string
  name: string
  avatar?: string
  unread: number
  manualUnread?: boolean
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(url), authedInit(init))
  const payload = await response.json().catch(() => null) as { error?: string } | null
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
  return payload as T
}

function attachmentSrc(href?: string) {
  if (!href) return undefined
  const settings = getSettings()
  const key = settings.apiKey ? `&api_key=${encodeURIComponent(settings.apiKey)}` : ''
  if (href.startsWith('http')) {
    return `${apiUrl('/api/attachments/proxy')}?url=${encodeURIComponent(href)}${key}`
  }
  const sep = href.includes('?') ? '&' : '?'
  return `${apiUrl(href)}${settings.apiKey ? `${sep}api_key=${encodeURIComponent(settings.apiKey)}` : ''}`
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

function normalizeThread(thread: BubbleThread): BubbleThread {
  const name = thread.name?.trim() || thread.threadId
  const avatar = thread.avatar?.trim() || undefined
  return { ...thread, type: thread.type || 'user', name, avatar }
}

function applyConversationToThread(thread: BubbleThread, conversation?: Conversation): BubbleThread {
  if (!conversation) return thread
  const next = {
    ...thread,
    type: conversation.type || thread.type,
    name: conversation.name?.trim() || thread.name,
    avatar: conversation.avatar?.trim() || thread.avatar,
  }
  if (next.type === thread.type && next.name === thread.name && next.avatar === thread.avatar) return thread
  return next
}

function syncThreadsWithConversations(threads: BubbleThread[], conversations: Conversation[]) {
  const byId = new Map(conversations.map((item) => [item.id, item]))
  return threads.map((thread) => applyConversationToThread(thread, byId.get(thread.threadId)))
}

function unreadByConversation(conversations: Conversation[]) {
  const map: Record<string, number> = {}
  for (const item of conversations) {
    map[item.id] = item.manualUnread ? 0 : item.unread
  }
  return map
}

function bubbleMessageWindowSize(unread: number) {
  return Math.min(2000, Math.max(50, unread + 20))
}

// ===== BUBBLE DOCK: small 60x60 circle =====
export function BubbleDock() {
  const [threads, setThreads] = useState<BubbleThread[]>((electron?.getBubbleThreads() ?? []).map(normalizeThread))
  const [unreadMap, setUnreadMap] = useState<Record<string, number>>({})
  const [socket, setSocket] = useState<Socket | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const dragRef = useRef<{ startX: number; startY: number; dragging: boolean; moved: boolean }>({
    startX: 0, startY: 0, dragging: false, moved: false
  })

  const totalUnread = threads.reduce((sum, thread) => sum + (unreadMap[thread.threadId] ?? 0), 0)

  useEffect(() => {
    document.documentElement.classList.add('bubbleDockPage')
    document.body.classList.add('bubbleDockPage')
    return () => {
      document.documentElement.classList.remove('bubbleDockPage')
      document.body.classList.remove('bubbleDockPage')
    }
  }, [])

  useEffect(() => {
    const stopDrag = () => {
      if (!dragRef.current.dragging) return
      dragRef.current.dragging = false
      dragRef.current.moved = true
      setIsDragging(false)
      electron?.endBubbleDockDrag?.()
    }
    window.addEventListener('blur', stopDrag)
    window.addEventListener('pagehide', stopDrag)
    return () => {
      window.removeEventListener('blur', stopDrag)
      window.removeEventListener('pagehide', stopDrag)
      stopDrag()
    }
  }, [])

  useEffect(() => {
    if (electron) {
      return electron.onBubbleThreads((data) => setThreads(data.map(normalizeThread)))
    }
  }, [])

  useEffect(() => subscribeSocket(setSocket), [])

  useEffect(() => {
    if (!socket || !isConfigured()) return
    const handleConversations = (items: Conversation[]) => {
      // Ignore empty snapshots (they arrive briefly on socket reconnect before
      // the server re-sends the full list) so the badge doesn't flicker off.
      if (items.length === 0) return
      setUnreadMap(unreadByConversation(items))
      setThreads((current) => syncThreadsWithConversations(current, items))
    }
    apiJson<Conversation[]>('/api/conversations').then(handleConversations).catch(() => undefined)
    socket.on('conversations', handleConversations)
    return () => { socket.off('conversations', handleConversations) }
  }, [socket])

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = {
      startX: e.screenX,
      startY: e.screenY,
      dragging: true,
      moved: false,
    }
    setIsDragging(true)
    electron?.beginBubbleDockDrag?.()
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const ref = dragRef.current
    if (!ref.dragging) return
    const totalDx = Math.abs(e.screenX - ref.startX)
    const totalDy = Math.abs(e.screenY - ref.startY)
    if (!ref.moved && (totalDx > 4 || totalDy > 4)) {
      ref.moved = true
    }
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const ref = dragRef.current
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    electron?.endBubbleDockDrag?.()
    const totalDx = Math.abs(e.screenX - ref.startX)
    const totalDy = Math.abs(e.screenY - ref.startY)
    if (totalDx > 4 || totalDy > 4) {
      ref.moved = true
    }
    if (!ref.moved) {
      // Click — open panel
      electron?.openBubblePanel()
    }
    ref.dragging = false
    setIsDragging(false)
  }

  function handlePointerCancel(e: ReactPointerEvent<HTMLDivElement>) {
    const ref = dragRef.current
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    electron?.endBubbleDockDrag?.()
    ref.dragging = false
    ref.moved = true
    setIsDragging(false)
  }

  const firstThread = threads[0]

  return (
    <div className="dockRoot">
      <div
        className={[
          'dockCircle',
          isDragging ? 'dragging' : '',
          totalUnread > 0 ? 'hasUnread' : '',
        ].filter(Boolean).join(' ')}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        style={firstThread && !firstThread.avatar ? { background: avatarGradient(firstThread.threadId) } : undefined}
      >
      {firstThread?.avatar ? (
        <img src={firstThread.avatar} alt="" className="dockAvatar" draggable={false} />
      ) : (
        <span className="dockLetter">{firstThread ? firstThread.name.slice(0, 1).toUpperCase() : '💬'}</span>
      )}
      {totalUnread > 0 && <span className="dockBadge">{totalUnread > 99 ? '99+' : totalUnread}</span>}
      {threads.length > 1 && <span className="dockCount">{threads.length}</span>}
      </div>
    </div>
  )
}

// ===== BUBBLE PANEL: chat window =====
export function BubblePanel() {
  const [threads, setThreads] = useState<BubbleThread[]>((electron?.getBubbleThreads() ?? []).map(normalizeThread))
  const [activeThread, setActiveThread] = useState<BubbleThread | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [unreadMap, setUnreadMap] = useState<Record<string, number>>({})
  const [socket, setSocket] = useState<Socket | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    document.body.classList.add('bubblePanelPage')
    return () => { document.body.classList.remove('bubblePanelPage') }
  }, [])

  useEffect(() => subscribeSocket(setSocket), [])

  useEffect(() => {
    if (electron) {
      return electron.onBubbleThreads((data) => {
        const nextThreads = data.map(normalizeThread)
        setThreads(nextThreads)
        setActiveThread((current) => {
          if (!current) return current
          const updated = nextThreads.find((thread) => thread.threadId === current.threadId)
          return updated ?? null
        })
      })
    }
  }, [])

  useEffect(() => {
    if (!socket || !isConfigured()) return
    const handleConversations = (items: Conversation[]) => {
      if (items.length === 0) return
      const byId = new Map(items.map((item) => [item.id, item]))
      const nextUnread = unreadByConversation(items)
      if (activeThread) nextUnread[activeThread.threadId] = 0
      setUnreadMap(nextUnread)
      setThreads((current) => syncThreadsWithConversations(current, items))
      setActiveThread((current) => current ? applyConversationToThread(current, byId.get(current.threadId)) : current)
    }
    apiJson<Conversation[]>('/api/conversations').then(handleConversations).catch(() => undefined)
    socket.on('conversations', handleConversations)
    return () => {
      socket.off('conversations', handleConversations)
    }
  }, [activeThread, socket])

  useEffect(() => {
    if (!socket) return
    const handleMessage = (message: ChatMessage) => {
      if (activeThread && message.threadId === activeThread.threadId) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === message.id)) return prev
          return [...prev, message]
        })
        if (!message.isSelf) {
          setUnreadMap((prev) => ({ ...prev, [activeThread.threadId]: 0 }))
          apiJson('/api/events/seen', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ threadId: activeThread.threadId, type: activeThread.type }),
          }).catch(() => undefined)
        }
      }
    }
    socket.on('message', handleMessage)
    return () => { socket.off('message', handleMessage) }
  }, [activeThread, socket])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  function openThread(thread: BubbleThread) {
    const unreadBeforeOpen = unreadMap[thread.threadId] ?? 0
    const windowSize = bubbleMessageWindowSize(unreadBeforeOpen)
    const shouldRefresh = thread.type === 'group' && unreadBeforeOpen > 0
    setActiveThread(thread)
    apiJson<ChatMessage[]>(`/api/messages/${thread.type}/${thread.threadId}${shouldRefresh ? '?refresh=1' : ''}`)
      .then((data) => setMessages(Array.isArray(data) ? data.slice(-windowSize) : []))
      .catch(() => setMessages([]))
    apiJson('/api/events/seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: thread.threadId, type: thread.type }),
    }).catch(() => undefined)
    setUnreadMap((prev) => ({ ...prev, [thread.threadId]: 0 }))
  }

  function removeBubble(threadId: string) {
    electron?.removeBubble(threadId)
    if (activeThread?.threadId === threadId) {
      setActiveThread(null)
      setMessages([])
    }
  }

  function closePanel() {
    electron?.closeBubblePanel()
  }

  async function sendMessage() {
    if (!activeThread || !text.trim() || sending) return
    setSending(true)
    const form = new FormData()
    form.append('threadId', activeThread.threadId)
    form.append('type', activeThread.type)
    form.append('text', text)
    try {
      const response = await apiJson<{ message?: ChatMessage }>('/api/messages', { method: 'POST', body: form })
      if (response.message) {
        // Dedupe: the socket "message" event (selfListen) can arrive before this
        // POST resolves and already add the message, so guard against a double.
        const sent = response.message
        setMessages((prev) => prev.some((m) => m.id === sent.id) ? prev : [...prev, sent])
      }
      setText('')
    } catch { /* ignore */ }
    finally {
      setSending(false)
      // Keep the cursor in the composer so the user can fire off messages back to back.
      inputRef.current?.focus()
    }
  }

  return (
    <div className="panelRoot">
      <header className="panelHeader">
        <div className="panelHeaderTitle">
          {activeThread && (
            <button className="panelBackBtn" onClick={() => { setActiveThread(null); setMessages([]) }} title="Quay lại">
              <ArrowLeft size={16} />
            </button>
          )}
          {activeThread ? (
            <>
              <span className="panelHeaderAvatar" style={!activeThread.avatar ? { background: avatarGradient(activeThread.threadId) } : undefined}>
                {activeThread.avatar ? <img src={activeThread.avatar} alt="" /> : activeThread.name.slice(0, 1).toUpperCase()}
              </span>
              <strong>{activeThread.name}</strong>
            </>
          ) : (
            <>
              <MessageCircle size={16} />
              <strong>Bong bóng chat</strong>
            </>
          )}
        </div>
        <div className="panelActions">
          <button onClick={closePanel} title="Đóng"><X size={14} /></button>
        </div>
      </header>

      {!activeThread ? (
        <div className="panelList">
          {threads.map((thread) => (
            <div key={thread.threadId} className="panelListItem">
              <button className="panelListMain" onClick={() => openThread(thread)}>
                <span className="panelListAvatar" style={!thread.avatar ? { background: avatarGradient(thread.threadId) } : undefined}>
                  {thread.avatar ? <img src={thread.avatar} alt="" /> : thread.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="panelListName">{thread.name}</span>
                {(unreadMap[thread.threadId] ?? 0) > 0 && (
                  <span className="panelListBadge">{unreadMap[thread.threadId]}</span>
                )}
              </button>
              <button className="panelListRemove" onClick={() => removeBubble(thread.threadId)} title="Xóa"><X size={12} /></button>
            </div>
          ))}
          {threads.length === 0 && (
            <div className="panelEmpty">
              <MessageCircle size={32} />
              <p>Chưa có bong bóng nào</p>
              <small>Bấm icon bong bóng trong chat để pin</small>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="panelMessages">
            {messages.length === 0 ? (
              <div className="panelLoading">Đang tải tin nhắn...</div>
            ) : messages.map((msg) => {
              const imageAttach = msg.attachments.find((a) => {
                const v = `${a.type ?? ''} ${a.href ?? ''} ${a.thumb ?? ''}`.toLowerCase()
                return v.includes('image') || /\.(png|jpe?g|gif|webp)(\?|$)/.test(v)
              })
              const imageSrc = imageAttach ? (imageAttach.thumb || imageAttach.href) : undefined
              const otherAttach = msg.attachments.filter((a) => a !== imageAttach)
              return (
                <div key={msg.id} className={msg.isSelf ? 'pMsg self' : 'pMsg'}>
                  {!msg.isSelf && msg.senderName && <small className="pSender">{msg.senderName}</small>}
                  {msg.text && <p>{msg.text}</p>}
                  {imageSrc && (
                    <img className="pMsgImage" src={attachmentSrc(imageSrc)} alt="" />
                  )}
                  {otherAttach.length > 0 && (
                    <small className="pAttach"><FileText size={11} /> {otherAttach.length} tệp đính kèm</small>
                  )}
                  {imageAttach && otherAttach.length === 0 && !msg.text && (
                    <small className="pAttach"><ImageIcon size={11} /> ảnh</small>
                  )}
                </div>
              )
            })}
            <div ref={endRef} />
          </div>
          <form className="panelComposer" onSubmit={(e) => { e.preventDefault(); sendMessage() }}>
            <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} placeholder="Nhập tin nhắn..." autoFocus />
            <button type="submit" disabled={sending || !text.trim()}><Send size={14} /></button>
          </form>
        </>
      )}
    </div>
  )
}

// Default export for backward compat (not used anymore)
export default BubbleDock
