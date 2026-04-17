import { useRef, useEffect, useState, createElement, useCallback, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import DOMPurify from 'dompurify'
import _ from 'lodash'
import {
  Link as LinkIcon, Music, FileText, Paperclip, MapPin,
  Phone, Video, MessageSquare, Users, CornerDownLeft, Smile,
  Pencil, X as XIcon, Play, Pause, Check, CheckCheck, Clock,
  Download, ChevronDown, Link2, Upload, Flag,
} from 'lucide-react'
import { useAuth } from '../../lib/auth'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useInboxStore } from '../../stores/inboxStore'
import { usePreferencesStore } from '../../stores/preferencesStore'
import { useRealtimeConnected } from '../../lib/realtimeContext'
import { useConversations } from '../../hooks/useConversations'
import { useThread, addPendingMessage, markPendingFailed, removePending, patchPendingExternalId, useCancelThreadQueries } from '../../hooks/useThread'
import { useMergePersons } from '../../hooks/useMergeSuggestions'
import { usePersonCircleColors } from '../../hooks/useCircles'
import { supabase } from '../../lib/supabase'
import { channelColor, formatTimestamp, shortTime, dateDivider, initials, avatarCls, cleanPreviewText, cleanSenderName, REACTION_RE, circleGradient, isLightBrandColor } from '../../utils'
import { ChannelLogo } from '../icons/ChannelLogo'
import * as S from './threadStyles'
import type { Message, Channel, Identity } from '../../types'

const URL_SPLIT_RE = /(https?:\/\/[^\s<>]+)/g
const URL_TEST_RE = /^https?:\/\//
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024

