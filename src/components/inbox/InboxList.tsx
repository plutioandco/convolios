import { useState } from 'react'
import _ from 'lodash'
import { useAuth } from '../../lib/auth'
import { useInboxStore, useFilterStore } from '../../stores/inboxStore'
import { useAccountsStore } from '../../stores/accountsStore'
import { useRealtimeConnected } from '../../App'
import { useConversations } from '../../hooks/useConversations'
import { channelColor, channelLabel, channelIcon, relativeTime, initials, avatarCls, cleanPreviewText, accountDisplayLabel } from '../../utils'
import type { ConversationPreview } from '../../types'

const REACTION_PREVIEW_RE = /^\{\{[^}]+\}\}\s*reacted\s+/

function previewText(c: ConversationPreview): string {
  let body: string
  if (_.isString(c.lastMessage.body_text) && REACTION_PREVIEW_RE.test(c.lastMessage.body_text)) {
    body = `reacted ${c.lastMessage.body_text.replace(REACTION_PREVIEW_RE, '')}`
  } else if (c.lastMessage.body_text && !c.lastMessage.body_text.startsWith('-- Unipile cannot display')) {
    body = cleanPreviewText(c.lastMessage.body_text).slice(0, 50)
  } else if (_.isString(c.lastMessage.subject) && c.lastMessage.subject.trim()) {
    body = cleanPreviewText(c.lastMessage.subject).slice(0, 50)
  } else if (c.lastMessage.channel === 'email') {
    body = 'Email'
  } else {
    body = 'sent an attachment'
  }
  return body
}

function prevInboundText(c: ConversationPreview): string | null {
  if (c.lastMessage.direction !== 'outbound') return null
  if (!_.isString(c.prevInboundBody)) return null
  const body = cleanPreviewText(c.prevInboundBody).slice(0, 45)
  if (!body) return null
  const isGroup = c.lastMessage.message_type === 'group'
  const sender = isGroup && _.isString(c.prevInboundSender)
    ? `${c.prevInboundSender.split(' ')[0]}: `
    : `${c.person.display_name.split(' ')[0]}: `
  return sender + body
}

