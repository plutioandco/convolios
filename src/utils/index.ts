import _ from 'lodash'
import type { Channel, ConnectedAccount } from '../types'

export const CHANNEL_META: Record<Channel, { label: string; color: string }> = {
  whatsapp:    { label: 'WhatsApp',    color: '#25D366' },
  linkedin:    { label: 'LinkedIn',    color: '#0A66C2' },
  instagram:   { label: 'Instagram',   color: '#E4405F' },
  telegram:    { label: 'Telegram',    color: '#26A5E4' },
  email:       { label: 'Email',       color: '#EA4335' },
  x:           { label: 'X',           color: '#f2f3f5' },
  imessage:    { label: 'iMessage',    color: '#34C759' },
  sms:         { label: 'SMS',         color: '#A8B8D8' },
  slack:       { label: 'Slack',       color: '#E01E5A' },
  clickup:     { label: 'ClickUp',     color: '#7B68EE' },
  google_chat: { label: 'Google Chat', color: '#34A853' },
}

const CHANNEL_ALIAS: Record<string, string> = {
  google_oauth: 'email',
  gmail: 'email',
  google: 'email',
  outlook: 'email',
  microsoft: 'email',
  imap: 'email',
  mail: 'email',
  mobile: 'sms',
  rcs: 'sms',
}

// Normalizes a raw provider channel string (e.g. 'gmail', 'microsoft') to a
// canonical `Channel` key used in CHANNEL_META. ChannelLogo has its own
// alias table because icon rendering preserves distinct brands like Outlook.
export function resolveChannel(ch: string): string {
  return CHANNEL_ALIAS[ch.toLowerCase()] ?? ch
}

// Shared palette used by the sidebar swatch picker and the settings circle
// editor. Kept short and visually distinct — 8 hues align with avatar tokens.
export const CIRCLE_COLORS = [
  '#5865f2', '#23a559', '#f0b132', '#ed4245',
  '#eb459e', '#00b0f4', '#ff7733', '#9b59b6',
]

export function channelLabel(ch: string): string {
  return CHANNEL_META[resolveChannel(ch) as Channel]?.label ?? ch
}

export function channelColor(ch: string): string {
  return CHANNEL_META[resolveChannel(ch) as Channel]?.color ?? '#b5bac1'
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday = d.toDateString() === yesterday.toDateString()

  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (isToday) return `Today at ${time}`
  if (isYesterday) return `Yesterday at ${time}`
  return d.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit', year: 'numeric' }) + ' ' + time
}

export function shortTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function dateDivider(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === now.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
}

export function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d === 1) return 'Yesterday'
  if (d < 7) return `${d}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function initials(name: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N}\s]/gu, '').trim()
  if (!cleaned) return '?'
  const compact = cleaned.replace(/\s/g, '')
  if (/^\d+$/.test(compact)) return compact.slice(-2) || '?'
  return cleaned.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('')
}

export function avatarCls(id: string): string {
  const n = id.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return `av-${(n % 8) + 1}`
}

export function isLightBrandColor(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return (r * 299 + g * 587 + b * 114) / 1000 > 186
}

export function circleGradient(colors: string[]): string | undefined {
  if (!colors.length) return undefined
  if (colors.length === 1) return colors[0]
  const step = 360 / colors.length
  return `conic-gradient(${colors.map((c, i) => `${c} ${i * step}deg ${(i + 1) * step}deg`).join(', ')})`
}

const ZERO_WIDTH_RE = /\u00AD|\u200B|\u200C|\u200D|\u200E|\u200F|\uFEFF|\u2060|\u034F/gu

export function cleanPreviewText(text: string): string {
  if (!text) return ''
  let out = text
  if (out.includes('&')) {
    const el = document.createElement('textarea')
    el.innerHTML = out
    out = el.value ?? out
  }
  return out.replace(ZERO_WIDTH_RE, '').replace(/\s+/g, ' ').trim()
}

// WhatsApp webhooks embed the reacting user as `{{<phone-or-id>@lid}}` inside
// sender_name and body_text. Strip those placeholders so UI never shows raw
// `{{17053026490@lid}}` gunk — used by ThreadView, notifications, etc.
export const LID_RE = /\{\{[^}]+@lid\}\}/g
export const REACTION_RE = /^\{\{[^}]+\}\}\s*reacted\s+(.+)$/

export function cleanSenderName(raw: string): string {
  return raw.replace(LID_RE, '').trim() || raw
}

export function accountDisplayLabel(a: ConnectedAccount): string {
  if (_.isString(a.email) && a.email.length > 0) return a.email
  if (_.isString(a.phone) && a.phone.length > 0) {
    return a.phone.startsWith('+') ? a.phone : `+${a.phone}`
  }
  if (_.isString(a.username) && a.username.length > 0) return `@${a.username}`
  if (_.isString(a.display_name) && a.display_name.length > 0) return a.display_name
  return channelLabel(a.channel)
}
