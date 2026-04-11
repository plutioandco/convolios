import _ from 'lodash'
import type { Channel, ConnectedAccount } from '../types'

export const CHANNEL_META: Record<Channel, { label: string; abbr: string; color: string }> = {
  whatsapp:    { label: 'WhatsApp',    abbr: 'WA', color: '#25D366' },
  linkedin:    { label: 'LinkedIn',    abbr: 'LI', color: '#0A66C2' },
  instagram:   { label: 'Instagram',   abbr: 'IG', color: '#E4405F' },
  telegram:    { label: 'Telegram',    abbr: 'TG', color: '#26A5E4' },
  email:       { label: 'Email',       abbr: 'EM', color: '#b5bac1' },
  x:           { label: 'X',           abbr: 'X',  color: '#f2f3f5' },
  slack:       { label: 'Slack',       abbr: 'SL', color: '#E01E5A' },
  clickup:     { label: 'ClickUp',     abbr: 'CU', color: '#7B68EE' },
  google_chat: { label: 'Google Chat', abbr: 'GC', color: '#34A853' },
}

const CHANNEL_ALIAS: Record<string, string> = {
  google_oauth: 'email',
  gmail: 'email',
  google: 'email',
  outlook: 'email',
  microsoft: 'email',
  imap: 'email',
  mail: 'email',
}

function resolveChannel(ch: string): string {
  return CHANNEL_ALIAS[ch.toLowerCase()] ?? ch
}

export function channelLabel(ch: string): string {
  return CHANNEL_META[resolveChannel(ch) as Channel]?.label ?? ch
}

export function channelAbbr(ch: string): string {
  return CHANNEL_META[resolveChannel(ch) as Channel]?.abbr ?? ch.slice(0, 2).toUpperCase()
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

export function channelIcon(ch: string): string {
  const resolved = resolveChannel(ch)
  const map: Record<string, string> = {
    whatsapp: 'WA', linkedin: 'LI', instagram: 'IG',
    telegram: 'TG', email: 'EM', slack: 'SL',
    x: 'X', clickup: 'CU', google_chat: 'GC',
  }
  return map[resolved] ?? ch.slice(0, 2).toUpperCase()
}

const ZERO_WIDTH_RE = /[\u00AD\u200B\u200C\u200D\u200E\u200F\uFEFF\u2060\u034F]/g

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

export function accountDisplayLabel(a: ConnectedAccount): string {
  if (_.isString(a.email) && a.email.length > 0) return a.email
  if (_.isString(a.phone) && a.phone.length > 0) {
    return a.phone.startsWith('+') ? a.phone : `+${a.phone}`
  }
  if (_.isString(a.username) && a.username.length > 0) return `@${a.username}`
  if (_.isString(a.display_name) && a.display_name.length > 0) return a.display_name
  return channelLabel(a.channel)
}
