import type { Channel } from '../types'

export const CHANNEL_META: Record<Channel, { label: string; icon: string }> = {
  whatsapp: { label: 'WhatsApp', icon: '💬' },
  linkedin: { label: 'LinkedIn', icon: '💼' },
  instagram: { label: 'Instagram', icon: '📷' },
  telegram: { label: 'Telegram', icon: '✈️' },
  email: { label: 'Email', icon: '📧' },
  x: { label: 'X / Twitter', icon: '𝕏' },
  slack: { label: 'Slack', icon: '🔗' },
  clickup: { label: 'ClickUp', icon: '✅' },
  google_chat: { label: 'Google Chat', icon: '💬' },
}

export function formatRelativeTime(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMs = now - then
  const diffMin = Math.floor(diffMs / 60_000)

  if (diffMin < 1) return 'now'
  if (diffMin < 60) return `${diffMin}m ago`

  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`

  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 7) return `${diffDay}d ago`

  return new Date(dateStr).toLocaleDateString()
}
