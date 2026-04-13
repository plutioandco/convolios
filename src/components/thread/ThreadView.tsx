import { useRef, useEffect, useState, createElement, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import _ from 'lodash'
import {
  Link as LinkIcon, Music, FileText, Film, Paperclip, MapPin,
  Phone, Video, MessageSquare, Users, CornerDownLeft, Smile,
  Pencil, X as XIcon, Play, Pause, Mic, Check, CheckCheck, Clock,
  Download,
} from 'lucide-react'
import { useAuth } from '../../lib/auth'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useInboxStore } from '../../stores/inboxStore'
import { useRealtimeConnected } from '../../App'
import { useConversations } from '../../hooks/useConversations'
import { useThread, useAddOptimisticMessage } from '../../hooks/useThread'
import { supabase } from '../../lib/supabase'
import { channelColor, formatTimestamp, shortTime, dateDivider, initials, avatarCls, cleanPreviewText } from '../../utils'
import { ChannelLogo } from '../icons/ChannelLogo'
import * as S from './threadStyles'
import type { Message } from '../../types'

const URL_SPLIT_RE = /(https?:\/\/[^\s<>]+)/g
const URL_TEST_RE = /^https?:\/\//

function RichText({ text }: { text: string }) {
  const parts = text.split(URL_SPLIT_RE)
  if (parts.length <= 1) return <>{text}</>

  return (
    <>
      {parts.map((part, i) =>
        URL_TEST_RE.test(part)
          ? createElement('a', {
              key: i,
              href: part,
              target: '_blank',
              rel: 'noopener noreferrer',
              style: S.inlineLink,
              onMouseEnter: (e: React.MouseEvent<HTMLAnchorElement>) => { e.currentTarget.style.textDecoration = 'underline' },
              onMouseLeave: (e: React.MouseEvent<HTMLAnchorElement>) => { e.currentTarget.style.textDecoration = 'none' },
            }, part)
          : part
      )}
    </>
  )
}

interface Attachment {
  id: string
  type?: string
  mimetype?: string
  mime_type?: string
  name?: string
  gif?: boolean
  sticker?: boolean
  unavailable?: boolean
  size?: number | { width: number; height: number }
  voice_note?: boolean
  duration?: number
  post?: { url?: string; author?: string; description?: string }
}

const DOC_EXTENSIONS = /\.(ics|pdf|zip|rar|7z|gz|tar|csv|xls|xlsx|doc|docx|ppt|pptx|txt|rtf|odt|ods|json|xml|yaml|yml|eml|vcf|svg|key|pages|numbers)$/i
const DOC_MIMES = /^(application\/|text\/)/

function attType(att: Attachment): string {
  if (att.gif || isGif(att)) return 'gif'
  const t = (att.type ?? '').toLowerCase()
  const mime = att.mimetype ?? att.mime_type ?? ''
  const name = att.name ?? ''
  if (t === 'media_share') return 'media_share'
  if (t === 'video' || t === 'vid' || mime.startsWith('video/')) return 'video'
  if (att.voice_note || t === 'ptt') return 'voicenote'
  if (t === 'audio' || mime.startsWith('audio/')) return 'audio'
  if (att.sticker) return 'sticker'
  if (t === 'document' || t === 'file' || mime === 'application/pdf') return 'document'
  if (DOC_EXTENSIONS.test(name)) return 'document'
  if (mime && DOC_MIMES.test(mime) && !mime.startsWith('text/html')) return 'document'
  return 'image'
}

function isGif(att: Attachment): boolean {
  const mime = att.mimetype ?? att.mime_type ?? ''
  const name = att.name ?? ''
  return mime === 'image/gif' || name.toLowerCase().endsWith('.gif')
}

function GifPlayer({ src }: { src: string }) {
  const vidRef = useRef<HTMLVideoElement>(null)
  const [frozen, setFrozen] = useState(false)

  useEffect(() => {
    const vid = vidRef.current
    if (!vid) return
    vid.play().catch(() => {})
    const timer = setTimeout(() => {
      vid.pause()
      setFrozen(true)
    }, 4000)
    return () => clearTimeout(timer)
  }, [src])

  const onEnter = () => {
    setFrozen(false)
    vidRef.current?.play().catch(() => {})
  }
  const onLeave = () => {
    vidRef.current?.pause()
    setFrozen(true)
  }

  return (
    <span
      style={{ position: 'relative', display: 'inline-block', cursor: 'pointer' }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <video ref={vidRef} src={src} loop muted playsInline style={{
        ...S.media, maxHeight: 300,
      }} />
      {frozen && <span style={{
        position: 'absolute', bottom: 10, left: 10, padding: '2px 8px',
        borderRadius: 'var(--radius-sm)', background: 'rgba(0,0,0,.7)', color: 'var(--color-white)',
        fontSize: 'var(--font-xs)', fontWeight: 600, letterSpacing: '.5px',
      }}>GIF</span>}
    </span>
  )
}

function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,.85)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out',
    }}>
      <img src={src} alt="" onClick={(e) => e.stopPropagation()} style={{
        maxWidth: '90vw', maxHeight: '90vh', borderRadius: 'var(--radius-card)',
        objectFit: 'contain', cursor: 'default',
      }} />
    </div>
  )
}