function newOptimisticId(): string {
  return `opt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

// Tauri invoke rejects with a string (the Rust error) or an Error. Normalize
// so UI and logs get a readable reason.
function describeError(e: unknown): string {
  if (_.isString(e)) return e
  if (e instanceof Error) return e.message
  if (_.isObject(e)) {
    const msg = (e as { message?: unknown }).message
    if (_.isString(msg)) return msg
  }
  return 'Unknown error'
}

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
      className="relative inline-block cursor-pointer"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <video ref={vidRef} src={src} loop muted playsInline className="max-h-[300px]" style={S.media} />
      {frozen && <span className="absolute bottom-2.5 left-2.5 px-2 py-0.5 rounded-sm bg-[var(--overlay-pill-bg)] text-white text-xs font-semibold tracking-[0.5px]">GIF</span>}
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
    <div className="lightbox" onClick={onClose}>
      <img src={src} alt="" onClick={(e) => e.stopPropagation()} />
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
        className="flex flex-col gap-1 no-underline"
        style={S.cardBordered}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-accent)' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-border)' }}
      >
        <span style={S.meta}>
          <LinkIcon size={14} className="align-middle mr-1" />
          {author ? `@${author}` : 'Shared post'}
        </span>
        {desc && <span style={S.bodyText}>
          {desc.length > 120 ? `${desc.slice(0, 120)}...` : desc}
        </span>}
        <span className="text-xs text-accent break-all">
          {att.post.url}
        </span>
      </a>
    )
  }

  const unavailable = !att.id || att.unavailable

  if (unavailable || isError) {
    if (kind !== 'document' && kind !== 'audio') return null
    const label = att.name ?? `${kind} attachment`
    const icon = kind === 'audio' ? <Music size={18} /> : <FileText size={18} />
    const canOpen = !!att.id && !!messageId
    const handleClick = canOpen ? () => {
      invoke('open_attachment', {
        messageId, attachmentId: att.id, channel: channel ?? null, filename: att.name ?? null,
      }).catch(() => {})
    } : undefined
    return (
      <button onClick={handleClick} disabled={!canOpen}
        className={`border-none ${canOpen ? 'cursor-pointer' : 'cursor-default'}`}
        style={{ ...S.pillBadge, gap: 8 }}
      onMouseEnter={(e) => { if (canOpen) e.currentTarget.style.background = 'var(--color-surface-deep)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = '' }}>
        <span className="text-text-muted">{icon}</span>
        <span style={{ ...S.label, fontWeight: 400, color: canOpen ? 'var(--color-link)' : 'var(--color-text-muted)' }}>{label}</span>
        {canOpen && <Download size={14} className="shrink-0 opacity-60" />}
      </button>
    )
  }

  if (isLoading) {
    if (kind === 'document' || kind === 'audio') {
      return (
        <div className="opacity-60" style={{ ...S.pillBadge, gap: 8 }}>
          <span className="text-text-muted"><FileText size={18} /></span>
          <span style={{ ...S.label, fontWeight: 400, color: 'var(--color-text-muted)' }}>{att.name ?? 'Loading...'}</span>
        </div>
      )
    }
    return (
      <div className="skeleton w-[200px] h-[140px] rounded-card" />
    )
  }

  if (!src) return null

  if (kind === 'video') {
    return <video src={src} controls className="max-h-[300px]" style={S.media} />
  }
  if (kind === 'voicenote') {
    return <VoiceNotePlayer src={src} duration={att.duration} />
  }
  if (kind === 'audio') {
    return <audio src={src} controls className="mt-1 block max-w-[300px]" />
  }
  if (kind === 'document') {
    const openDoc = () => {
      invoke('open_attachment', {
        messageId, attachmentId: att.id, channel: channel ?? null, filename: att.name ?? null,
      }).catch(() => {})
    }
    return (
      <button onClick={openDoc}
        className="text-link no-underline cursor-pointer border-none"
        style={{ ...S.pillBadge, gap: 8 }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-deep)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = '' }}>
        <FileText size={16} className="shrink-0" />
        <span className="flex-1 min-w-0 truncate">
          {att.name ?? 'Document'}
        </span>
        <Download size={14} className="shrink-0 opacity-60" />
      </button>
    )
  }
  if (kind === 'gif') {
    return <GifPlayer src={src} />
  }
  if (kind === 'sticker') {
    return <img src={src} alt="" className="max-w-[160px] max-h-[160px] mt-1 block" />
  }
  return (
    <>
      <img
        src={src} alt=""
        onClick={() => setLightbox(true)}
        className="max-h-[350px] cursor-zoom-in" style={S.media}
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

type PendingFile = { name: string; data: string; mime: string; preview: string }

function mergePendingFiles(prev: PendingFile[], next: PendingFile[]): PendingFile[] {
  const keys = new Set(prev.map((f) => `${f.name}:${f.data.length}`))
  const out = [...prev]
  for (const f of next) {
    const k = `${f.name}:${f.data.length}`
    if (!keys.has(k)) {
      keys.add(k)
      out.push(f)
    }
  }
  return out
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
    <div className="system-event">
      <span>{icon}</span>
      <span className="italic">{label}</span>
      <span className="system-event-time">{shortTime(msg.sent_at)}</span>
    </div>
  )
}

const SYSTEM_EVENT_PATTERNS = [
  /^incoming (video|voice) call$/i,
  /^(video|voice) call ended$/i,
  /^missed (video|voice) call$/i,
  /^group call$/i,
  /^.+\s(added|removed)\s.+\s(to|from)\s(the\s)?(group|chat|conversation)/i,
  /^.+\s(left|joined)\s(the\s)?(group|chat|conversation)/i,
  /^.+\screated\s(the\s|this\s)?(group|chat|conversation)/i,
  /^.+\schanged\s(the\s)?(subject|topic|description|icon|photo|name|title)/i,
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
    <div className="overflow-hidden" style={{ ...S.card, padding: 0 }}>
      {expanded ? (
        <iframe
          src={embedUrl}
          width="320"
          height="200"
          className="border-0 block rounded-t-card"
          allowFullScreen
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
        />
      ) : (
        <button
          onClick={() => setExpanded(true)}
          className="w-full h-[120px] border-none cursor-pointer bg-surface-deep flex items-center justify-center flex-col gap-1"
        >
          <span><MapPin size={32} /></span>
          <span style={S.meta}>Tap to load map</span>
        </button>
      )}
      <div className="px-3.5 py-2.5">
        <div style={{ ...S.label, fontSize: 'var(--font-md)' }}>{loc.label}</div>
        <div className="flex items-center justify-between mt-1">
          <span className="text-xs text-text-muted">
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
    <div className="flex items-center gap-3" style={S.card}>
      <div className="w-10 h-10 rounded-full bg-accent flex items-center justify-center text-[18px] font-semibold text-white shrink-0">
        {initials(name)}
      </div>
      <div className="min-w-0">
        <div style={S.label}>{name}</div>
        {_.isString(phone) && (
          <div className="text-sm text-link mt-0.5">
            <a href={`tel:${phone}`} className="text-[inherit] no-underline">{phone}</a>
          </div>
        )}
        {_.isString(email) && (
          <div className="text-sm text-text-muted mt-px">{email}</div>
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
  const [audioDuration, setAudioDuration] = useState(0)
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
    const onMeta = () => {
      if (audio.duration && isFinite(audio.duration)) setAudioDuration(audio.duration)
    }
    const onEnd = () => { setPlaying(false); setProgress(0); setCurrentTime(0) }
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('loadedmetadata', onMeta)
    audio.addEventListener('ended', onEnd)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('loadedmetadata', onMeta)
      audio.removeEventListener('ended', onEnd)
    }
  }, [src])

  const toggle = () => {
    const audio = audioRef.current
    if (!audio) return
    if (playing) { audio.pause() } else { audio.play().catch(() => {}) }
    setPlaying(!playing)
  }

  const dur = duration ?? audioDuration

  return (
    <div className="flex items-center gap-2" style={{ ...S.card, borderRadius: 'var(--radius-pill)', maxWidth: 280 }}>
      <audio ref={audioRef} src={src} preload="metadata" />
      <button
        onClick={toggle}
        style={S.accentButton}
      >
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <div className="flex-1 min-w-0">
        <div style={S.progressTrack}>
          <div className="transition-[width] duration-100 ease-linear" style={{
            ...S.progressFill,
            width: `${progress * 100}%`,
          }} />
        </div>
        <div className="text-xs text-text-muted mt-[3px]">
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
    .replace(/\u00AD|\u200B|\u200C|\u200D|\u200E|\u200F|\uFEFF|\u2060|\u034F/gu, '')
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

DOMPurify.addHook('uponSanitizeElement', (node, data) => {
  if (data.tagName === 'img') {
    const img = node as HTMLImageElement
    const src = img.getAttribute('src') ?? ''
    const w = parseInt(img.getAttribute('width') ?? '0', 10)
    const h = parseInt(img.getAttribute('height') ?? '0', 10)
    if ((w > 0 && w <= 2) || (h > 0 && h <= 2) || /track|\/open|beacon|pixel|spacer/i.test(src)) {
      node.parentNode?.removeChild(node)
    }
  }
})

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (!(node instanceof Element)) return

  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }

  node.removeAttribute('bgcolor')
  node.removeAttribute('background')

  const style = node.getAttribute('style')
  if (_.isString(style)) {
    if (/display\s*:\s*none/i.test(style) || /visibility\s*:\s*hidden/i.test(style) || /mso-hide\s*:\s*all/i.test(style)) {
      node.parentNode?.removeChild(node)
      return
    }
    const patched = style
      .replace(LIGHT_BG_RE, 'background-color: transparent')
      .replace(DARK_TEXT_RE, 'color: inherit')
    if (patched !== style) node.setAttribute('style', patched)
  }
})

function sanitizeEmailHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['style', 'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'meta', 'base', 'link', 'svg', 'math', 'portal'],
    FORBID_ATTR: ['srcdoc', 'formaction'],
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    USE_PROFILES: { html: true },
  })
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

  return <div ref={hostRef} className="mt-2 rounded-sm" />
}

function EmailBody({ msg }: { msg: Message }) {
  const [expanded, setExpanded] = useState(false)
  const hasHtml = _.isString(msg.body_html) && msg.body_html.length > 0
  const preview = extractEmailPreview(msg)
  const isLong = preview.length >= 395

  return (
    <div>
      {_.isString(msg.subject) && msg.subject.trim() !== '' && (
        <div className="font-semibold text-lg text-text-primary mb-1">
          {msg.subject}
        </div>
      )}

      {expanded && hasHtml
        ? <EmailRenderer html={msg.body_html!} />
        : preview && (
            <span className="text-text-secondary whitespace-pre-wrap">
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
            <div className="text-sm font-semibold text-accent mb-0.5">
              {msg.quoted_sender}
            </div>
          )}
          <div className="text-md text-text-muted leading-[18px]">
            {msg.quoted_text.length > 200 ? msg.quoted_text.slice(0, 200) + '...' : msg.quoted_text}
          </div>
        </div>
      )}
      {vcard && <ContactCard name={vcard.name} phone={vcard.phone} email={vcard.email} />}
      {!vcard && _.isString(displayText) && displayText.trim() !== '' && (
        <>
          <RichText text={displayText} />
          {msg.edited && (
            <span className="text-xs text-text-muted ml-1">(edited)</span>
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
    <div className="reaction-bar">
      {entries.map(([emoji, reactors]) => (
        <span key={emoji} title={reactors.map((r) => r.sender_id ?? (r.is_sender ? 'You' : 'Someone')).join(', ')}
          className="reaction-chip"
          style={{
            background: reactors.some((r) => r.is_sender) ? 'color-mix(in srgb, var(--color-accent) 15%, transparent)' : undefined,
            border: reactors.some((r) => r.is_sender) ? '1px solid color-mix(in srgb, var(--color-accent) 40%, transparent)' : undefined,
          }}>
          {emoji}
          {reactors.length > 1 && <span className="reaction-chip-count">{reactors.length}</span>}
        </span>
      ))}
    </div>
  )
}

const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏']
const REACTION_CHANNELS: Set<Channel> = new Set(['whatsapp', 'linkedin'])

function MessageActions({ msg, onReply, onEdit, onFlag }: {
  msg: Message
  onReply: (msg: Message) => void
  onEdit?: (msg: Message) => void
  onFlag?: (msg: Message) => void
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
      console.error('[reaction] failed:', e)
    }
  }

  const canReact = REACTION_CHANNELS.has(msg.channel) && _.isString(msg.external_id)

  return (
    <div className="msg-actions msg-actions-bar -top-4 gap-0.5 p-0.5 z-10" data-picker-open={showPicker}>
      <button onClick={() => onReply(msg)} title="Reply" className="msg-action-btn"><CornerDownLeft size={16} /></button>
      {canReact && (
        <button onClick={() => setShowPicker((v) => !v)} title="React" className="msg-action-btn">
          <Smile size={16} />
        </button>
      )}
      {onEdit && (
        <button onClick={() => onEdit(msg)} title="Edit" className="msg-action-btn"><Pencil size={16} /></button>
      )}
      {onFlag && !msg._pending && (
        <button onClick={() => onFlag(msg)} title={_.isString(msg.flagged_at) ? 'Unflag' : 'Flag for action'} className="msg-action-btn">
          <Flag size={16} fill={_.isString(msg.flagged_at) ? 'currentColor' : 'none'} />
        </button>
      )}
      {canReact && showPicker && (
        <div ref={pickerRef} onClick={(e) => e.stopPropagation()}
          className="absolute bottom-full right-0 mb-1 flex gap-0.5 p-1 rounded-card bg-surface-deep border border-border">
          {QUICK_EMOJIS.map((e) => (
            <button key={e} onClick={() => handleReaction(e)}
              className="bg-transparent border-none cursor-pointer text-[20px] px-1 py-0.5 rounded-sm hover:bg-border">
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function ThreadView() {
  const pid = useInboxStore((s) => s.selectedPersonId)
  return <ThreadViewInner key={pid ?? 'empty'} />
}

function ThreadViewInner() {
  const pid = useInboxStore((s) => s.selectedPersonId)
  const focusMessageId = useInboxStore((s) => s.focusMessageId)
  const markRead = useInboxStore((s) => s.markConversationRead)
  const clearUnread = useInboxStore((s) => s.markPersonUnread)
  const flagMsg = useInboxStore((s) => s.flagMessage)
  const { user } = useAuth()
  const rtConnected = useRealtimeConnected()
  const { data: convos = [] } = useConversations(user?.id, rtConnected, 'approved')
  const { data: pendingConvos = [] } = useConversations(user?.id, rtConnected, 'pending')
  const { data: thread = [], isLoading: threadLoading, hasMore, loadMore, isLoadingMore } = useThread(pid, user?.id, rtConnected)
  const { data: circleColors } = usePersonCircleColors(user?.id)
  const [memberAvatars, setMemberAvatars] = useState<Record<string, string>>({})
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  const [editingMsg, setEditingMsg] = useState<Message | null>(null)
  const [threadChannelFilter, setThreadChannelFilter] = useState<Channel | 'all'>('all')
  const [showLinkPerson, setShowLinkPerson] = useState(false)
  const [pendingDropFiles, setPendingDropFiles] = useState<PendingFile[]>([])
  const [dragOver, setDragOver] = useState(false)
  const dragCounterRef = useRef(0)

  const qc = useQueryClient()

  useEffect(() => {
    let cancelled = false
    const setup = async () => {
      const unlisten = await getCurrentWindow().onDragDropEvent(async (event) => {
        if (cancelled) return
        if (event.payload.type === 'enter') {
          dragCounterRef.current++
          setDragOver(true)
        } else if (event.payload.type === 'leave') {
          dragCounterRef.current--
          if (dragCounterRef.current <= 0) { dragCounterRef.current = 0; setDragOver(false) }
        } else if (event.payload.type === 'drop') {
          dragCounterRef.current = 0
          setDragOver(false)
          if (event.payload.paths?.length) {
            try {
              const files = await invoke<{ name: string; data: string; mime: string; preview: string }[]>(
                'read_dropped_files', { paths: event.payload.paths }
              )
              if (!cancelled) {
                setPendingDropFiles((prev) => mergePendingFiles(prev, files))
              }
            } catch (e) {
              console.error('[drop] read failed:', e)
            }
          }
        }
      })
      return unlisten
    }
    let unlisten: (() => void) | undefined
    setup().then((u) => {
      if (cancelled) { u() }
      else { unlisten = u }
    })
    return () => { cancelled = true; unlisten?.() }
  }, [])

  const { data: personIdentities = [] } = useQuery({
    queryKey: ['person-identities', pid],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('identities')
        .select('*')
        .eq('person_id', pid!)
      if (error) throw error
      return (data ?? []) as Identity[]
    },
    enabled: _.isString(pid),
    staleTime: 60_000,
  })

  const convo = convos.find((c) => c.person.id === pid)
    ?? pendingConvos.find((c) => c.person.id === pid)
  const person = convo?.person
  const isGroup = thread.some((m) => m.message_type === 'group')
  const heroGradient = person ? circleGradient(circleColors?.get(person.id) ?? []) : undefined
  const chatId = _.last(thread)?.thread_id
    ?? convo?.lastMessage?.thread_id

  const personChannels = _.uniq(personIdentities.map((i) => i.channel))
  const threadChannels = _.uniq(thread.map((m) => m.channel))
  const availableChannels = _.uniq([...personChannels, ...threadChannels])

  const filteredThread = threadChannelFilter === 'all'
    ? thread
    : thread.filter((m) => m.channel === threadChannelFilter)

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
    if (convo?.markedUnread) {
      clearUnread(user.id, pid, false)
    }
  }, [pid, markRead, clearUnread, user?.id, convo?.markedUnread])

  const syncArgsRef = useRef<Record<string, unknown> | null>(null)
  useEffect(() => {
    const last = _.last(thread)
    syncArgsRef.current = (pid && user?.id && chatId) ? {
      chatId,
      userId: user.id,
      personId: pid,
      channel: last?.channel ?? convo?.lastMessage?.channel ?? '',
      messageType: last?.message_type ?? convo?.lastMessage?.message_type ?? 'dm',
      identityId: last?.identity_id ?? null,
      unipileAccountId: last?.unipile_account_id ?? convo?.lastMessage?.unipile_account_id ?? null,
    } : null
  }, [pid, user?.id, chatId, thread, convo])

  useEffect(() => {
    if (!pid || !user?.id || !chatId) return

    const doSync = () => {
      const args = syncArgsRef.current
      if (!args || !args.channel) return
      invoke<string>('sync_chat', args)
        .then((n) => {
          const count = parseInt(n as string, 10)
          if (count > 0) {
            qc.invalidateQueries({ queryKey: ['thread', pid] })
            qc.invalidateQueries({ queryKey: ['conversations', user!.id] })
          }
        })
        .catch(() => {
          qc.invalidateQueries({ queryKey: ['thread', pid] })
        })
    }

    doSync()
    const syncMs = rtConnected ? 20_000 : 10_000
    const interval = setInterval(doSync, syncMs)
    return () => clearInterval(interval)
  }, [pid, user, chatId, rtConnected, qc])

  const senderNamesKey = isGroup
    ? _.uniq(
        thread.filter((m) => m.direction === 'inbound' && _.isString(m.sender_name))
          .map((m) => m.sender_name!)
      ).sort().join('\u0000')
    : ''

  useEffect(() => {
    if (!isGroup || !senderNamesKey) return
    const senderNames = senderNamesKey.split('\u0000')

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
        if (chatId && isGroup && user?.id) {
          invoke<Record<string, string>>('fetch_chat_avatars', { chatId, userId: user.id })
            .then((apiMap) => {
              if (!cancelled) setMemberAvatars({ ...apiMap, ...map })
            })
            .catch(() => { if (!cancelled) setMemberAvatars(map) })
        } else {
          if (!cancelled) setMemberAvatars(map)
        }
      })

    return () => { cancelled = true }
  }, [chatId, isGroup, senderNamesKey, user?.id])

  const handleReply = (msg: Message) => {
    setReplyTo(msg)
    setEditingMsg(null)
  }

  const handleFlag = (msg: Message) => {
    if (!user?.id || !pid) return
    flagMsg(user.id, pid, msg.id, !_.isString(msg.flagged_at))
  }

  const handleEdit = (msg: Message) => {
    setEditingMsg(msg)
    setReplyTo(null)
  }

  const handleEditSubmit = async (msgId: string, newText: string) => {
    const msg = thread.find((m) => m.external_id === msgId || m.id === msgId)
    const extId = msg?.external_id
    if (!extId) return
    try {
      await invoke('edit_message', { messageId: extId, text: newText })
      qc.invalidateQueries({ queryKey: ['thread', pid] })
    } catch (e) {
      console.error('[edit] failed:', e)
    }
    setEditingMsg(null)
  }

  const handleEditCancel = () => setEditingMsg(null)

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const lastFocusedRef = useRef<string | null>(null)


  useEffect(() => {
    if (!focusMessageId || !scrollContainerRef.current) return
    if (lastFocusedRef.current === focusMessageId) return
    const el = scrollContainerRef.current.querySelector(`[data-msg-id="${focusMessageId}"]`) as HTMLElement | null
    if (!el) return
    lastFocusedRef.current = focusMessageId
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.add('msg-highlight')
    el.addEventListener('animationend', () => { el.classList.remove('msg-highlight') }, { once: true })
  }, [focusMessageId, thread])

  useEffect(() => {
    const sentinel = sentinelRef.current
    const container = scrollContainerRef.current
    if (!sentinel || !container || !hasMore) return
    const io = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) loadMore() },
      { root: container, rootMargin: '200px' },
    )
    io.observe(sentinel)
    return () => io.disconnect()
  }, [hasMore, loadMore])

  if (!pid) return <EmptyState />

  if (threadLoading && thread.length === 0) return <ThreadSkeleton />

  return (
    <div
      className="thread-col"
      onDragOver={(e) => e.preventDefault()}
      onDragEnter={(e) => { e.preventDefault(); dragCounterRef.current++; setDragOver(true) }}
      onDragLeave={() => { dragCounterRef.current--; if (dragCounterRef.current <= 0) { dragCounterRef.current = 0; setDragOver(false) } }}
      onDrop={(e) => {
        e.preventDefault()
        dragCounterRef.current = 0
        setDragOver(false)
        const dt = e.dataTransfer
        if (!dt?.files?.length) return
        Array.from(dt.files).forEach((f) => {
          const reader = new FileReader()
          reader.onload = () => {
            const result = reader.result as string
            const b64 = result.split(',')[1] ?? ''
            const item = {
              name: f.name,
              data: b64,
              mime: f.type || 'application/octet-stream',
              preview: f.type.startsWith('image/') ? result : '',
            }
            setPendingDropFiles((prev) => mergePendingFiles(prev, [item]))
          }
          reader.readAsDataURL(f)
        })
      }}
    >
      <div className="thread-scroller-wrap">
        <div ref={scrollContainerRef} className="thread-scroller chat-scroll">
        <div>
          {isLoadingMore && (
            <div className="flex justify-center py-4">
              <span className="text-sm text-text-muted">Loading older messages...</span>
            </div>
          )}
          <div ref={sentinelRef} />

          {person && !hasMore && (
            <div className="px-4 pt-4">
              <div className="pt-4 pb-3">
                {isGroup
                  ? <div
                      className={`relative w-20 h-20${heroGradient ? ' circle-ring circle-ring--hero circle-ring--square' : ''}`}
                      style={heroGradient ? { '--circle-gradient': heroGradient } as React.CSSProperties : undefined}
                    >
                      <div className={`${avatarCls(person.id)} w-20 h-20 rounded-lg flex items-center justify-center text-white`}>
                        <Users size={36} />
                      </div>
                    </div>
                  : <div
                      className={`relative w-20 h-20${heroGradient ? ' circle-ring circle-ring--hero' : ''}`}
                      style={heroGradient ? { '--circle-gradient': heroGradient } as React.CSSProperties : undefined}
                    >
                      {person.avatar_url
                        ? <img src={person.avatar_url} alt="" className="w-20 h-20 rounded-full object-cover" />
                        : <div className={`${avatarCls(person.id)} avatar avatar--hero`}>
                            {initials(person.display_name)}
                          </div>}
                    </div>}
                <h3 className="text-[24px] font-bold text-text-primary mt-2 flex items-center gap-2">
                  {person.display_name}
                  {availableChannels.length > 1 && (
                    <span className="flex gap-1">
                      {availableChannels.map((ch) => (
                        <span key={ch} className="w-5 h-5 rounded-sm flex items-center justify-center" style={{ background: channelColor(ch) }}>
                          <ChannelLogo channel={ch} size={12} color={isLightBrandColor(channelColor(ch)) ? 'var(--color-black)' : 'var(--color-white)'} />
                        </span>
                      ))}
                    </span>
                  )}
                  {!isGroup && (
                    <button
                      onClick={() => setShowLinkPerson(true)}
                      title="Link to another person"
                      className="bg-transparent border border-border rounded-sm cursor-pointer px-2 py-0.5 text-text-muted flex items-center gap-1 text-sm"
                    >
                      <Link2 size={12} /> Link
                    </button>
                  )}
                </h3>
                <p className="text-base text-text-secondary mt-1">
                  {isGroup
                    ? <>This is the beginning of <strong>{person.display_name}</strong>.</>
                    : <>This is the beginning of your conversation with <strong>{person.display_name}</strong>.</>}
                </p>
              </div>
            </div>
          )}

          {thread.length === 0 && !person && (
            <div className="flex items-center justify-center h-full">
              <p className="text-text-secondary text-body">No messages yet</p>
            </div>
          )}

          {availableChannels.length > 1 && (
            <div className="flex gap-1 px-4 pt-2 pb-1 flex-wrap">
              <ChannelFilterPill active={threadChannelFilter === 'all'} onClick={() => setThreadChannelFilter('all')}>All</ChannelFilterPill>
              {availableChannels.map((ch) => (
                <ChannelFilterPill key={ch} active={threadChannelFilter === ch} onClick={() => setThreadChannelFilter(ch as Channel)}>
                  <ChannelLogo channel={ch} size={11} color={threadChannelFilter === ch ? 'var(--color-white)' : channelColor(ch)} className="mr-1" />
                  {ch.charAt(0).toUpperCase() + ch.slice(1)}
                </ChannelFilterPill>
              ))}
            </div>
          )}

          <div className="pb-4">
            {filteredThread.filter((m) => !m.hidden).map((msg, i, visible) => {
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
              const sameSender = prev && (msgIsGroup
                ? (isMe && prevIsMe) ||
                  (_.isString(prev.sender_name) && prev.sender_name === msg.sender_name)
                : isMe === prevIsMe)
              const sameGroup = !showDivider && sameSender && !isSystemEvent(prev) && !isReactionMsg(prev) &&
                msgIsGroup === prevIsGroup &&
                (new Date(msg.sent_at).getTime() - new Date(prev.sent_at).getTime() <= 420_000)

              return (
                <div key={msg.id} data-msg-id={msg.id} style={msg._pending ? { opacity: msg._failed ? 0.5 : 0.7 } : undefined}>
                  {showDivider && <DayDivider iso={msg.sent_at} />}
                  {editingMsg?.id === msg.id
                      ? <EditInline msg={msg} onSubmit={handleEditSubmit} onCancel={handleEditCancel} />
                      : sameGroup
                        ? <MsgCompact msg={msg} onReply={handleReply} onEdit={isMe && msg.channel === 'whatsapp' ? handleEdit : undefined} onFlag={handleFlag} />
                        : <MsgFull msg={msg} person={person} memberAvatars={memberAvatars} isMe={isMe} onReply={handleReply} onEdit={isMe && msg.channel === 'whatsapp' ? handleEdit : undefined} onFlag={handleFlag} />}
                </div>
              )
            })}
          </div>
        </div>
      </div>
      </div>

      <ComposeBox
        personId={pid}
        thread={thread}
        convoLastMessage={convo?.lastMessage}
        personName={person?.display_name}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
        personIdentities={personIdentities}
        pendingDropFiles={pendingDropFiles}
        onDropFilesConsumed={() => setPendingDropFiles([])}
        onComposeDropDismiss={() => { dragCounterRef.current = 0; setDragOver(false) }}
      />

      {showLinkPerson && pid && person && (
        <ManualMergeDialog
          personId={pid}
          personName={person.display_name}
          userId={user?.id}
          allConvos={convos}
          onClose={() => setShowLinkPerson(false)}
        />
      )}

      {dragOver && (
        <div className="drop-overlay">
          <div className="drop-overlay-inner">
            <Upload size={48} className="drop-overlay-icon" />
            <span className="drop-overlay-text">
              Upload to {person?.display_name ?? 'conversation'}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function ManualMergeDialog({ personId, personName, userId, allConvos, onClose }: {
  personId: string
  personName: string
  userId?: string
  allConvos: import('../../types').ConversationPreview[]
  onClose: () => void
}) {
  const [search, setSearch] = useState('')
  const [selectedTarget, setSelectedTarget] = useState<import('../../types').ConversationPreview | null>(null)
  const merge = useMergePersons(userId)
  const inputRef = useRef<HTMLInputElement>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const candidates = allConvos
    .filter((c) => c.person.id !== personId && c.person.display_name.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 10)

  const confirmMerge = () => {
    if (!selectedTarget) return
    merge.mutate({ keepId: personId, mergeId: selectedTarget.person.id }, {
      onSuccess: () => onClose(),
    })
  }

  return (
    <div onClick={onClose} className="modal-backdrop">
      <div onClick={(e) => e.stopPropagation()} className="modal-panel w-[420px] max-h-[70vh]">
        <div className="border-b border-[var(--color-border)] px-4 pt-4 pb-3">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-base font-semibold text-white">
              {selectedTarget ? 'Confirm merge' : `Link person to ${personName}`}
            </h3>
            <button onClick={onClose} className="cursor-pointer border-none bg-transparent p-1 text-text-muted">
              <XIcon size={16} />
            </button>
          </div>
          {!selectedTarget && (
            <input
              ref={inputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search contacts..."
              className="w-full rounded border border-[var(--color-border)] px-3 text-sm outline-none h-9 bg-bg text-white"
            />
          )}
        </div>

        {selectedTarget ? (
          <div className="flex flex-col gap-3 p-4">
            <p className="text-sm text-text-muted">
              Merge <strong className="text-white">{selectedTarget.person.display_name}</strong> into <strong className="text-white">{personName}</strong>?
            </p>
            <p className="text-xs text-text-muted">
              All conversations and identities will be moved to {personName}. This can be undone from Settings.
            </p>
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setSelectedTarget(null)}
                className="flex-1 cursor-pointer rounded border border-[var(--color-border)] bg-transparent py-2 text-sm font-medium text-white"
              >
                Back
              </button>
              <button
                onClick={confirmMerge}
                disabled={merge.isPending}
                className={`flex-1 cursor-pointer rounded border-none py-2 text-sm font-medium text-white bg-accent ${merge.isPending ? 'opacity-50' : ''}`}
              >
                {merge.isPending ? 'Merging...' : 'Confirm merge'}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-2">
            {search.length === 0 && (
              <p className="p-3 text-center text-xs text-text-muted">
                Type to search for a person to link
              </p>
            )}
            {search.length > 0 && candidates.length === 0 && (
              <p className="p-3 text-center text-xs text-text-muted">
                No matching contacts
              </p>
            )}
            {candidates.map((c) => (
              <button
                key={c.person.id}
                onClick={() => setSelectedTarget(c)}
                className="flex w-full items-center gap-2.5 rounded border-none bg-transparent px-2.5 py-2 text-left text-white cursor-pointer hover:bg-[var(--hover-row-subtle)]"
              >
                {_.isString(c.person.avatar_url) ? (
                  <img src={c.person.avatar_url} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />
                ) : (
                  <div className={`${avatarCls(c.person.id)} flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white`}>
                    {initials(c.person.display_name)}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{c.person.display_name}</div>
                  <div className="mt-0.5 flex gap-1">
                    {_.isArray(c.channels) && c.channels.map((ch) => (
                      <span key={ch} className="rounded px-1 text-2xs bg-bg text-text-muted">{ch}</span>
                    ))}
                  </div>
                </div>
                <Link2 size={14} className="text-accent shrink-0" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="thread-empty bg-bg">
      <div className="text-center">
        <div className="av-1 avatar avatar--hero mx-auto mb-4">
          C
        </div>
        <h2 className="text-[24px] font-bold text-text-primary">Welcome back!</h2>
        <p className="text-body mt-1 text-text-secondary">Select a conversation to start</p>
      </div>
    </div>
  )
}

function ThreadSkeleton() {
  const rows = [
    { align: 'left', w1: '30%', w2: '55%' },
    { align: 'left', w1: '25%', w2: '70%' },
    { align: 'right', w1: '40%', w2: '45%' },
    { align: 'left', w1: '20%', w2: '60%' },
    { align: 'right', w1: '35%', w2: '50%' },
    { align: 'left', w1: '28%', w2: '65%' },
    { align: 'right', w1: '30%', w2: '40%' },
  ] as const

  return (
    <div className="thread-col">
      <div className="flex-1 flex flex-col justify-end px-4 pt-4 pb-6 gap-5">
        {rows.map((r, i) => (
          <div key={i} className={`flex gap-3 max-w-[70%] ${r.align === 'right' ? 'self-end' : 'self-start'}`}>
            {r.align === 'left' && <div className="skeleton w-10 h-10 rounded-full shrink-0" />}
            <div className="flex-1">
              <div className="skeleton h-3 rounded-sm mb-1.5" style={{ width: r.w1 }} />
              <div className="skeleton h-4 rounded-sm" style={{ width: r.w2 }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function DayDivider({ iso }: { iso: string }) {
  return (
    <div className="day-divider">
      <span className="day-divider-text">{dateDivider(iso)}</span>
    </div>
  )
}

function ChannelFilterPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`inline-flex items-center text-sm font-semibold px-2.5 py-[3px] rounded-pill border-none cursor-pointer ${active ? 'text-text-primary' : 'text-text-muted'}`}
      style={{ background: active ? 'color-mix(in srgb, var(--color-accent) 25%, transparent)' : 'var(--color-surface)' }}
    >{children}</button>
  )
}

function DeliveryStatus({ msg }: { msg: Message }) {
  const iconCls = 'inline-flex items-center ml-1.5 align-middle'
  if (msg._failed) {
    return (
      <span className={`${iconCls} text-danger cursor-pointer`} title="Failed to send — tap to dismiss"
        onClick={() => removePending(msg.person_id!, msg.id)}>
        <XIcon size={12} />
      </span>
    )
  }
  if (msg._pending) {
    return <span className={`${iconCls} text-text-pending`}><Clock size={12} /></span>
  }
  if (msg.seen) {
    return <span className={`${iconCls} text-link`}><CheckCheck size={12} /></span>
  }
  if (msg.delivered) {
    return <span className={`${iconCls} text-text-muted`}><CheckCheck size={12} /></span>
  }
  return <span className={`${iconCls} text-text-muted`}><Check size={12} /></span>
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
    <div className="py-1 pr-12 pl-[72px]">
      <div className="rounded-card bg-surface-input p-2 border border-accent">
        <textarea ref={ref} rows={1} value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(msg.id, text.trim()) }
            if (e.key === 'Escape') onCancel()
          }}
          className="w-full bg-transparent border-none outline-none resize-none text-text-body text-body leading-[22px]" />
        <div className="flex gap-2 justify-end mt-1">
          <button onClick={onCancel} className="bg-transparent border-none cursor-pointer text-text-muted text-sm font-semibold">Cancel</button>
          <button onClick={() => onSubmit(msg.id, text.trim())} className="bg-accent border-none cursor-pointer text-white text-sm font-semibold px-3 py-1 rounded-sm">Save</button>
        </div>
      </div>
      <span className="text-xs text-text-muted">Escape to cancel · Enter to save</span>
    </div>
  )
}

function MsgFull({ msg, person, memberAvatars, isMe, onReply, onEdit, onFlag }: {
  msg: Message
  person?: { id: string; display_name: string; avatar_url?: string | null } | null
  memberAvatars?: Record<string, string>
  isMe?: boolean
  onReply: (msg: Message) => void
  onEdit?: (msg: Message) => void
  onFlag?: (msg: Message) => void
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
  const av = out ? 'av-6' : avatarCls(msg.sender_name ?? person?.id ?? msg.id)

  const senderPic = out
    ? null
    : msgIsGroup && _.isString(msg.sender_name)
      ? (memberAvatars?.[msg.sender_name] ?? memberAvatars?.[cleanSenderName(msg.sender_name)] ?? null)
      : person?.avatar_url ?? null

  return (
    <div className="msg-row msg-row--full">
      <MessageActions msg={msg} onReply={onReply} onEdit={onEdit ? () => onEdit(msg) : undefined} onFlag={onFlag} />
      {senderPic
        ? <img src={senderPic} alt="" className="msg-avatar" />
        : <div className={`${av} msg-avatar-initial`}>
            {out ? 'Y' : initials(name)}
          </div>}

      <div className="msg-name-row">
        <span className={`msg-name ${out ? 'text-success' : 'text-text-primary'}`}>
          {name}
        </span>
        <ChannelLogo channel={msg.channel} size={14} color={channelColor(msg.channel)} className="shrink-0 align-middle" />
        <span className="msg-time">
          {formatTimestamp(msg.sent_at)}
        </span>
        {_.isString(msg.flagged_at) && <Flag size={12} className="text-warning shrink-0" fill="currentColor" />}
      </div>

      <div style={S.msgBody}>
        <span><MessageBody msg={msg} />{out && <DeliveryStatus msg={msg} />}</span>
      </div>

      <Reactions reactions={msg.reactions} />
    </div>
  )
}

function MsgCompact({ msg, onReply, onEdit, onFlag }: { msg: Message; onReply: (msg: Message) => void; onEdit?: (msg: Message) => void; onFlag?: (msg: Message) => void }) {
  const out = msg.direction === 'outbound'
  return (
    <div className="msg-compact msg-row msg-row--compact">
      <MessageActions msg={msg} onReply={onReply} onEdit={onEdit ? () => onEdit(msg) : undefined} onFlag={onFlag} />
      <span className="msg-compact-ts">
        {shortTime(msg.sent_at)}
      </span>
      {_.isString(msg.flagged_at) && <Flag size={12} className="text-warning shrink-0" fill="currentColor" />}

      <div style={S.msgBody}>
        <span><MessageBody msg={msg} />{out && <DeliveryStatus msg={msg} />}</span>
      </div>

      <Reactions reactions={msg.reactions} />
    </div>
  )
}

function ComposeBox({ personId, thread, convoLastMessage, personName, replyTo, onClearReply, personIdentities, pendingDropFiles, onDropFilesConsumed, onComposeDropDismiss }: {
  personId: string; thread: Message[]; convoLastMessage?: Message; personName?: string
  replyTo: Message | null; onClearReply: () => void; personIdentities?: Identity[]
  pendingDropFiles?: PendingFile[]
  onDropFilesConsumed?: () => void
  onComposeDropDismiss?: () => void
}) {
  const [text, setText] = useState('')
  const [files, setFiles] = useState<{ name: string; data: string; mime: string; preview: string }[]>([])
  const [sendError, setSendError] = useState<string | null>(null)

  useEffect(() => {
    if (pendingDropFiles?.length) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing parent drop-queue prop into local state is a legitimate imperative hand-off; parent calls onDropFilesConsumed to clear.
      setFiles((prev) => mergePendingFiles(prev, pendingDropFiles))
      onDropFilesConsumed?.()
    }
  }, [pendingDropFiles, onDropFilesConsumed])
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null)
  const [showChannelPicker, setShowChannelPicker] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const channelPickerRef = useRef<HTMLDivElement>(null)
  const { user } = useAuth()
  const qc = useQueryClient()
  const cancelThread = useCancelThreadQueries(personId, user?.id)
  const invalidateThread = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['thread', personId] })
    qc.invalidateQueries({ queryKey: ['conversations', user?.id] })
  }, [qc, personId, user?.id])

  const last = _.last(thread) ?? convoLastMessage

  const identityChannels = _.uniqBy(personIdentities ?? [], (i) => i.channel)
  const activeChannel = selectedChannel ?? (last?.channel as Channel) ?? 'whatsapp'
  const activeIdentity = personIdentities?.find((i) => i.channel === activeChannel)

  const channelThread = useMemo(
    () => thread.filter((m) => m.channel === activeChannel),
    [thread, activeChannel],
  )
  const lastForChannel = _.last(channelThread)
    ?? (convoLastMessage?.channel === activeChannel ? convoLastMessage : null)
  const resolvedChatId = lastForChannel?.thread_id
  // Account routing MUST come from a real persisted message. Optimistic
  // pending messages are created with `unipile_account_id: null` — if we let
  // that null fall through to `activeIdentity.unipile_account_id` when the
  // user has multiple accounts on the same channel, `_.uniqBy(..., channel)`
  // picks an arbitrary identity and we end up 403-ing with
  // `errors/account_mismatch` from Unipile.
  const lastRealWithAccount = _.findLast(
    channelThread,
    (m) => !m._pending && _.isString(m.unipile_account_id) && m.unipile_account_id.length > 0,
  )
  const convoAccountId = convoLastMessage?.channel === activeChannel
    ? convoLastMessage.unipile_account_id
    : null
  const resolvedAccountId = lastRealWithAccount?.unipile_account_id
    ?? (_.isString(convoAccountId) ? convoAccountId : null)
    ?? activeIdentity?.unipile_account_id
    ?? ''

  useEffect(() => {
    if (!showChannelPicker) return
    const handler = (e: MouseEvent) => {
      if (channelPickerRef.current && !channelPickerRef.current.contains(e.target as Node)) setShowChannelPicker(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showChannelPicker])

  const failedMessages = thread.filter((m) => m._failed)

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
      if (f.size > MAX_ATTACHMENT_BYTES) {
        setSendError(`${f.name} is ${Math.round(f.size / (1024 * 1024))}MB — attachments are limited to ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB.`)
        return
      }
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

  const sendText = (body: string) => {
    if (!body || !resolvedChatId) return

    const optId = newOptimisticId()

    const optimistic: Message = {
      id: optId,
      user_id: last?.user_id ?? '',
      person_id: personId,
      identity_id: null,
      external_id: null,
      channel: activeChannel,
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
      flagged_at: null,
    }
    cancelThread()
    addPendingMessage(personId, optimistic)

    const meta = {
      userId: last?.user_id ?? '',
      personId,
      channel: activeChannel,
      messageType: last?.message_type ?? 'dm',
      accountId: resolvedAccountId,
      quoteId: '',
    }

    ;(async () => {
      try {
        const extId = await invoke<string>('send_message', { chatId: resolvedChatId, text: body, ...meta })
        if (extId) patchPendingExternalId(personId, optId, extId)
        invalidateThread()
        if (usePreferencesStore.getState().syncReadStatus) {
          invoke('chat_action', { userId: meta.userId, personId, action: 'mark_read' })
            .catch((e) => { if (import.meta.env.DEV) console.warn('[chat_action] read sync:', e) })
        }
      } catch (e) {
        const reason = describeError(e)
        console.error('[send_message] failed:', reason, e)
        markPendingFailed(personId, optId, reason)
      }
    })()
  }

  const send = () => {
    const body = text.trim()
    if ((!body && files.length === 0) || !resolvedChatId) return

    const filesToSend = [...files]
    const optId = newOptimisticId()

    const optimistic: Message = {
      id: optId,
      user_id: last?.user_id ?? '',
      person_id: personId,
      identity_id: null,
      external_id: null,
      channel: activeChannel,
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
      flagged_at: null,
    }
    cancelThread()
    addPendingMessage(personId, optimistic)
    setText('')
    setFiles([])
    onClearReply()
    ref.current?.focus()

    const meta = {
      userId: last?.user_id ?? '',
      personId,
      channel: activeChannel,
      messageType: last?.message_type ?? 'dm',
      accountId: resolvedAccountId,
      quoteId: replyTo?.external_id ?? '',
    }

    ;(async () => {
      try {
        if (filesToSend.length > 0) {
          for (let i = 0; i < filesToSend.length; i++) {
            const f = filesToSend[i]
            const extId = await invoke<string>('send_attachment', {
              chatId: resolvedChatId,
              text: i === 0 ? (body || null) : null,
              fileName: f.name,
              fileData: f.data,
              mimeType: f.mime,
              ...meta,
            })
            if (i === 0 && extId) patchPendingExternalId(personId, optId, extId)
          }
        } else {
          const extId = await invoke<string>('send_message', { chatId: resolvedChatId, text: body, ...meta })
          if (extId) patchPendingExternalId(personId, optId, extId)
        }
        invalidateThread()
        if (usePreferencesStore.getState().syncReadStatus) {
          invoke('chat_action', { userId: meta.userId, personId, action: 'mark_read' })
            .catch((e) => { if (import.meta.env.DEV) console.warn('[chat_action] read sync:', e) })
        }
      } catch (e) {
        const reason = describeError(e)
        console.error('[send] failed:', reason, e)
        markPendingFailed(personId, optId, reason)
      }
    })()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
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
      <div className="px-4 pb-6">
        <div className="rounded-card px-4 py-[11px] bg-surface-input text-text-muted text-body">
          No chat context
        </div>
      </div>
    )
  }

  return (
    <div className="compose-wrap"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        addFiles(e.dataTransfer.files)
        onComposeDropDismiss?.()
      }}>

      {failedMessages.length > 0 && (
        <div className="mb-1.5">
          {failedMessages.map((m) => (
            <div key={m.id} className="failed-msg-row">
              <span className="failed-msg-text" title={m._failedReason ?? undefined}>
                Failed to send: {cleanPreviewText(m.body_text ?? '').slice(0, 40)}
                {_.isString(m._failedReason) && m._failedReason.length > 0 && (
                  <span className="failed-msg-reason"> — {m._failedReason}</span>
                )}
              </span>
              <button onClick={() => {
                const bodyText = m.body_text ?? ''
                removePending(personId, m.id)
                sendText(bodyText)
              }} className="failed-msg-retry">Retry</button>
            </div>
          ))}
        </div>
      )}

      {sendError && (
        <div className="failed-msg-row mb-1.5">
          <span className="failed-msg-text">{sendError}</span>
          <button onClick={() => setSendError(null)} className="failed-msg-retry">Dismiss</button>
        </div>
      )}

      {replyTo && (
        <div className="reply-bar">
          <div className="flex-1 min-w-0">
            <div className="reply-bar-name">
              Replying to {replyTo.direction === 'outbound' ? 'yourself' : (replyTo.sender_name ?? personName ?? 'message')}
            </div>
            <div className="reply-bar-text">
              {cleanPreviewText(replyTo.body_text ?? '').slice(0, 80)}
            </div>
          </div>
          <button onClick={onClearReply} className="compose-icon-btn p-1"><XIcon size={16} /></button>
        </div>
      )}

      <div className={`compose-box${replyTo ? ' compose-box--replying' : ''}`}>
        {files.length > 0 && (
          <div className="file-preview-row">
            {files.map((f, i) => (
              <div key={i} className="file-preview-card">
                <div className="file-preview-thumb">
                  {f.preview
                    ? <img src={f.preview} alt="" />
                    : <div className="file-preview-placeholder">
                        <FileText size={32} />
                      </div>}
                  <button onClick={() => removeFile(i)} className="file-preview-remove"><XIcon size={12} /></button>
                </div>
                <span className="file-preview-name">{f.name}</span>
              </div>
            ))}
          </div>
        )}

        <div className="compose-row">
          {identityChannels.length > 1 && (
            <div className="relative" ref={channelPickerRef}>
              <button onClick={() => setShowChannelPicker((v) => !v)} className="compose-icon-btn flex items-center gap-0.5" title={`Send via ${activeChannel}`}>
                <ChannelLogo channel={activeChannel} size={16} color={channelColor(activeChannel)} />
                <ChevronDown size={10} />
              </button>
              {showChannelPicker && (
                <div className="channel-picker-dropdown">
                  {identityChannels.map((ident) => (
                    <button key={ident.id} onClick={() => { setSelectedChannel(ident.channel); setShowChannelPicker(false) }} className="channel-picker-item" data-active={ident.channel === activeChannel}>
                      <ChannelLogo channel={ident.channel} size={14} color={channelColor(ident.channel)} />
                      <span>{ident.channel.charAt(0).toUpperCase() + ident.channel.slice(1)}</span>
                      {ident.handle && <span className="text-xs text-text-muted ml-auto">{ident.handle}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button onClick={() => fileRef.current?.click()} className="compose-icon-btn" title="Attach file"><Paperclip size={20} /></button>
          <input ref={fileRef} type="file" multiple hidden
            onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />

          <textarea
            ref={ref}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={`Message @${personName ?? 'this chat'}`}
            className="compose-textarea"
          />
        </div>
      </div>
    </div>
  )
}
