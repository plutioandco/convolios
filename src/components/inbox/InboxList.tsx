import _ from 'lodash'
import { useInboxStore, useFilterStore } from '../../stores/inboxStore'
import { CHANNEL_META, formatRelativeTime } from '../../utils'
import type { Channel, TriageLevel } from '../../types'

const triageBadge: Record<TriageLevel, { label: string; color: string } | null> = {
  urgent: { label: '!', color: 'var(--danger)' },
  human: null,
  newsletter: { label: 'NL', color: 'var(--text-muted)' },
  notification: { label: 'SYS', color: 'var(--text-muted)' },
  noise: { label: 'X', color: 'var(--text-muted)' },
  unclassified: null,
}

export function InboxList() {
  const conversations = useInboxStore((s) => s.conversations)
  const activeChannel = useInboxStore((s) => s.activeChannel)
  const selectedPersonId = useInboxStore((s) => s.selectedPersonId)
  const selectPerson = useInboxStore((s) => s.selectPerson)
  const loading = useInboxStore((s) => s.loading)
  const triageFilter = useFilterStore((s) => s.triageFilter)

  const filtered = conversations.filter((c) => {
    if (activeChannel !== 'all' && c.lastMessage.channel !== activeChannel) return false
    if (triageFilter !== 'all' && c.lastMessage.triage !== triageFilter) return false
    return true
  })

  const unreadCount = filtered.filter((c) => c.unreadCount > 0).length

  return (
    <div className="h-full flex flex-col" style={{ width: 320, borderRight: '1px solid var(--border)' }}>
      <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border)' }}>
        <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Inbox</h2>
        <div className="flex items-center gap-2">
          <TriageFilterSelect />
          {unreadCount > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: 'var(--accent)', color: '#fff' }}>
              {unreadCount} new
            </span>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && filtered.length === 0 && (
          <div className="p-4 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
            Loading conversations...
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="p-4 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
            No conversations yet. Connect an account in Settings to get started.
          </div>
        )}

        {filtered.map(conv => {
          const channelMeta = CHANNEL_META[conv.lastMessage.channel as Channel]
          const badge = triageBadge[conv.lastMessage.triage]
          const isSelected = selectedPersonId === conv.person.id

          return (
            <div
              key={conv.person.id}
              onClick={() => selectPerson(conv.person.id)}
              className="px-4 py-3 cursor-pointer transition-colors hover:bg-[var(--bg-tertiary)]"
              style={{
                borderBottom: '1px solid var(--border)',
                backgroundColor: isSelected ? 'var(--bg-tertiary)' : undefined,
              }}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs">{channelMeta?.icon ?? '💬'}</span>
                <span className="text-sm font-medium flex-1 truncate" style={{
                  color: conv.unreadCount > 0 ? 'var(--text-primary)' : 'var(--text-secondary)'
                }}>
                  {conv.person.display_name}
                </span>
                {badge && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold" style={{
                    color: badge.color,
                    border: `1px solid ${badge.color}`,
                  }}>
                    {badge.label}
                  </span>
                )}
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {formatRelativeTime(conv.lastMessage.sent_at)}
                </span>
              </div>
              <p className="text-xs truncate" style={{
                color: conv.unreadCount > 0 ? 'var(--text-secondary)' : 'var(--text-muted)'
              }}>
                {conv.lastMessage.direction === 'outbound' && (
                  <span style={{ color: 'var(--text-muted)' }}>You: </span>
                )}
                {conv.lastMessage.body_text ?? '(attachment)'}
              </p>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TriageFilterSelect() {
  const triageFilter = useFilterStore((s) => s.triageFilter)
  const setTriageFilter = useFilterStore((s) => s.setTriageFilter)

  return (
    <select
      value={triageFilter}
      onChange={(e) => setTriageFilter(e.target.value as TriageLevel | 'all')}
      className="text-xs rounded px-1.5 py-0.5 cursor-pointer"
      style={{
        backgroundColor: 'var(--bg-tertiary)',
        color: 'var(--text-secondary)',
        border: '1px solid var(--border)',
      }}
    >
      <option value="all">All</option>
      <option value="urgent">Urgent</option>
      <option value="human">Human</option>
      <option value="newsletter">Newsletter</option>
      <option value="notification">Notification</option>
      <option value="noise">Noise</option>
    </select>
  )
}