function AttachmentMedia({ messageId, att, channel }: { messageId: string; att: Attachment; channel?: string }) {
  const [lightbox, setLightbox] = useState(false)
  const kind = attType(att)

  const { data: src, isLoading, isError } = useQuery({
    queryKey: ['attachment', messageId, att.id],
    queryFn: async () => {
      const data = await invoke<string>('fetch_attachment', { messageId, attachmentId: att.id, channel: channel ?? null })
      if (!data) throw new Error('empty')
      return data
    },
    enabled: !!att.id && !!messageId && !att.unavailable && kind !== 'media_share',
    staleTime: Infinity,
    gcTime: 60 * 60_000,
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10000),
    refetchOnWindowFocus: false,
  })

  if (kind === 'media_share' && att.post?.url) {
    const author = att.post.author ?? ''
    const desc = att.post.description ?? ''
    return (
      <a
        href={att.post.url}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          ...S.cardBordered, display: 'flex', flexDirection: 'column', gap: 4,
          textDecoration: 'none',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-accent)' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-border)' }}
      >
        <span style={S.meta}>
          <LinkIcon size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
          {author ? `@${author}` : 'Shared post'}
        </span>
        {desc && <span style={S.bodyText}>
          {desc.length > 120 ? `${desc.slice(0, 120)}...` : desc}
        </span>}
        <span style={{ fontSize: 'var(--font-xs)', color: 'var(--color-accent)', wordBreak: 'break-all' }}>
          {att.post.url}
        </span>
      </a>
    )
  }

  const unavailable = !att.id || att.unavailable

  if (unavailable || isError) {
    const label = att.name ?? `${kind} attachment`
    const iconMap: Record<string, React.ReactNode> = {
      audio: <Music size={18} />, document: <FileText size={18} />,
      video: <Film size={18} />,
    }
    const icon = iconMap[kind] ?? <Paperclip size={18} />
    const canOpen = !!att.id && !!messageId && (kind === 'document' || kind === 'audio')
    const handleClick = canOpen ? () => {
      invoke('open_attachment', {
        messageId, attachmentId: att.id, channel: channel ?? null, filename: att.name ?? null,
      }).catch(() => {})
    } : undefined
    return (
      <button onClick={handleClick} disabled={!canOpen} style={{
        ...S.pillBadge, display: 'inline-flex', alignItems: 'center', gap: 8, border: 'none',
        cursor: canOpen ? 'pointer' : 'default',
      }}
      onMouseEnter={(e) => { if (canOpen) e.currentTarget.style.background = 'var(--color-surface-deep)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = '' }}>
        <span style={{ color: 'var(--color-text-muted)' }}>{icon}</span>
        <span style={{ ...S.label, fontWeight: 400, color: canOpen ? 'var(--color-link)' : 'var(--color-text-muted)' }}>{label}</span>
        {canOpen && <Download size={14} style={{ flexShrink: 0, opacity: 0.6 }} />}
      </button>
    )
  }

  if (isLoading) {
    if (kind === 'document' || kind === 'audio') {
      return (
        <div style={{ ...S.pillBadge, display: 'inline-flex', alignItems: 'center', gap: 8, opacity: 0.6 }}>
          <span style={{ color: 'var(--color-text-muted)' }}><FileText size={18} /></span>
          <span style={{ ...S.label, fontWeight: 400, color: 'var(--color-text-muted)' }}>{att.name ?? 'Loading...'}</span>
        </div>
      )
    }
    return (
      <div style={S.loadingPlaceholder}>
        loading...
      </div>
    )
  }

  if (kind === 'video') {
    return <video src={src} controls style={{ ...S.media, maxHeight: 300 }} />
  }
  if (kind === 'voicenote') {
    return <VoiceNotePlayer src={src} duration={att.duration} />
  }
  if (kind === 'audio') {
    return <audio src={src} controls style={{ marginTop: 4, display: 'block', maxWidth: 300 }} />
  }
  if (kind === 'document') {
    const openDoc = () => {
      invoke('open_attachment', {
        messageId, attachmentId: att.id, channel: channel ?? null, filename: att.name ?? null,
      }).catch(() => {})
    }
    return (
      <button onClick={openDoc} style={{
        ...S.pillBadge, display: 'inline-flex', alignItems: 'center', gap: 8,
        color: 'var(--color-link)', textDecoration: 'none', cursor: 'pointer', border: 'none',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-deep)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = '' }}>
        <FileText size={16} style={{ flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {att.name ?? 'Document'}
        </span>
        <Download size={14} style={{ flexShrink: 0, opacity: 0.6 }} />
      </button>
    )
  }
  if (kind === 'gif') {
    return <GifPlayer src={src} />
  }
  if (kind === 'sticker') {
    return <img src={src} alt="" style={{ maxWidth: 160, maxHeight: 160, marginTop: 4, display: 'block' }} />
  }
  return (
    <>
      <img
        src={src} alt=""
        onClick={() => setLightbox(true)}
        style={{ ...S.media, maxHeight: 350, cursor: 'zoom-in' }}
      />
      {lightbox && <Lightbox src={src} onClose={() => setLightbox(false)} />}
    </>
  )
}

function normalizeAttachment(raw: Record<string, unknown>, idx: number): Attachment {
  const att = { ...raw } as unknown as Attachment
  if (!att.id) {
    att.id = (_.isString(raw.content_id) ? raw.content_id : null)
      ?? (_.isString(raw.contentId) ? raw.contentId : null)
      ?? `att-${idx}`
  }
  if (!att.name) {
    att.name = (_.isString(raw.filename) ? raw.filename : null)
      ?? (_.isString(raw.file_name) ? raw.file_name : null)
      ?? undefined
  }
  if (!att.mimetype && !att.mime_type) {
    att.mimetype = (_.isString(raw.content_type) ? raw.content_type : null)
      ?? (_.isString(raw.contentType) ? raw.contentType : null)
      ?? undefined
  }
  return att
}

function parseAttachments(raw: unknown): Attachment[] {
  let items: Record<string, unknown>[] = []
  if (_.isArray(raw)) items = raw as Record<string, unknown>[]
  else if (_.isString(raw)) {
    try { const parsed = JSON.parse(raw); if (_.isArray(parsed)) items = parsed as Record<string, unknown>[] } catch { /* ignore */ }
  }
  return items.map((item, i) => normalizeAttachment(item, i))
}

const REACTION_RE = /^\{\{[^}]+\}\}\s*reacted\s+(.+)$/
const LID_RE = /\{\{[^}]+@lid\}\}/g

function cleanSenderName(raw: string): string {
  return raw.replace(LID_RE, '').trim() || raw
}

function isMine(msg: Message, mySenderNames: Set<string>): boolean {
  if (msg.direction === 'outbound') return true
  if (mySenderNames.size > 0 && _.isString(msg.sender_name)) {
    return mySenderNames.has(cleanSenderName(msg.sender_name))
  }
  return false
}

function isReactionMsg(msg: Message): boolean {
  return _.isString(msg.body_text) && REACTION_RE.test(msg.body_text.trim())
}