export function InboxList() {
  const { user } = useAuth()
  const rtConnected = useRealtimeConnected()
  const { data: convos = [], isLoading, error } = useConversations(user?.id, rtConnected)
  const ch = useInboxStore((s) => s.activeChannel)
  const sel = useInboxStore((s) => s.selectedPersonId)
  const pick = useInboxStore((s) => s.selectPerson)
  const triageFilter = useFilterStore((s) => s.triageFilter)
  const accounts = useAccountsStore((s) => s.accounts)
  const [query, setQuery] = useState('')

  const channelAccounts = ch !== 'all'
    ? accounts.filter((a) => a.channel === ch && a.status === 'active')
    : []

  const connectionSummary = channelAccounts.length > 0
    ? _.uniq(channelAccounts.map((a) => accountDisplayLabel(a)).filter(Boolean)).join(', ') || null
    : null

  const list = convos.filter((c) => {
    if (ch !== 'all' && c.lastMessage.channel !== ch) return false
    if (triageFilter !== 'all' && c.lastMessage.triage !== triageFilter) return false
    if (query && !c.person.display_name.toLowerCase().includes(query.toLowerCase())) return false
    return true
  })

  const seenIds = new Set<string>()
  const seenNames = new Set<string>()
  const deduped = list.filter((c) => {
    if (seenIds.has(c.person.id)) return false
    const nameKey = c.person.display_name.trim().replace(/\s+/g, ' ').toLowerCase()
    if (seenNames.has(nameKey)) return false
    seenIds.add(c.person.id)
    seenNames.add(nameKey)
    return true
  })

  return (
    <div style={{
      width: 240, flexShrink: 0, display: 'flex', flexDirection: 'column',
      height: '100%', background: '#2b2d31', userSelect: 'none',
    }}>
      <div style={{
        height: 48, padding: '0 10px', display: 'flex', alignItems: 'center', flexShrink: 0,
        boxShadow: '0 1px 0 rgba(4,4,5,.2), 0 1.5px 0 rgba(6,6,7,.05), 0 2px 0 rgba(4,4,5,.05)',
      }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find or start a conversation"
          style={{
            width: '100%', height: 28, borderRadius: 4, padding: '0 8px',
            background: '#1e1f22', color: '#dbdee1', fontSize: 13,
            border: 'none', outline: 'none',
          }}
        />
      </div>

      <div style={{
        padding: '18px 18px 4px', fontSize: 12, fontWeight: 600,
        textTransform: 'uppercase', letterSpacing: '.02em', color: '#949ba4',
      }}>
        {ch !== 'all' ? channelLabel(ch) : 'Conversations'}
        {connectionSummary && (
          <p style={{
            fontSize: 11, fontWeight: 400, textTransform: 'none', letterSpacing: 'normal',
            color: '#6d6f78', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {connectionSummary}
          </p>
        )}
      </div>

      <div className="thin-scroll" style={{ flex: 1, minHeight: 0, padding: '0 8px 8px' }}>
        {isLoading && deduped.length === 0 && <Empty>Loading...</Empty>}
        {!isLoading && error && deduped.length === 0 && <Empty>Error loading conversations</Empty>}
        {!isLoading && !error && deduped.length === 0 && <Empty>No conversations</Empty>}

        {deduped.map((c) => {
          const isGroup = c.lastMessage.message_type === 'group'
          const clr = channelColor(c.lastMessage.channel)
          const active = sel === c.person.id
          const hasUnread = c.unreadCount > 0
          const isOutbound = c.lastMessage.direction === 'outbound'
          const prevLine = prevInboundText(c)
          const senderPrefix = isGroup && _.isString(c.lastMessage.sender_name)
            ? `${c.lastMessage.sender_name.split(' ')[0]}: `
            : ''

          return (
            <div
              key={c.person.id}
              onClick={() => pick(c.person.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '8px 8px', borderRadius: 4, marginBottom: 1, cursor: 'pointer',
                background: active ? 'rgba(79, 84, 92, 0.6)' : 'transparent',
              }}
              onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'rgba(79, 84, 92, 0.32)' }}
              onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent' }}
            >
              <div style={{ position: 'relative', width: 42, height: 42, flexShrink: 0 }}>
                {c.person.avatar_url
                  ? <img src={c.person.avatar_url} alt="" style={{
                      width: 42, height: 42, borderRadius: '50%', objectFit: 'cover',
                    }} />
                  : <div className={avatarCls(c.person.id)}
                      style={{
                        width: 42, height: 42, borderRadius: isGroup ? 10 : '50%',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 14, fontWeight: 600, color: '#fff',
                      }}>
                      {isGroup ? '\uD83D\uDC65' : initials(c.person.display_name)}
                    </div>}
                <span style={{
                  position: 'absolute', bottom: -2, right: -4, fontSize: 8, fontWeight: 700,
                  lineHeight: '14px', padding: '0 3px', borderRadius: 3,
                  background: clr, color: '#fff',
                }}>
                  {channelIcon(c.lastMessage.channel)}
                </span>
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{
                    flex: 1, fontSize: 16, lineHeight: '20px', fontWeight: hasUnread || active ? 600 : 400,
                    color: hasUnread || active ? '#f2f3f5' : '#949ba4',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {c.person.display_name}
                  </span>
                  <span style={{ fontSize: 11, color: '#6d6f78', flexShrink: 0 }}>
                    {relativeTime(c.lastMessage.sent_at)}
                  </span>
                </div>

                {prevLine && (
                  <div style={{
                    fontSize: 12, lineHeight: '16px', color: '#6d6f78',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {prevLine}
                  </div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{
                    flex: 1, fontSize: 13, lineHeight: '16px',
                    color: isOutbound ? '#b5bac1' : '#949ba4',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {isOutbound && (
                      <span style={{
                        fontSize: 11,
                        color: c.lastMessage.seen ? '#00aff4' : '#6d6f78',
                        marginRight: 3,
                      }}>
                        {c.lastMessage.seen ? '\u2713\u2713' : c.lastMessage.delivered ? '\u2713\u2713' : '\u2713'}
                      </span>
                    )}
                    {isOutbound ? `You: ${previewText(c)}` : senderPrefix + previewText(c)}
                  </span>
                  {hasUnread && (
                    <span style={{
                      width: 8, height: 8, borderRadius: '50%', background: '#ed4245', flexShrink: 0,
                    }} />
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Empty({ children }: { children: string }) {
  return <p style={{ textAlign: 'center', padding: '32px 0', color: '#949ba4', fontSize: 14 }}>{children}</p>
}
