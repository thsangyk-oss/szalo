import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { io } from 'socket.io-client'
import { Send, X, ArrowLeft, MessageCircle, Image as ImageIcon, FileText } from 'lucide-react'
import './Bubble.css'

const API_URL = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:4010' : '')
const socket = io(API_URL, { transports: ['websocket'] })

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
  const response = await fetch(`${API_URL}${url}`, init)
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

// ===== BUBBLE DOCK: small 60x60 circle =====
export function BubbleDock() {
  const [threads, setThreads] = useState<BubbleThread[]>((electron?.getBubbleThreads() ?? []).map(normalizeThread))
  const [unreadMap, setUnreadMap] = useState<Record<string, number>>({})
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

  useEffect(() => {
    const handleConversations = (items: Conversation[]) => {
      setUnreadMap(unreadByConversation(items))
      setThreads((current) => syncThreadsWithConversations(current, items))
    }
    apiJson<Conversation[]>('/api/conversations').then(handleConversations).catch(() => undefined)
    socket.on('conversations', handleConversations)
    return () => { socket.off('conversations', handleConversations) }
  }, [])

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
        className={isDragging ? 'dockCircle dragging' : 'dockCircle'}
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
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    document.body.classList.add('bubblePanelPage')
    return () => { document.body.classList.remove('bubblePanelPage') }
  }, [])

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
    const handleConversations = (items: Conversation[]) => {
      const byId = new Map(items.map((item) => [item.id, item]))
      setUnreadMap(unreadByConversation(items))
      setThreads((current) => syncThreadsWithConversations(current, items))
      setActiveThread((current) => current ? applyConversationToThread(current, byId.get(current.threadId)) : current)
    }
    apiJson<Conversation[]>('/api/conversations').then(handleConversations).catch(() => undefined)
    socket.on('conversations', handleConversations)
    return () => {
      socket.off('conversations', handleConversations)
    }
  }, [])

  useEffect(() => {
    const handleMessage = (message: ChatMessage) => {
      if (activeThread && message.threadId === activeThread.threadId) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === message.id)) return prev
          return [...prev, message]
        })
      }
    }
    socket.on('message', handleMessage)
    return () => { socket.off('message', handleMessage) }
  }, [activeThread])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  function openThread(thread: BubbleThread) {
    setActiveThread(thread)
    apiJson<ChatMessage[]>(`/api/messages/${thread.type}/${thread.threadId}`)
      .then((data) => setMessages(Array.isArray(data) ? data.slice(-50) : []))
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
        setMessages((prev) => [...prev, response.message as ChatMessage])
      }
      setText('')
    } catch { /* ignore */ }
    finally { setSending(false) }
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
                    <img className="pMsgImage" src={imageSrc?.startsWith('http') ? `${API_URL}/api/attachments/proxy?url=${encodeURIComponent(imageSrc)}` : `${API_URL}${imageSrc}`} alt="" />
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
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Nhập tin nhắn..." disabled={sending} autoFocus />
            <button type="submit" disabled={sending || !text.trim()}><Send size={14} /></button>
          </form>
        </>
      )}
    </div>
  )
}

// Default export for backward compat (not used anymore)
export default BubbleDock