function SystemEvent({ msg }: { msg: Message }) {
  const label = msg.body_text ?? msg.event_type ?? 'System event'
  const lower = label.toLowerCase()
  const isVideo = lower.includes('video')
  const isVoice = lower.includes('voice') || lower.includes('call')
  const icon = isVideo ? <Video size={16} /> : isVoice ? <Phone size={16} /> : <MessageSquare size={16} />
  return (
    <div style={{
      textAlign: 'center', padding: '6px 16px', fontSize: 'var(--font-md)', color: 'var(--color-text-muted)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    }}>
      <span>{icon}</span>
      <span style={{ fontStyle: 'italic' }}>{label}</span>
      <span style={{ fontSize: 'var(--font-xs)' }}>{shortTime(msg.sent_at)}</span>
    </div>
  )
}

const SYSTEM_EVENT_PATTERNS = [
  /^incoming (video|voice) call$/i,
  /^(video|voice) call ended$/i,
  /^missed (video|voice) call$/i,
  /^group call$/i,
  /^.+\s(added|removed|left|joined|created|changed)\s/i,
  /^you were added$/i,
  /^messages? (and calls are|in this chat are) end-to-end encrypted/i,
  /^this message was deleted$/i,
  /^waiting for this message/i,
]

function isSystemEvent(msg: Message): boolean {
  if (msg.is_event) return true
  if (!_.isString(msg.body_text)) return false
  const t = msg.body_text.trim()
  return SYSTEM_EVENT_PATTERNS.some((re) => re.test(t))
}

const COORDS_RE = /coordinates:\s*(-?\d+\.?\d*),\s*(-?\d+\.?\d*)/i

interface ParsedLocation {
  lat: number
  lng: number
  label: string
}

function parseLocation(text: string): ParsedLocation | null {
  const match = COORDS_RE.exec(text)
  if (!match) return null
  const lat = parseFloat(match[1])
  const lng = parseFloat(match[2])
  if (!isFinite(lat) || !isFinite(lng)) return null
  const label = text
    .replace(/coordinates:\s*-?\d+\.?\d*,\s*-?\d+\.?\d*/gi, '')
    .replace(/[✓✔]/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return { lat, lng, label: label || 'Shared location' }
}

function LocationCard({ loc }: { loc: ParsedLocation }) {
  const [expanded, setExpanded] = useState(false)
  const gmapsUrl = `https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lng}`
  const embedUrl = `https://maps.google.com/maps?q=${loc.lat},${loc.lng}&z=15&output=embed`

  return (
    <div style={{ ...S.card, padding: 0, overflow: 'hidden' }}>
      {expanded ? (
        <iframe
          src={embedUrl}
          width="320"
          height="200"
          style={{ border: 0, display: 'block', borderRadius: 'var(--radius-card) var(--radius-card) 0 0' }}
          allowFullScreen
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
        />
      ) : (
        <button
          onClick={() => setExpanded(true)}
          style={{
            width: '100%', height: 120, border: 'none', cursor: 'pointer',
            background: 'var(--color-surface-deep)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: 4,
          }}
        >
          <span><MapPin size={32} /></span>
          <span style={S.meta}>Tap to load map</span>
        </button>
      )}
      <div style={{ padding: 'var(--card-padding)' }}>
        <div style={{ ...S.label, fontSize: 'var(--font-md)' }}>{loc.label}</div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
          <span style={{ fontSize: 'var(--font-xs)', color: 'var(--color-text-muted)' }}>
            {loc.lat.toFixed(6)}, {loc.lng.toFixed(6)}
          </span>
          <a
            href={gmapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={S.linkText}
          >
            Open in Maps
          </a>
        </div>
      </div>
    </div>
  )
}

const VCARD_RE = /BEGIN:VCARD[\s\S]*?END:VCARD/i

function parseVCard(text: string): { name: string; phone: string | null; email: string | null } | null {
  if (!VCARD_RE.test(text)) return null
  const fnMatch = /FN[;:](.+)/i.exec(text)
  const telMatch = /TEL[;:].*?:?(\+?\d[\d\s-]+)/i.exec(text)
  const emailMatch = /EMAIL[;:].*?:?([^\r\n]+)/i.exec(text)
  const name = fnMatch?.[1]?.trim() ?? 'Contact'
  const phone = telMatch?.[1]?.trim() ?? null
  const email = emailMatch?.[1]?.trim() ?? null
  return { name, phone, email }
}

function ContactCard({ name, phone, email }: { name: string; phone: string | null; email: string | null }) {
  return (
    <div style={{ ...S.card, display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{
        width: 40, height: 40, borderRadius: '50%', background: 'var(--color-accent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 18, fontWeight: 600, color: 'var(--color-white)', flexShrink: 0,
      }}>
        {initials(name)}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={S.label}>{name}</div>
        {_.isString(phone) && (
          <div style={{ fontSize: 'var(--font-sm)', color: 'var(--color-link)', marginTop: 2 }}>
            <a href={`tel:${phone}`} style={{ color: 'inherit', textDecoration: 'none' }}>{phone}</a>
          </div>
        )}
        {_.isString(email) && (
          <div style={{ fontSize: 'var(--font-sm)', color: 'var(--color-text-muted)', marginTop: 1 }}>{email}</div>
        )}
      </div>
    </div>
  )
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`
}

function VoiceNotePlayer({ src, duration }: { src: string; duration?: number }) {
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const audioRef = useRef<HTMLAudioElement>(null)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onTime = () => {
      setCurrentTime(audio.currentTime)
      if (audio.duration && isFinite(audio.duration)) {
        setProgress(audio.currentTime / audio.duration)
      }
    }
    const onEnd = () => { setPlaying(false); setProgress(0); setCurrentTime(0) }
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('ended', onEnd)
    return () => { audio.removeEventListener('timeupdate', onTime); audio.removeEventListener('ended', onEnd) }
  }, [src])

  const toggle = () => {
    const audio = audioRef.current
    if (!audio) return
    if (playing) { audio.pause() } else { audio.play().catch(() => {}) }
    setPlaying(!playing)
  }

  const dur = duration ?? (audioRef.current?.duration && isFinite(audioRef.current.duration) ? audioRef.current.duration : 0)

  return (
    <div style={{
      ...S.card, display: 'flex', alignItems: 'center', gap: 8,
      borderRadius: 'var(--radius-pill)', maxWidth: 280,
    }}>
      <audio ref={audioRef} src={src} preload="metadata" />
      <button
        onClick={toggle}
        style={S.accentButton}
      >
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={S.progressTrack}>
          <div style={{
            ...S.progressFill,
            width: `${progress * 100}%`, transition: 'width 0.1s linear',
          }} />
        </div>
        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--color-text-muted)', marginTop: 3 }}>
          {playing || currentTime > 0 ? formatDuration(currentTime) : dur > 0 ? formatDuration(dur) : ''}
        </div>
      </div>
    </div>
  )
}

function cleanBodyText(text: string): string {
  return deduplicateLines(
    text
      .replace(/coordinates:\s*-?\d+\.?\d*,\s*-?\d+\.?\d*/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

function deduplicateLines(text: string): string {
  const lines = text.split('\n')
  const seen = new Set<string>()
  const result: string[] = []
  for (const line of lines) {
    const key = line.trim().toLowerCase()
    if (!key) { result.push(line); continue }
    if (seen.has(key)) continue
    seen.add(key)
    result.push(line)
  }
  return result.join('\n')
}

function stripHtml(html: string): string {
  const cleaned = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<!--\[if[^\]]*\]>[\s\S]*?<!\[endif\]-->/gi, '')
    .replace(/<[^>]+style\s*=\s*["'][^"']*display\s*:\s*none[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi, '')

  const doc = new DOMParser().parseFromString(cleaned, 'text/html')
  return (doc.body.textContent ?? '')
    .replace(/[\u00AD\u200B\u200C\u200D\u200E\u200F\uFEFF\u2060\u034F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeEntities(text: string): string {
  return cleanPreviewText(text)
}

const TRACKING_URL_RE = /https?:\/\/[^\s)>\]]{80,}/g
const UNSUBSCRIBE_RE = /^\s*(unsubscribe|manage preferences|view in browser|update your preferences|opt[- ]?out|email preferences|click here to).*$/gim
const FOOTER_DIVIDER_RE = /^[-_=]{3,}\s*$/gm

function cleanEmailText(raw: string): string {
  return raw
    .replace(TRACKING_URL_RE, '')
    .replace(UNSUBSCRIBE_RE, '')
    .replace(FOOTER_DIVIDER_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractEmailPreview(msg: Message): string {
  if (_.isString(msg.body_html) && msg.body_html.length > 0) {
    return stripHtml(msg.body_html).slice(0, 400)
  }
  if (_.isString(msg.body_text) && msg.body_text.trim() !== '') {
    return cleanEmailText(decodeEntities(msg.body_text)).slice(0, 400)
  }
  return ''
}

const LIGHT_BG_RE = /background(-color)?\s*:\s*(#[c-fC-F][0-9a-fA-F]{5}|#[c-fC-F][0-9a-fA-F]{2}|#fff[0-9a-fA-F]{0,3}|white|rgb\(\s*1[7-9]\d\s*,\s*1[7-9]\d\s*,\s*1[7-9]\d\s*\)|rgb\(\s*2[0-5]\d\s*,\s*2[0-5]\d\s*,\s*2[0-5]\d\s*\))/gi
const DARK_TEXT_RE = /(?<![a-z-])color\s*:\s*(#[0-6][0-9a-fA-F]{5}|#[0-6][0-9a-fA-F]{2}|black|#000[0-9a-fA-F]{0,3}|rgb\(\s*[0-9]\d?\s*,\s*[0-9]\d?\s*,\s*[0-9]\d?\s*\))/gi

function sanitizeEmailHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')

  doc.querySelectorAll(
    'script, style, meta[http-equiv], base, object, embed, applet, form, link[rel="stylesheet"]'
  ).forEach((el) => el.remove())

  const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_COMMENT)
  const comments: Comment[] = []
  while (walker.nextNode()) comments.push(walker.currentNode as Comment)
  comments.forEach((c) => {
    const txt = c.textContent ?? ''
    if (/\[if\s/i.test(txt) || /\[endif\]/i.test(txt)) c.remove()
  })

  doc.querySelectorAll('[style]').forEach((el) => {
    const s = el.getAttribute('style') ?? ''
    if (/display\s*:\s*none/i.test(s) || /visibility\s*:\s*hidden/i.test(s) || /mso-hide\s*:\s*all/i.test(s)) {
      el.remove()
    }
  })

  doc.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') ?? ''
    const w = parseInt(img.getAttribute('width') ?? '0', 10)
    const h = parseInt(img.getAttribute('height') ?? '0', 10)
    if ((w > 0 && w <= 2) || (h > 0 && h <= 2) || src.includes('track') || src.includes('/open') || src.includes('beacon') || src.includes('pixel') || src.includes('spacer')) {
      img.remove()
    }
  })

  doc.querySelectorAll('*').forEach((el) => {
    const remove: string[] = []
    for (const attr of el.attributes) {
      if (attr.name.startsWith('on')) { remove.push(attr.name); continue }
      if ((attr.name === 'href' || attr.name === 'src' || attr.name === 'action') &&
          attr.value.trim().toLowerCase().startsWith('javascript:')) {
        remove.push(attr.name)
      }
    }
    remove.forEach((n) => el.removeAttribute(n))

    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank')
      el.setAttribute('rel', 'noopener noreferrer')
    }

    el.removeAttribute('bgcolor')
    el.removeAttribute('background')

    const style = el.getAttribute('style')
    if (_.isString(style)) {
      const patched = style
        .replace(LIGHT_BG_RE, 'background-color: transparent')
        .replace(DARK_TEXT_RE, 'color: inherit')
      if (patched !== style) el.setAttribute('style', patched)
    }
  })

  return doc.body.innerHTML
}

const EMAIL_SHADOW_STYLES = `
  :host { display: block; overflow: hidden; }
  .email-root {
    color: var(--color-text-body) !important;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: var(--font-base); line-height: 1.6;
    word-break: break-word; overflow-wrap: anywhere;
    background: transparent !important;
    color-scheme: dark;
  }
  .email-root * {
    box-sizing: border-box !important;
    max-width: 100% !important;
    background-color: transparent !important;
    background-image: none !important;
    color: inherit !important;
  }
  .email-root a { color: var(--color-link) !important; }
  .email-root img { max-width: 100% !important; height: auto !important; border-radius: var(--radius-sm); }
  .email-root table { border-collapse: collapse; table-layout: fixed; }
  .email-root td, .email-root th { overflow-wrap: anywhere; }
  .email-root blockquote {
    border-left: 3px solid var(--color-border);
    margin: 8px 0; padding: 4px 12px;
    color: var(--color-text-muted) !important;
  }
  .email-root h1, .email-root h2, .email-root h3, .email-root h4, .email-root h5, .email-root h6 {
    color: var(--color-text-primary) !important;
  }
  .email-root hr { border: none; border-top: 1px solid var(--color-border); margin: 16px 0; }
  .email-root pre, .email-root code {
    background: var(--color-surface-deep) !important;
    border-radius: var(--radius-sm); padding: 2px 6px;
    font-size: var(--font-md); color: var(--color-text-body) !important;
  }
  .email-root pre { padding: 12px; overflow-x: auto; }
  .email-root p { margin: 4px 0; }
  .email-root [style*="border"][style*="solid"] {
    border-color: var(--color-border) !important;
  }
  .email-root button, .email-root [role="button"], .email-root a[style*="background"] {
    background: var(--color-surface) !important;
    color: var(--color-link) !important;
    border: 1px solid var(--color-border) !important;
    border-radius: var(--radius-sm);
  }
`

function EmailRenderer({ html }: { html: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const shadowRef = useRef<ShadowRoot | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    if (!shadowRef.current) {
      shadowRef.current = host.attachShadow({ mode: 'open' })
    }
    const shadow = shadowRef.current
    const sanitized = sanitizeEmailHtml(html)
    shadow.innerHTML = `<style>${EMAIL_SHADOW_STYLES}</style><div class="email-root">${sanitized}</div>`
  }, [html])

  return <div ref={hostRef} style={{ marginTop: 8, borderRadius: 'var(--radius-sm)' }} />
}

function EmailBody({ msg }: { msg: Message }) {
  const [expanded, setExpanded] = useState(false)
  const hasHtml = _.isString(msg.body_html) && msg.body_html.length > 0
  const preview = extractEmailPreview(msg)
  const isLong = preview.length >= 395

  return (
    <div>
      {_.isString(msg.subject) && msg.subject.trim() !== '' && (
        <div style={{ fontWeight: 600, fontSize: 'var(--font-lg)', color: 'var(--color-text-primary)', marginBottom: 4 }}>
          {msg.subject}
        </div>
      )}

      {expanded && hasHtml
        ? <EmailRenderer html={msg.body_html!} />
        : preview && (
            <span style={{ color: 'var(--color-text-secondary)', whiteSpace: 'pre-wrap' }}>
              {isLong && !expanded ? preview.slice(0, 300) + '...' : preview}
            </span>
          )}

      {(hasHtml || isLong) && (
        <button
          onClick={() => setExpanded((v) => !v)}
          style={S.textButton}
        >
          {expanded ? 'Collapse' : hasHtml ? 'View full email' : 'Show more'}
        </button>
      )}
    </div>
  )
}

function MessageBody({ msg }: { msg: Message }) {
  const text = msg.body_text
  const isUndisplayable = _.isString(text) && (
    text.startsWith('-- Unipile cannot display') ||
    text.toLowerCase().startsWith("unipile can't render")
  )
  const isEmpty = !_.isString(text) || text.trim() === ''
  const attachments = parseAttachments(msg.attachments)
  const hasAttachments = attachments.length > 0
  const isEmail = msg.channel === 'email'

  if (msg.deleted) {
    return (
      <em style={S.mutedItalic}>This message was deleted</em>
    )
  }

  if (isEmail) {
    return (
      <>
        <EmailBody msg={msg} />
        {hasAttachments && attachments.map((att) => (
          <AttachmentMedia key={att.id} messageId={msg.external_id ?? msg.id} att={att} channel={msg.channel} />
        ))}
      </>
    )
  }

  const location = _.isString(text) ? parseLocation(text) : null
  const vcard = _.isString(text) ? parseVCard(text) : null

  const displayText = _.isString(text) && !isUndisplayable && !isEmpty
    ? (location ? cleanBodyText(text) : text)
    : null

  return (
    <>
      {msg.quoted_text && (
        <div style={S.quotedBlock}>
          {_.isString(msg.quoted_sender) && (
            <div style={{ fontSize: 'var(--font-sm)', fontWeight: 600, color: 'var(--color-accent)', marginBottom: 2 }}>
              {msg.quoted_sender}
            </div>
          )}
          <div style={{ fontSize: 'var(--font-md)', color: 'var(--color-text-muted)', lineHeight: '18px' }}>
            {msg.quoted_text.length > 200 ? msg.quoted_text.slice(0, 200) + '...' : msg.quoted_text}
          </div>
        </div>
      )}
      {vcard && <ContactCard name={vcard.name} phone={vcard.phone} email={vcard.email} />}
      {!vcard && _.isString(displayText) && displayText.trim() !== '' && (
        <>
          <RichText text={displayText} />
          {msg.edited && (
            <span style={{ fontSize: 'var(--font-xs)', color: 'var(--color-text-muted)', marginLeft: 4 }}>(edited)</span>
          )}
        </>
      )}
      {location && <LocationCard loc={location} />}
      {hasAttachments && attachments.map((att) => (
        <AttachmentMedia key={att.id} messageId={msg.external_id ?? msg.id} att={att} channel={msg.channel} />
      ))}
      {(isEmpty && !hasAttachments && !location && !vcard) || (isUndisplayable && !hasAttachments)
        ? <em style={S.mutedItalic}>unsupported message type</em>
        : null}
    </>
  )
}

function Reactions({ reactions }: { reactions: { value?: string; emoji?: string; sender_id?: string; is_sender?: boolean }[] }) {
  if (!_.isArray(reactions) || reactions.length === 0) return null

  const grouped = _.groupBy(reactions, (r) => r.value ?? r.emoji ?? '')

  const entries = Object.entries(grouped).filter(([k]) => k !== '')
  if (entries.length === 0) return null

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
      {entries.map(([emoji, reactors]) => (
        <span key={emoji} title={reactors.map((r) => r.sender_id ?? (r.is_sender ? 'You' : 'Someone')).join(', ')} style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '1px 6px', borderRadius: 'var(--radius-card)', fontSize: 'var(--font-base)', lineHeight: '20px',
          background: reactors.some((r) => r.is_sender) ? 'color-mix(in srgb, var(--color-accent) 15%, transparent)' : 'var(--color-surface)',
          border: reactors.some((r) => r.is_sender) ? '1px solid color-mix(in srgb, var(--color-accent) 40%, transparent)' : '1px solid var(--color-border)',
          cursor: 'default',
        }}>
          {emoji}
          {reactors.length > 1 && <span style={{ fontSize: 'var(--font-sm)', color: 'var(--color-text-body)' }}>{reactors.length}</span>}
        </span>
      ))}
    </div>
  )
}

const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏']

function MessageActions({ msg, onReply, onEdit }: {
  msg: Message
  onReply: (msg: Message) => void
  onEdit?: (msg: Message) => void
}) {
  const [showPicker, setShowPicker] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showPicker) return
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowPicker(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [showPicker])

  const handleReaction = async (emoji: string) => {
    setShowPicker(false)
    const extId = msg.external_id
    if (!extId) return
    try {
      await invoke('add_reaction', { messageId: extId, reaction: emoji })
    } catch (e) {
      if (import.meta.env.DEV) console.error('Reaction failed:', e)
    }
  }

  return (
    <div className="msg-actions" style={{
      position: 'absolute', top: -16, right: 16,
      display: 'flex', gap: 2, background: 'var(--color-surface)',
      borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)',
      padding: 2, zIndex: 10,
    }}>
      <button onClick={() => onReply(msg)} title="Reply" style={actionBtnStyle}><CornerDownLeft size={16} /></button>
      <button onClick={() => setShowPicker((v) => !v)} title="React" style={actionBtnStyle}>
        <Smile size={16} />
      </button>
      {onEdit && (
        <button onClick={() => onEdit(msg)} title="Edit" style={actionBtnStyle}><Pencil size={16} /></button>
      )}
      {showPicker && (
        <div ref={pickerRef} onClick={(e) => e.stopPropagation()} style={{
          position: 'absolute', bottom: '100%', right: 0, marginBottom: 4,
          display: 'flex', gap: 2, padding: 4, borderRadius: 'var(--radius-card)',
          background: 'var(--color-surface-deep)', border: '1px solid var(--color-border)',
        }}>
          {QUICK_EMOJIS.map((e) => (
            <button key={e} onClick={() => handleReaction(e)} style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 20, padding: '2px 4px', borderRadius: 'var(--radius-sm)',
            }}
            onMouseEnter={(ev) => { ev.currentTarget.style.background = 'var(--color-border)' }}
            onMouseLeave={(ev) => { ev.currentTarget.style.background = '' }}>
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const actionBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer',
  padding: '2px 6px', fontSize: 16, borderRadius: 'var(--radius-sm)',
  color: 'var(--color-text-secondary)', lineHeight: 1,
}

export function ThreadView() {
  const pid = useInboxStore((s) => s.selectedPersonId)
  const markRead = useInboxStore((s) => s.markConversationRead)
  const { user } = useAuth()
  const rtConnected = useRealtimeConnected()
  const { data: convos = [] } = useConversations(user?.id, rtConnected)
  const { data: thread = [] } = useThread(pid, user?.id, rtConnected)
  const [memberAvatars, setMemberAvatars] = useState<Record<string, string>>({})
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  const [editingMsg, setEditingMsg] = useState<Message | null>(null)
  const qc = useQueryClient()

  const convo = convos.find((c) => c.person.id === pid)
  const person = convo?.person
  const isGroup = thread.some((m) => m.message_type === 'group')
  const chatId = _.last(thread)?.thread_id
    ?? convo?.lastMessage?.thread_id

  const mySenderNames = isGroup
    ? new Set([
        ...thread
          .filter((m) => m.direction === 'outbound' && _.isString(m.sender_name))
          .map((m) => cleanSenderName(m.sender_name!)),
        ...(_.isString(user?.email) ? [user.email.split('@')[0]] : []),
      ])
    : new Set<string>()

  useEffect(() => {
    if (!pid || !user?.id) return
    markRead(user.id, pid)
  }, [pid, markRead, user?.id])

  useEffect(() => {
    if (!pid || !user?.id || !chatId) return
    const last = _.last(thread)
    const args = {
      chatId,
      userId: user.id,
      personId: pid,
      channel: last?.channel ?? convo?.lastMessage?.channel ?? '',
      messageType: last?.message_type ?? convo?.lastMessage?.message_type ?? 'dm',
      identityId: last?.identity_id ?? null,
      unipileAccountId: last?.unipile_account_id ?? convo?.lastMessage?.unipile_account_id ?? null,
    }
    if (!args.channel) return

    const doSync = () => {
      invoke<string>('sync_chat', args)
        .then((n) => {
          const count = parseInt(n as string, 10)
          if (count > 0) {
            qc.invalidateQueries({ queryKey: ['thread', pid] })
            qc.invalidateQueries({ queryKey: ['conversations', user!.id] })
          }
        })
        .catch(() => {})
    }

    doSync()
    const interval = setInterval(doSync, 30_000)
    return () => clearInterval(interval)
  }, [pid, user?.id, chatId])

  useEffect(() => {
    if (!isGroup) { setMemberAvatars({}); return }
    const senderNames = _.uniq(
      thread.filter((m) => m.direction === 'inbound' && _.isString(m.sender_name))
        .map((m) => m.sender_name!)
    )
    if (senderNames.length === 0) return

    let cancelled = false

    supabase
      .from('persons')
      .select('display_name, avatar_url')
      .in('display_name', senderNames)
      .not('avatar_url', 'is', null)
      .then(({ data }) => {
        if (cancelled || !data) return
        const map: Record<string, string> = {}
        for (const p of data) {
          if (_.isString(p.avatar_url) && p.avatar_url.length > 10) {
            map[p.display_name] = p.avatar_url
          }
        }
        if (chatId && isGroup) {
          invoke<Record<string, string>>('fetch_chat_avatars', { chatId })
            .then((apiMap) => {
              if (!cancelled) setMemberAvatars({ ...apiMap, ...map })
            })
            .catch(() => { if (!cancelled) setMemberAvatars(map) })
        } else {
          if (!cancelled) setMemberAvatars(map)
        }
      })

    return () => { cancelled = true }
  }, [chatId, isGroup, thread.length])

  const handleReply = useCallback((msg: Message) => {
    setReplyTo(msg)
    setEditingMsg(null)
  }, [])

  const handleEdit = useCallback((msg: Message) => {
    setEditingMsg(msg)
    setReplyTo(null)
  }, [])

  const handleEditSubmit = useCallback(async (msgId: string, newText: string) => {
    const msg = thread.find((m) => m.external_id === msgId || m.id === msgId)
    const extId = msg?.external_id
    if (!extId) return
    try {
      await invoke('edit_message', { messageId: extId, text: newText })
      qc.invalidateQueries({ queryKey: ['thread', pid] })
    } catch (e) {
      if (import.meta.env.DEV) console.error('Edit failed:', e)
    }
    setEditingMsg(null)
  }, [thread, pid, qc])

  const handleEditCancel = useCallback(() => setEditingMsg(null), [])

  useEffect(() => {
    setReplyTo(null)
    setEditingMsg(null)
  }, [pid])

  const scrollContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollContainerRef.current
    if (el) el.scrollTop = 0
  }, [pid])

  if (!pid) return <EmptyState />

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, background: 'var(--color-bg)' }}>
      <div ref={scrollContainerRef} className="chat-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column-reverse' }}>
        <div>
          {person && (
            <div style={{ padding: '16px 16px 0' }}>
              <div style={{ padding: '16px 0 12px' }}>
                {isGroup
                  ? <div className={avatarCls(person.id)}
                      style={{
                        width: 80, height: 80, borderRadius: 'var(--radius-lg)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: 'var(--color-white)',
                      }}>
                      <Users size={36} />
                    </div>
                  : person.avatar_url
                    ? <img src={person.avatar_url} alt="" style={{
                        width: 80, height: 80, borderRadius: '50%', objectFit: 'cover',
                      }} />
                    : <div className={avatarCls(person.id)}
                        style={{
                          width: 80, height: 80, borderRadius: '50%',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 32, fontWeight: 700, color: 'var(--color-white)',
                        }}>
                        {initials(person.display_name)}
                      </div>}
                <h3 style={{ fontSize: 24, fontWeight: 700, color: 'var(--color-text-primary)', marginTop: 8 }}>{person.display_name}</h3>
                <p style={{ fontSize: 'var(--font-base)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
                  {isGroup
                    ? <>This is the beginning of <strong>{person.display_name}</strong>.</>
                    : <>This is the beginning of your conversation with <strong>{person.display_name}</strong>.</>}
                </p>
              </div>
            </div>
          )}

          {thread.length === 0 && !person && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
              <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-body)' }}>No messages yet</p>
            </div>
          )}

          <div style={{ paddingBottom: 16 }}>
            {thread.filter((m) => !m.hidden).map((msg, i, visible) => {
              const prev = visible[i - 1]
              const curDay = new Date(msg.sent_at).toDateString()
              const prevDay = prev ? new Date(prev.sent_at).toDateString() : null
              const showDivider = prevDay !== null && curDay !== prevDay

              if (isSystemEvent(msg)) {
                if (prev && isSystemEvent(prev) && !showDivider &&
                    (msg.body_text ?? '').toLowerCase() === (prev.body_text ?? '').toLowerCase()) {
                  return null
                }
                return (
                  <div key={msg.id}>
                    {showDivider && <DayDivider iso={msg.sent_at} />}
                    <SystemEvent msg={msg} />
                  </div>
                )
              }

              if (isReactionMsg(msg)) return null

              const isMe = isMine(msg, mySenderNames)
              const prevIsMe = prev ? isMine(prev, mySenderNames) : false
              const msgIsGroup = msg.message_type === 'group'
              const prevIsGroup = prev?.message_type === 'group'
              const sameGroup = !showDivider && prev && !isSystemEvent(prev) &&
                isMe === prevIsMe &&
                msgIsGroup === prevIsGroup &&
                (msgIsGroup
                  ? (_.isString(prev.sender_name) && prev.sender_name === msg.sender_name)
                  : prev.person_id === msg.person_id) &&
                (new Date(msg.sent_at).getTime() - new Date(prev.sent_at).getTime() <= 420_000)

              return (
                <div key={msg.id}>
                  {showDivider && <DayDivider iso={msg.sent_at} />}
                  {editingMsg?.id === msg.id
                      ? <EditInline msg={msg} onSubmit={handleEditSubmit} onCancel={handleEditCancel} />
                      : sameGroup
                        ? <MsgCompact msg={msg} onReply={handleReply} onEdit={isMe && msg.channel === 'whatsapp' ? handleEdit : undefined} />
                        : <MsgFull msg={msg} person={person} memberAvatars={memberAvatars} isMe={isMe} onReply={handleReply} onEdit={isMe && msg.channel === 'whatsapp' ? handleEdit : undefined} />}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <ComposeBox personId={pid} thread={thread} chatId={chatId} convoLastMessage={convo?.lastMessage} personName={person?.display_name} replyTo={replyTo} onClearReply={() => setReplyTo(null)} />
    </div>
  )
}

function EmptyState() {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-bg)', userSelect: 'none' }}>
      <div style={{ textAlign: 'center' }}>
        <div className="av-1"
          style={{
            width: 80, height: 80, borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 32, fontWeight: 700, color: 'var(--color-white)', margin: '0 auto 16px',
          }}>
          C
        </div>
        <h2 style={{ fontSize: 24, fontWeight: 700, color: 'var(--color-text-primary)' }}>Welcome back!</h2>
        <p style={{ fontSize: 'var(--font-body)', marginTop: 4, color: 'var(--color-text-secondary)' }}>Select a conversation to start</p>
      </div>
    </div>
  )
}

function DayDivider({ iso }: { iso: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', margin: '24px 16px 8px', position: 'relative' }}>
      <div style={{ flex: 1, height: 1, background: 'var(--color-border)' }} />
      <span style={{
        padding: '0 8px', fontSize: 'var(--font-sm)', fontWeight: 600, lineHeight: '13px',
        color: 'var(--color-text-muted)', background: 'var(--color-bg)',
      }}>
        {dateDivider(iso)}
      </span>
      <div style={{ flex: 1, height: 1, background: 'var(--color-border)' }} />
    </div>
  )
}

function DeliveryStatus({ msg }: { msg: Message }) {
  const isOptimistic = msg.id.startsWith('opt-')
  const iconStyle: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', marginLeft: 6, verticalAlign: 'middle' }
  if (isOptimistic) {
    return <span style={{ ...iconStyle, color: 'var(--color-text-pending)' }}><Clock size={12} /></span>
  }
  if (msg.seen) {
    return <span style={{ ...iconStyle, color: 'var(--color-link)' }}><CheckCheck size={12} /></span>
  }
  if (msg.delivered) {
    return <span style={{ ...iconStyle, color: 'var(--color-text-muted)' }}><CheckCheck size={12} /></span>
  }
  return <span style={{ ...iconStyle, color: 'var(--color-text-muted)' }}><Check size={12} /></span>
}

function EditInline({ msg, onSubmit, onCancel }: { msg: Message; onSubmit: (id: string, text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(msg.body_text ?? '')
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { ref.current?.focus() }, [])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }, [text])

  return (
    <div style={{ padding: '4px 48px 4px 72px' }}>
      <div style={{
        borderRadius: 'var(--radius-card)', background: 'var(--color-surface-input)', padding: 8,
        border: '1px solid var(--color-accent)',
      }}>
        <textarea ref={ref} rows={1} value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(msg.id, text.trim()) }
            if (e.key === 'Escape') onCancel()
          }}
          style={{
            width: '100%', background: 'transparent', border: 'none', outline: 'none',
            resize: 'none', color: 'var(--color-text-body)', fontSize: 'var(--font-lg)', lineHeight: '20px',
          }} />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button onClick={onCancel} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--color-text-muted)', fontSize: 'var(--font-sm)', fontWeight: 600,
          }}>Cancel</button>
          <button onClick={() => onSubmit(msg.id, text.trim())} style={{
            background: 'var(--color-accent)', border: 'none', cursor: 'pointer',
            color: 'var(--color-white)', fontSize: 'var(--font-sm)', fontWeight: 600, padding: '4px 12px', borderRadius: 'var(--radius-sm)',
          }}>Save</button>
        </div>
      </div>
      <span style={{ fontSize: 'var(--font-xs)', color: 'var(--color-text-muted)' }}>Escape to cancel · Enter to save</span>
    </div>
  )
}

function MsgFull({ msg, person, memberAvatars, isMe, onReply, onEdit }: {
  msg: Message
  person?: { id: string; display_name: string; avatar_url?: string | null } | null
  memberAvatars?: Record<string, string>
  isMe?: boolean
  onReply: (msg: Message) => void
  onEdit?: (msg: Message) => void
}) {
  const out = isMe ?? msg.direction === 'outbound'
  const hasSender = _.isString(msg.sender_name) && msg.sender_name.trim() !== ''
  const msgIsGroup = msg.message_type === 'group'
  const rawName = out
    ? 'You'
    : msgIsGroup
      ? (hasSender ? cleanSenderName(msg.sender_name!) : 'Member')
      : (person?.display_name ?? 'Unknown')
  const name = rawName
  const nameClr = out ? 'var(--color-success)' : 'var(--color-text-primary)'
  const av = out ? 'av-6' : avatarCls(msg.sender_name ?? person?.id ?? msg.id)

  const senderPic = out
    ? null
    : msgIsGroup && _.isString(msg.sender_name)
      ? (memberAvatars?.[msg.sender_name] ?? memberAvatars?.[cleanSenderName(msg.sender_name)] ?? null)
      : person?.avatar_url ?? null

  const [hovered, setHovered] = useState(false)

  return (
    <div style={{
      position: 'relative', padding: '2px 48px 2px 72px', marginTop: 17, minHeight: 44,
    }}
    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(2,2,2,.06)'; setHovered(true) }}
    onMouseLeave={(e) => { e.currentTarget.style.background = ''; setHovered(false) }}>
      {hovered && <MessageActions msg={msg} onReply={onReply} onEdit={onEdit ? () => onEdit(msg) : undefined} />}
      {senderPic
        ? <img src={senderPic} alt="" style={{
            position: 'absolute', left: 16, top: 2, width: 40, height: 40,
            borderRadius: '50%', objectFit: 'cover', cursor: 'pointer',
          }} />
        : <div className={av} style={{
            position: 'absolute', left: 16, top: 2, width: 40, height: 40, borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 'var(--font-lg)', fontWeight: 600, color: 'var(--color-white)', cursor: 'pointer',
          }}>
            {out ? 'Y' : initials(name)}
          </div>}

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, flexWrap: 'wrap', minWidth: 0 }}>
        <span style={{ fontSize: 'var(--font-body)', fontWeight: 500, lineHeight: '22px', color: nameClr, cursor: 'pointer' }}>
          {name}
        </span>
        <ChannelLogo channel={msg.channel} size={14} color={channelColor(msg.channel)} style={{ flexShrink: 0, verticalAlign: 'middle' }} />
        <span style={{ fontSize: 'var(--font-sm)', lineHeight: '22px', color: 'var(--color-text-muted)', marginLeft: 4 }}>
          {formatTimestamp(msg.sent_at)}
        </span>
      </div>

      <div style={S.msgBody}>
        <span><MessageBody msg={msg} />{out && <DeliveryStatus msg={msg} />}</span>
      </div>

      <Reactions reactions={msg.reactions} />
    </div>
  )
}

function MsgCompact({ msg, onReply, onEdit }: { msg: Message; onReply: (msg: Message) => void; onEdit?: (msg: Message) => void }) {
  const out = msg.direction === 'outbound'
  const [hovered, setHovered] = useState(false)
  return (
    <div className="msg-compact" style={{
      position: 'relative', padding: '2px 48px 2px 72px', minHeight: 22,
    }}
    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(2,2,2,.06)'; setHovered(true) }}
    onMouseLeave={(e) => { e.currentTarget.style.background = ''; setHovered(false) }}>
      {hovered && <MessageActions msg={msg} onReply={onReply} onEdit={onEdit ? () => onEdit(msg) : undefined} />}
      <span className="msg-hover-ts" style={{
        position: 'absolute', left: 0, width: 56, textAlign: 'right', paddingRight: 4,
        fontSize: 'var(--font-xs)', lineHeight: '22px', color: 'var(--color-text-muted)', opacity: 0,
        transition: 'opacity .1s',
      }}>
        {shortTime(msg.sent_at)}
      </span>

      <div style={S.msgBody}>
        <span><MessageBody msg={msg} />{out && <DeliveryStatus msg={msg} />}</span>
      </div>

      <Reactions reactions={msg.reactions} />
    </div>
  )
}

function ComposeBox({ personId, thread, chatId, convoLastMessage, personName, replyTo, onClearReply }: {
  personId: string; thread: Message[]; chatId?: string; convoLastMessage?: Message; personName?: string
  replyTo: Message | null; onClearReply: () => void
}) {
  const [text, setText] = useState('')
  const [files, setFiles] = useState<{ name: string; data: string; mime: string; preview: string }[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [recording, setRecording] = useState(false)
  const [recordDuration, setRecordDuration] = useState(0)
  const sendErrors = useRef<Map<string, string>>(new Map())
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const { user } = useAuth()
  const qc = useQueryClient()
  const addOptimistic = useAddOptimisticMessage(personId, user?.id)

  const last = _.last(thread) ?? convoLastMessage
  const resolvedChatId = chatId ?? last?.thread_id

  const failedMessages = thread.filter((m) => m.id.startsWith('opt-') && sendErrors.current.has(m.id))

  useEffect(() => {
    return () => {
      if (recordTimerRef.current) clearInterval(recordTimerRef.current)
      const recorder = mediaRecorderRef.current
      if (recorder && recorder.state !== 'inactive') {
        recorder.stream.getTracks().forEach((t) => t.stop())
        recorder.stop()
      }
    }
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [text])

  useEffect(() => {
    ref.current?.focus()
  }, [personId])

  useEffect(() => {
    if (replyTo) ref.current?.focus()
  }, [replyTo])

  const addFiles = (fileList: FileList | null) => {
    if (!fileList) return
    Array.from(fileList).forEach((f) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = reader.result as string
        const b64 = result.split(',')[1] ?? ''
        setFiles((prev) => [...prev, {
          name: f.name,
          data: b64,
          mime: f.type || 'application/octet-stream',
          preview: f.type.startsWith('image/') ? result : '',
        }])
      }
      reader.readAsDataURL(f)
    })
  }

  const removeFile = (idx: number) => setFiles((prev) => prev.filter((_, i) => i !== idx))

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4'
        : MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
        : 'audio/webm'
      const recorder = new MediaRecorder(stream, { mimeType })
      audioChunksRef.current = []
      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data) }
      recorder.start()
      mediaRecorderRef.current = recorder
      setRecording(true)
      setRecordDuration(0)
      recordTimerRef.current = setInterval(() => setRecordDuration((d) => d + 1), 1000)
    } catch (e) {
      if (import.meta.env.DEV) console.error('Mic access denied:', e)
    }
  }

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current
    if (!recorder) return
    return new Promise<{ data: string; mime: string }>((resolve) => {
      recorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType })
        const reader = new FileReader()
        reader.onload = () => {
          const result = reader.result as string
          const b64 = result.split(',')[1] ?? ''
          resolve({ data: b64, mime: recorder.mimeType })
        }
        reader.readAsDataURL(blob)
        recorder.stream.getTracks().forEach((t) => t.stop())
      }
      recorder.stop()
      setRecording(false)
      if (recordTimerRef.current) { clearInterval(recordTimerRef.current); recordTimerRef.current = null }
    })
  }

  const cancelRecording = () => {
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.stream.getTracks().forEach((t) => t.stop())
      recorder.stop()
    }
    setRecording(false)
    setRecordDuration(0)
    if (recordTimerRef.current) { clearInterval(recordTimerRef.current); recordTimerRef.current = null }
  }

  const sendVoice = async () => {
    if (!resolvedChatId) return
    const result = await stopRecording()
    if (!result) return
    const meta = {
      userId: last?.user_id ?? '',
      personId,
      channel: last?.channel ?? 'whatsapp',
      messageType: last?.message_type ?? 'dm',
      accountId: last?.unipile_account_id ?? '',
    }
    const optId = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    addOptimistic({
      id: optId, user_id: meta.userId, person_id: personId, identity_id: null,
      external_id: null, channel: last?.channel ?? 'whatsapp', direction: 'outbound',
      message_type: meta.messageType, subject: null, body_text: 'Voice message',
      body_html: null, attachments: [{ type: 'ptt' }], thread_id: resolvedChatId,
      sender_name: null, reactions: [], sent_at: new Date().toISOString(),
      synced_at: '', triage: 'unclassified', seen: false, seen_by: null,
      delivered: false, edited: false, deleted: false, hidden: false,
      is_event: false, event_type: null, quoted_text: null, quoted_sender: null,
      provider_id: null, chat_provider_id: null, in_reply_to_message_id: null,
      smtp_message_id: null, unipile_account_id: null, folder: null, read_at: null,
    })
    try {
      await invoke('send_voice_message', {
        chatId: resolvedChatId, voiceData: result.data, voiceMime: result.mime, ...meta,
      })
      qc.invalidateQueries({ queryKey: ['thread', personId] })
    } catch (e) {
      if (import.meta.env.DEV) console.error('Voice send failed:', e)
    }
  }

  const sendText = (body: string) => {
    if (!body || !resolvedChatId) return

    const optId = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

    const optimistic: Message = {
      id: optId,
      user_id: last?.user_id ?? '',
      person_id: personId,
      identity_id: null,
      external_id: null,
      channel: last?.channel ?? 'whatsapp',
      direction: 'outbound',
      message_type: last?.message_type ?? 'dm',
      subject: null,
      body_text: body,
      body_html: null,
      attachments: [],
      thread_id: resolvedChatId,
      sender_name: null,
      reactions: [],
      sent_at: new Date().toISOString(),
      synced_at: '',
      triage: 'unclassified',
      seen: false,
      seen_by: null,
      delivered: false,
      edited: false,
      deleted: false,
      hidden: false,
      is_event: false,
      event_type: null,
      quoted_text: null,
      quoted_sender: null,
      provider_id: null,
      chat_provider_id: null,
      in_reply_to_message_id: null,
      smtp_message_id: null,
      unipile_account_id: null,
      folder: null,
      read_at: null,
    }
    addOptimistic(optimistic)

    const meta = {
      userId: last?.user_id ?? '',
      personId,
      channel: last?.channel ?? 'whatsapp',
      messageType: last?.message_type ?? 'dm',
      accountId: last?.unipile_account_id ?? '',
      quoteId: '',
    }

    ;(async () => {
      try {
        await invoke<string>('send_message', { chatId: resolvedChatId, text: body, ...meta })
        sendErrors.current.delete(optId)
        qc.invalidateQueries({ queryKey: ['thread', personId] })
      } catch (e) {
        sendErrors.current.set(optId, String(e))
        qc.setQueryData<Message[]>(
          ['thread', personId, user?.id],
          (old) => old ? [...old] : old,
        )
      }
    })()
  }

  const send = () => {
    const body = text.trim()
    if ((!body && files.length === 0) || !resolvedChatId) return

    const filesToSend = [...files]
    const optId = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

    const optimistic: Message = {
      id: optId,
      user_id: last?.user_id ?? '',
      person_id: personId,
      identity_id: null,
      external_id: null,
      channel: last?.channel ?? 'whatsapp',
      direction: 'outbound',
      message_type: last?.message_type ?? 'dm',
      subject: null,
      body_text: body || (filesToSend.length > 0 ? `Sending ${filesToSend.length} file(s)...` : null),
      body_html: null,
      attachments: [],
      thread_id: resolvedChatId,
      sender_name: null,
      reactions: [],
      sent_at: new Date().toISOString(),
      synced_at: '',
      triage: 'unclassified',
      seen: false,
      seen_by: null,
      delivered: false,
      edited: false,
      deleted: false,
      hidden: false,
      is_event: false,
      event_type: null,
      quoted_text: replyTo?.body_text ?? null,
      quoted_sender: replyTo?.sender_name ?? (replyTo?.direction === 'outbound' ? 'You' : null),
      provider_id: null,
      chat_provider_id: null,
      in_reply_to_message_id: replyTo?.external_id ?? null,
      smtp_message_id: null,
      unipile_account_id: null,
      folder: null,
      read_at: null,
    }
    addOptimistic(optimistic)
    setText('')
    setFiles([])
    onClearReply()
    ref.current?.focus()

    const meta = {
      userId: last?.user_id ?? '',
      personId,
      channel: last?.channel ?? 'whatsapp',
      messageType: last?.message_type ?? 'dm',
      accountId: last?.unipile_account_id ?? '',
      quoteId: replyTo?.external_id ?? '',
    }

    ;(async () => {
      try {
        if (filesToSend.length > 0) {
          for (const f of filesToSend) {
            await invoke<string>('send_attachment', {
              chatId: resolvedChatId,
              text: body || null,
              fileName: f.name,
              fileData: f.data,
              mimeType: f.mime,
              ...meta,
            })
          }
        } else {
          await invoke<string>('send_message', { chatId: resolvedChatId, text: body, ...meta })
        }
        sendErrors.current.delete(optId)
        qc.invalidateQueries({ queryKey: ['thread', personId] })
      } catch (e) {
        sendErrors.current.set(optId, String(e))
        qc.setQueryData<Message[]>(
          ['thread', personId, user?.id],
          (old) => old ? [...old] : old,
        )
      }
    })()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false)
    addFiles(e.dataTransfer.files)
  }

  const onPaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items
    const pastedFiles: File[] = []
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        const f = items[i].getAsFile()
        if (f) pastedFiles.push(f)
      }
    }
    if (pastedFiles.length > 0) {
      e.preventDefault()
      const dt = new DataTransfer()
      pastedFiles.forEach((f) => dt.items.add(f))
      addFiles(dt.files)
    }
  }

  if (!resolvedChatId) {
    return (
      <div style={{ padding: '0 16px 24px' }}>
        <div style={{ borderRadius: 'var(--radius-card)', padding: '11px 16px', background: 'var(--color-surface-input)', color: 'var(--color-text-muted)', fontSize: 'var(--font-body)' }}>
          No chat context
        </div>
      </div>
    )
  }

  return (
    <div style={{ padding: '0 16px 24px', marginTop: -8 }}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}>

      {failedMessages.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          {failedMessages.map((m) => (
            <div key={m.id} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px',
              borderRadius: 4, background: 'rgba(237, 66, 69, .1)', marginBottom: 2,
            }}>
              <span style={{ fontSize: 'var(--font-sm)', color: 'var(--color-danger)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                Failed to send: {cleanPreviewText(m.body_text ?? '').slice(0, 40)}
              </span>
              <button onClick={() => {
                const bodyText = m.body_text ?? ''
                sendErrors.current.delete(m.id)
                qc.setQueryData<Message[]>(
                  ['thread', personId, user?.id],
                  (old) => old?.filter((msg) => msg.id !== m.id) ?? [],
                )
                sendText(bodyText)
              }} style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--color-danger)', fontSize: 'var(--font-sm)', fontWeight: 600, flexShrink: 0,
              }}>Retry</button>
            </div>
          ))}
        </div>
      )}

      {replyTo && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
          background: 'var(--color-surface)', borderRadius: 'var(--radius-card) var(--radius-card) 0 0', borderBottom: '2px solid var(--color-accent)',
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 'var(--font-sm)', fontWeight: 600, color: 'var(--color-accent)' }}>
              Replying to {replyTo.direction === 'outbound' ? 'yourself' : (replyTo.sender_name ?? personName ?? 'message')}
            </div>
            <div style={{ fontSize: 'var(--font-md)', color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {cleanPreviewText(replyTo.body_text ?? '').slice(0, 80)}
            </div>
          </div>
          <button onClick={onClearReply} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--color-text-muted)', padding: 4, flexShrink: 0,
          }}><XIcon size={16} /></button>
        </div>
      )}

      <div style={{
        borderRadius: replyTo ? '0 0 var(--radius-card) var(--radius-card)' : 'var(--radius-card)', background: 'var(--color-surface-input)',
        border: dragOver ? '2px solid var(--color-accent)' : '2px solid transparent',
        transition: 'border-color .15s',
      }}>
        {files.length > 0 && (
          <div style={{ display: 'flex', gap: 8, padding: '8px 12px 0', flexWrap: 'wrap' }}>
            {files.map((f, i) => (
              <div key={i} style={{
                position: 'relative', borderRadius: 'var(--radius-card)', background: 'var(--color-surface)',
                overflow: 'hidden', width: 80, height: 80,
              }}>
                {f.preview
                  ? <img src={f.preview} alt="" style={{ width: 80, height: 80, objectFit: 'cover' }} />
                  : <div style={{
                      width: 80, height: 80, display: 'flex', alignItems: 'center',
                      justifyContent: 'center', fontSize: 'var(--font-xs)', color: 'var(--color-text-muted)', padding: 4,
                      textAlign: 'center', wordBreak: 'break-all',
                    }}>{f.name}</div>}
                <button onClick={() => removeFile(i)} style={{
                  position: 'absolute', top: 2, right: 2, width: 20, height: 20,
                  borderRadius: '50%', background: 'rgba(0,0,0,.7)', color: 'var(--color-white)',
                  border: 'none', cursor: 'pointer', lineHeight: '20px',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}><XIcon size={12} /></button>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
          <button onClick={() => fileRef.current?.click()} style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: '10px 4px 10px 12px',
            color: 'var(--color-text-secondary)', lineHeight: 1, flexShrink: 0,
          }} title="Attach file"><Paperclip size={20} /></button>
          <input ref={fileRef} type="file" multiple hidden
            onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />

          {recording ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '11px 10px' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-danger)', animation: 'pulse 1s infinite' }} />
              <span style={{ fontSize: 'var(--font-base)', color: 'var(--color-danger)', fontWeight: 600 }}>
                Recording {formatDuration(recordDuration)}
              </span>
              <div style={{ flex: 1 }} />
              <button onClick={cancelRecording} style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--color-text-muted)', fontSize: 'var(--font-base)', padding: '2px 8px',
              }}>Cancel</button>
              <button onClick={sendVoice} style={{
                background: 'var(--color-accent)', border: 'none', cursor: 'pointer',
                color: 'var(--color-white)', fontSize: 'var(--font-md)', fontWeight: 600, padding: '4px 12px', borderRadius: 'var(--radius-sm)',
              }}>Send</button>
            </div>
          ) : (
            <>
              <textarea
                ref={ref}
                rows={1}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                placeholder={`Message @${personName ?? 'this chat'}`}
                style={{
                  flex: 1, background: 'transparent', outline: 'none', resize: 'none',
                  padding: '11px 10px 11px 4px', fontSize: 'var(--font-body)', lineHeight: '22px',
                  color: 'var(--color-text-body)', maxHeight: 200, border: 'none',
                }}
              />
              {!text.trim() && files.length === 0 && (
                <button onClick={startRecording} title="Voice message" style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  padding: '10px 12px 10px 4px', color: 'var(--color-text-secondary)',
                  lineHeight: 1, flexShrink: 0,
                }}><Mic size={20} /></button>
              )}
            </>
          )}
        </div>
      </div>

      {dragOver && (
        <div style={{
          position: 'fixed', inset: 0, background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none', zIndex: 999,
        }}>
          <div style={{
            padding: '32px 48px', borderRadius: 'var(--radius-lg)', background: 'var(--color-accent)',
            color: 'var(--color-white)', fontSize: 20, fontWeight: 600,
          }}>
            Drop files to upload
          </div>
        </div>
      )}
    </div>
  )
}
