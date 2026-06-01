/**
 * VoiceRecorder — records mic audio with MediaRecorder, uploads to
 * /api/messages/voice which forwards a public URL to zca-js sendVoice.
 *
 * UX: tap mic button → recording starts immediately, waveform-ish counter
 * shows elapsed seconds, tap again to stop+send. Tap X to cancel without
 * sending.
 */
import { useEffect, useRef, useState } from 'react'
import { Mic, Square, X } from 'lucide-react'
import { apiUrl, authedInit } from './settings'

type Props = {
  threadId: string
  threadType: 'user' | 'group'
  onSent: () => void
  onCancel: () => void
}

async function apiSend(form: FormData): Promise<void> {
  const init = authedInit({ method: 'POST', body: form })
  const response = await fetch(apiUrl('/api/messages/voice'), init)
  const payload = await response.json().catch(() => null) as { error?: string } | null
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
}

export default function VoiceRecorder({ threadId, threadType, onSent, onCancel }: Props) {
  const [state, setState] = useState<'starting' | 'recording' | 'sending' | 'error'>('starting')
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState('')
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    let cancelled = false
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        const mr = new MediaRecorder(stream)
        chunksRef.current = []
        mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
        mr.start()
        mediaRecorderRef.current = mr
        setState('recording')
        const startedAt = performance.now()
        tickerRef.current = setInterval(() => setSeconds(Math.floor((performance.now() - startedAt) / 1000)), 250)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Không truy cập được mic')
        setState('error')
      })
    return () => {
      cancelled = true
      if (tickerRef.current) clearInterval(tickerRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop()
      }
    }
  }, [])

  function stopAndSend() {
    const mr = mediaRecorderRef.current
    if (!mr || mr.state !== 'recording') return
    setState('sending')
    if (tickerRef.current) clearInterval(tickerRef.current)
    mr.onstop = async () => {
      streamRef.current?.getTracks().forEach((t) => t.stop())
      const blob = new Blob(chunksRef.current, { type: chunksRef.current[0]?.type || 'audio/webm' })
      const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm'
      const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: blob.type })
      const form = new FormData()
      form.append('threadId', threadId)
      form.append('type', threadType)
      form.append('voice', file)
      try {
        await apiSend(form)
        onSent()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setState('error')
      }
    }
    mr.stop()
  }

  function cancel() {
    if (tickerRef.current) clearInterval(tickerRef.current)
    streamRef.current?.getTracks().forEach((t) => t.stop())
    if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop()
    onCancel()
  }

  function fmt(s: number) {
    const m = Math.floor(s / 60)
    const r = s % 60
    return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
  }

  return (
    <div className="voiceRecorder">
      {state === 'recording' && (
        <>
          <span className="vrPulse" />
          <span className="vrTime">{fmt(seconds)}</span>
          <button type="button" className="vrSend" onClick={stopAndSend} title="Dừng và gửi"><Square size={14} /> Gửi</button>
        </>
      )}
      {state === 'starting' && <span>Đang xin quyền mic...</span>}
      {state === 'sending' && <span>Đang gửi voice...</span>}
      {state === 'error' && (
        <>
          <Mic size={14} />
          <span style={{ color: '#fca5a5' }}>{error || 'Lỗi mic'}</span>
        </>
      )}
      <button type="button" className="vrCancel" onClick={cancel} title="Hủy"><X size={14} /></button>
    </div>
  )
}
