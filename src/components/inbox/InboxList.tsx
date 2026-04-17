import { useState, useRef, useEffect } from 'react'
import _ from 'lodash'
import { useAuth } from '../../lib/auth'
import { useInboxStore, useFilterStore } from '../../stores/inboxStore'
import { useAccountsStore } from '../../stores/accountsStore'
import { useRealtimeConnected } from '../../lib/realtimeContext'
import { useConversations } from '../../hooks/useConversations'
import { useFlaggedMessages } from '../../hooks/useFlaggedMessages'
import { useCircles, useApprovePerson, useBlockPerson, useAddToCircle, useRemoveFromCircle, usePersonCircleColors } from '../../hooks/useCircles'
import { Check, CheckCheck, Users, X, ChevronRight, ShieldOff, Pin, BellDot, Flag } from 'lucide-react'
import { channelColor, channelLabel, relativeTime, initials, avatarCls, cleanPreviewText, accountDisplayLabel, circleGradient, isLightBrandColor } from '../../utils'
import { ChannelLogo } from '../icons/ChannelLogo'
import type { ConversationPreview, FlaggedMessage } from '../../types'

const REACTION_PREVIEW_RE = /^\{\{[^}]+\}\}\s*reacted\s+/

function previewText(c: ConversationPreview): string {
  if (_.isString(c.lastMessage.body_text) && REACTION_PREVIEW_RE.test(c.lastMessage.body_text)) {
    return `reacted ${c.lastMessage.body_text.replace(REACTION_PREVIEW_RE, '')}`
  }

  if (_.isString(c.lastMessage.body_text) && !c.lastMessage.body_text.startsWith('-- Unipile cannot display')) {
    const cleaned = cleanPreviewText(c.lastMessage.body_text).slice(0, 50)
    if (cleaned) return cleaned
  }

  if (_.isString(c.lastMessage.subject) && c.lastMessage.subject.trim()) {
    return cleanPreviewText(c.lastMessage.subject).slice(0, 50)
  }

  if (c.lastMessage.channel === 'email') return 'Email'
  return 'sent an attachment'
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
  const ch = useInboxStore((s) => s.activeChannel)
  const sel = useInboxStore((s) => s.selectedPersonId)
  const focusMsg = useInboxStore((s) => s.focusMessageId)
  const pick = useInboxStore((s) => s.selectPerson)
  const activeView = useInboxStore((s) => s.activeView)
  const activeCircleId = useInboxStore((s) => s.activeCircleId)
  const readFilter = useInboxStore((s) => s.readFilter)
  const setReadFilter = useInboxStore((s) => s.setReadFilter)
  const triageFilter = useFilterStore((s) => s.triageFilter)
  const accounts = useAccountsStore((s) => s.accounts)
  const [query, setQuery] = useState('')

  const { data: circles = [] } = useCircles(user?.id)
  const { data: circleColors } = usePersonCircleColors(user?.id)
  const activeCircle = activeCircleId ? circles.find((c) => c.id === activeCircleId) : null
  const activeCircleName = activeCircle?.name ?? (activeCircleId ? 'Circle' : null)

  const [showAddPeople, setShowAddPeople] = useState(false)
  const [rowContextMenu, setRowContextMenu] = useState<{ convo: ConversationPreview; x: number; y: number } | null>(null)

  const { data: convos = [], isLoading, error } = useConversations(
    user?.id, rtConnected, 'approved', activeCircleId
  )
  const { data: pendingAll = [] } = useConversations(
    user?.id, rtConnected, 'pending'
  )
  const showBlocked = activeView === 'blocked'
  const showFlagged = activeView === 'flagged'
  const { data: blockedAll = [], isLoading: blockedLoading } = useConversations(
    showBlocked ? user?.id : undefined, rtConnected, 'blocked'
  )
  const { data: flaggedAll = [], isLoading: flaggedLoading } = useFlaggedMessages(
    showFlagged ? user?.id : undefined
  )

  const channelAccounts = ch !== 'all'
    ? accounts.filter((a) => a.channel === ch && a.status === 'active')
    : []

  const connectionSummary = channelAccounts.length > 0
    ? _.uniq(channelAccounts.map((a) => accountDisplayLabel(a)).filter(Boolean)).join(', ') || null
    : null

  const list = convos.filter((c) => {
    if (ch !== 'all' && c.lastMessage.channel !== ch) return false
    if (triageFilter !== 'all' && c.lastMessage.triage !== triageFilter) return false
    if (readFilter === 'unread' && c.unreadCount === 0 && !c.markedUnread) return false
    if (query && !c.person.display_name.toLowerCase().includes(query.toLowerCase())) return false
    return true
  })

  const seenIds = new Set<string>()
  const deduped = list.filter((c) => {
    if (seenIds.has(c.person.id)) return false
    seenIds.add(c.person.id)
    return true
  })

  const pinned = deduped.filter((c) => _.isString(c.pinnedAt))
  const unpinned = deduped.filter((c) => !_.isString(c.pinnedAt))

  const pendingSeenIds = new Set<string>()
  const pending = pendingAll.filter((c) => {
    if (ch !== 'all' && c.lastMessage.channel !== ch) return false
    if (query && !c.person.display_name.toLowerCase().includes(query.toLowerCase())) return false
    if (pendingSeenIds.has(c.person.id)) return false
    pendingSeenIds.add(c.person.id)
    return true
  })

  const blocked = blockedAll.filter((c) =>
    !query || c.person.display_name.toLowerCase().includes(query.toLowerCase())
  )

  const heading = showBlocked
    ? 'Blocked'
    : showFlagged
      ? 'Action Items'
      : activeCircleName
        ? activeCircleName
        : ch !== 'all' ? channelLabel(ch) : 'Conversations'

  return (
    <div className="inbox-panel">
      <div className="inbox-search-bar">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find or start a conversation"
          className="inbox-search-input"
        />
      </div>

      <div className="section-header">
        <div>
          {heading}
          {!showBlocked && !showFlagged && connectionSummary && (
            <p className="text-xs font-normal normal-case tracking-normal text-text-pending mt-0.5 truncate">
              {connectionSummary}
            </p>
          )}
        </div>
        {!showBlocked && !showFlagged && (
          <div className="flex gap-0.5 items-center">
            {activeCircleId && (
              <button
                onClick={() => setShowAddPeople((v) => !v)}
                title="Add people to circle"
                className={`w-[22px] h-[22px] rounded-sm flex items-center justify-center text-base font-normal mr-0.5 ${showAddPeople ? 'bg-accent text-white' : 'bg-[var(--hover-accent)] text-text-muted'}`}
              >+</button>
            )}
            <FilterPill active={readFilter === 'all'} onClick={() => setReadFilter('all')}>All</FilterPill>
            <FilterPill active={readFilter === 'unread'} onClick={() => setReadFilter('unread')}>Unread</FilterPill>
          </div>
        )}
      </div>

      <div className="thin-scroll flex-1 min-h-0 px-2 pb-2">
        {showFlagged ? (
          <>
            {flaggedLoading && flaggedAll.length === 0 && <InboxSkeleton />}
            {!flaggedLoading && flaggedAll.length === 0 && (
              <Empty>No flagged messages</Empty>
            )}
            {flaggedAll.filter((f) =>
              !query || f.displayName.toLowerCase().includes(query.toLowerCase())
            ).map((f) => (
              <FlaggedRow key={f.messageId} f={f} active={focusMsg === f.messageId} onSelect={(personId, messageId) => pick(personId, messageId)} circleColors={circleColors} />
            ))}
          </>
        ) : showBlocked ? (
          <>
            {blockedLoading && blocked.length === 0 && <InboxSkeleton />}
            {!blockedLoading && blocked.length === 0 && (
              <Empty>No blocked contacts</Empty>
            )}
            {blocked.map((c) => (
              <BlockedRow key={c.person.id} c={c} userId={user?.id} />
            ))}
          </>
        ) : showAddPeople && activeCircleId ? (
          <CircleAddPeoplePanel
            userId={user?.id}
            circleId={activeCircleId}
            rtConnected={rtConnected}
            onClose={() => setShowAddPeople(false)}
          />
        ) : (
          <>
            {pending.length > 0 && !activeCircleId && (
              <GatekeeperSection
                pending={pending}
                userId={user?.id}
                onSelect={pick}
                selectedId={sel}
                expanded={activeView === 'screener'}
              />
            )}

            {isLoading && deduped.length === 0 && <InboxSkeleton />}
            {!isLoading && error && deduped.length === 0 && <Empty>Error loading conversations</Empty>}
            {!isLoading && !error && deduped.length === 0 && pending.length === 0 && (
              activeCircleId ? (
                <div className="text-center py-8 px-3">
                  <p className="text-text-muted text-base mb-3">No one in this circle yet</p>
                  <button
                    onClick={() => setShowAddPeople(true)}
                    className="btn-primary btn-primary-sm"
                  >+ Add people</button>
                </div>
              ) : (
                <Empty>No conversations</Empty>
              )
            )}

            {pinned.map((c) => (
              <ConversationRow key={c.person.id} c={c} active={sel === c.person.id} onSelect={pick}
                  onContextMenu={(convo, x, y) => setRowContextMenu({ convo, x, y })} circleColors={circleColors} activeCircleColor={activeCircle?.color} />
            ))}

            {pinned.length > 0 && unpinned.length > 0 && (
              <div className="h-px bg-border mx-1 my-1" />
            )}

            {unpinned.map((c) => (
              <ConversationRow key={c.person.id} c={c} active={sel === c.person.id} onSelect={pick}
                  onContextMenu={(convo, x, y) => setRowContextMenu({ convo, x, y })} circleColors={circleColors} activeCircleColor={activeCircle?.color} />
            ))}
          </>
        )}
      </div>

      {rowContextMenu && (
        <ConversationContextMenu
          convo={rowContextMenu.convo}
          x={rowContextMenu.x}
          y={rowContextMenu.y}
          circles={circles}
          userId={user?.id}
          onClose={() => setRowContextMenu(null)}
        />
      )}
    </div>
  )
}

function CircleAddPeoplePanel({ userId, circleId, rtConnected, onClose }: {
  userId?: string; circleId: string; rtConnected?: boolean; onClose: () => void
}) {
  const [search, setSearch] = useState('')
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set())
  const { data: all = [], isLoading } = useConversations(userId, rtConnected, 'approved', undefined)
  const { data: inCircle = [] } = useConversations(userId, rtConnected, 'approved', circleId)
  const addToCircle = useAddToCircle(userId)
  const removeFromCircle = useRemoveFromCircle(userId)

  const inCircleIds = new Set(inCircle.map((c) => c.person.id))

  const filtered = all.filter((c) =>
    !search || c.person.display_name.toLowerCase().includes(search.toLowerCase())
  )

  const handleToggle = (personId: string) => {
    if (inCircleIds.has(personId) || addedIds.has(personId)) {
      removeFromCircle.mutate({ circleId, personId })
      setAddedIds((prev) => { const next = new Set(prev); next.delete(personId); return next })
    } else {
      addToCircle.mutate({ circleId, personId })
      setAddedIds((prev) => new Set(prev).add(personId))
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1.5 pt-2 pb-1.5">
        <input
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search contacts…"
          className="input-dark input-dark-bordered flex-1"
        />
        <button onClick={onClose} className="text-text-pending text-[18px] leading-none px-1">✕</button>
      </div>

      <div className="thin-scroll flex-1 min-h-0">
        {isLoading && <p className="text-text-pending text-md py-3">Loading…</p>}
        {filtered.map((c) => {
          const isMember = inCircleIds.has(c.person.id) || addedIds.has(c.person.id)
          return (
            <div key={c.person.id}
              className="conv-row"
              onClick={() => handleToggle(c.person.id)}
            >
              {c.person.avatar_url
                ? <img src={c.person.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" />
                : <div className={`avatar avatar--lg ${avatarCls(c.person.id)}`}>{initials(c.person.display_name)}</div>
              }
              <span className="flex-1 text-base text-text-body truncate">
                {c.person.display_name}
              </span>
              {isMember
                ? <Check size={14} className="text-success shrink-0" />
                : <span className="text-xs text-accent font-semibold shrink-0">+ Add</span>
              }
            </div>
          )
        })}
      </div>
    </div>
  )
}

function FilterPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      className="triage-pill normal-case tracking-normal"
      data-active={active}
      onClick={onClick}
    >{children}</button>
  )
}

function ChannelBadges({ channels }: { channels: string[] }) {
  if (!_.isArray(channels) || channels.length <= 1) return null
  return (
    <div className="flex -ml-0.5">
      {channels.slice(0, 4).map((ch, i) => (
        <span key={ch}
          className="w-3.5 h-3.5 rounded-[3px] flex items-center justify-center border border-surface"
          style={{ background: channelColor(ch), marginLeft: i > 0 ? -3 : 0, zIndex: channels.length - i }}
        >
          <ChannelLogo channel={ch} size={8} color={isLightBrandColor(channelColor(ch)) ? 'var(--color-black)' : 'var(--color-white)'} />
        </span>
      ))}
    </div>
  )
}

function ConversationRow({ c, active, onSelect, onContextMenu, circleColors, activeCircleColor }: {
  c: ConversationPreview; active: boolean
  onSelect: (id: string) => void
  onContextMenu: (convo: ConversationPreview, x: number, y: number) => void
  circleColors?: Map<string, string[]>
  activeCircleColor?: string
}) {
  const isGroup = c.lastMessage.message_type === 'group'
  const clr = channelColor(c.lastMessage.channel)
  const hasUnread = c.unreadCount > 0 || c.markedUnread
  const isOutbound = c.lastMessage.direction === 'outbound'
  const prevLine = prevInboundText(c)
  const isPinned = _.isString(c.pinnedAt)
  const senderPrefix = isGroup && _.isString(c.lastMessage.sender_name)
    ? `${c.lastMessage.sender_name.split(' ')[0]}: `
    : ''
  const personColors = _.isString(activeCircleColor) ? [activeCircleColor] : (circleColors?.get(c.person.id) ?? [])
  const gradient = circleGradient(personColors)

  return (
    <div
      onClick={() => onSelect(c.person.id)}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(c, e.clientX, e.clientY) }}
      className="conv-row"
      data-active={active}
    >
      <div
        className={`relative w-[42px] h-[42px] shrink-0${gradient ? ` circle-ring${isGroup ? ' circle-ring--square' : ''}` : ''}`}
        style={gradient ? { '--circle-gradient': gradient } as React.CSSProperties : undefined}
      >
        {c.person.avatar_url
          ? <img src={c.person.avatar_url} alt="" className="w-[42px] h-[42px] rounded-full object-cover" />
          : <div className={`avatar avatar--2xl ${avatarCls(c.person.id)} ${isGroup ? 'rounded-[10px]' : ''}`}>
              {isGroup ? <Users size={18} /> : initials(c.person.display_name)}
            </div>}
        <span
          className="absolute -bottom-0.5 -right-1 w-4 h-4 rounded-[3px] flex items-center justify-center"
          style={{ background: clr }}
        >
          <ChannelLogo channel={c.lastMessage.channel} size={10} color={isLightBrandColor(clr) ? 'var(--color-black)' : 'var(--color-white)'} />
        </span>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          <span className={`flex-1 text-base truncate ${hasUnread || active ? 'font-semibold text-text-primary' : 'font-normal text-text-muted'}`}>
            {c.person.display_name}
          </span>
          <ChannelBadges channels={c.channels} />
          {isPinned && <Pin size={11} className="text-text-pending shrink-0" />}
          <span className="text-xs text-text-pending shrink-0">
            {relativeTime(c.lastMessage.sent_at)}
          </span>
        </div>

        {prevLine && (
          <div className="text-sm text-text-pending truncate">
            {prevLine}
          </div>
        )}

        <div className="flex items-center gap-1">
          <span className={`flex-1 text-md truncate ${isOutbound ? 'text-text-secondary' : 'text-text-muted'}`}>
            {isOutbound && (
              <span className={`inline-flex items-center mr-[3px] align-middle ${c.lastMessage.seen ? 'text-link' : 'text-text-pending'}`}>
                {c.lastMessage.seen
                  ? <CheckCheck size={13} />
                  : c.lastMessage.delivered
                    ? <CheckCheck size={13} />
                    : <Check size={13} />}
              </span>
            )}
            {isOutbound ? `You: ${previewText(c)}` : senderPrefix + previewText(c)}
          </span>
          {hasUnread && (
            <span className="w-2 h-2 rounded-full bg-danger shrink-0" />
          )}
        </div>
      </div>
    </div>
  )
}

function GatekeeperSection({ pending, userId, onSelect, selectedId, expanded }: {
  pending: ConversationPreview[]; userId?: string
  onSelect: (id: string) => void; selectedId: string | null; expanded: boolean
}) {
  const visible = expanded ? pending : pending.slice(0, 3)
  const hasMore = pending.length > 3
  const setActiveView = useInboxStore((s) => s.setActiveView)

  return (
    <div className="gatekeeper">
      <div className="gatekeeper-header">
        <span className="gatekeeper-label">
          New Senders
          <span className="gatekeeper-badge">{pending.length}</span>
        </span>
        {hasMore && (
          <button
            className="gatekeeper-toggle"
            onClick={() => setActiveView(expanded ? 'inbox' : 'screener')}
          >
            {expanded ? 'Show less' : 'Show all'}
            {!expanded && <ChevronRight size={12} />}
          </button>
        )}
      </div>
      <div className="gatekeeper-list">
        {visible.map((c) => (
          <GatekeeperCard
            key={c.person.id}
            c={c}
            active={selectedId === c.person.id}
            onSelect={onSelect}
            userId={userId}
          />
        ))}
      </div>
    </div>
  )
}

function GatekeeperCard({ c, active, onSelect, userId }: {
  c: ConversationPreview; active: boolean; onSelect: (id: string) => void; userId?: string
}) {
  const approve = useApprovePerson(userId)
  const block = useBlockPerson(userId)
  const clr = channelColor(c.lastMessage.channel)

  return (
    <div
      className="gatekeeper-card"
      data-active={active}
      onClick={() => onSelect(c.person.id)}
    >
      <div className="relative w-9 h-9 shrink-0">
        {c.person.avatar_url
          ? <img src={c.person.avatar_url} alt="" className="w-9 h-9 rounded-full object-cover" />
          : <div className={`avatar w-9 h-9 text-md ${avatarCls(c.person.id)}`}>{initials(c.person.display_name)}</div>}
        <span
          className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-[3px] flex items-center justify-center"
          style={{ background: clr }}
        >
          <ChannelLogo channel={c.lastMessage.channel} size={8} color={isLightBrandColor(clr) ? 'var(--color-black)' : 'var(--color-white)'} />
        </span>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          <span className="text-base font-medium text-text-primary truncate flex-1">
            {c.person.display_name}
          </span>
          <ChannelBadges channels={c.channels} />
        </div>
        <span className="block text-sm text-text-muted truncate">
          {previewText(c)}
        </span>
      </div>

      <div className="gatekeeper-actions">
        <button
          className="gatekeeper-accept"
          onClick={(e) => { e.stopPropagation(); approve.mutate(c.person.id) }}
          title="Accept"
        >
          <Check size={14} />
        </button>
        <button
          className="gatekeeper-block"
          onClick={(e) => { e.stopPropagation(); block.mutate(c.person.id) }}
          title="Block"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}

function BlockedRow({ c, userId }: { c: ConversationPreview; userId?: string }) {
  const approve = useApprovePerson(userId)
  const clr = channelColor(c.lastMessage.channel)

  return (
    <div className="blocked-row">
      <div className="relative w-9 h-9 shrink-0 opacity-60">
        {c.person.avatar_url
          ? <img src={c.person.avatar_url} alt="" className="w-9 h-9 rounded-full object-cover grayscale" />
          : <div className={`avatar w-9 h-9 text-md ${avatarCls(c.person.id)}`}>{initials(c.person.display_name)}</div>}
        <span
          className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-[3px] flex items-center justify-center"
          style={{ background: clr }}
        >
          <ChannelLogo channel={c.lastMessage.channel} size={8} color={isLightBrandColor(clr) ? 'var(--color-black)' : 'var(--color-white)'} />
        </span>
      </div>

      <div className="flex-1 min-w-0">
        <span className="text-base text-text-muted truncate block">
          {c.person.display_name}
        </span>
        <span className="block text-sm text-text-pending truncate">
          {previewText(c)}
        </span>
      </div>

      <button
        className="blocked-unblock-btn"
        onClick={() => approve.mutate(c.person.id)}
      >
        Unblock
      </button>
    </div>
  )
}

function FlaggedRow({ f, active, onSelect, circleColors }: {
  f: FlaggedMessage; active: boolean; onSelect: (personId: string, messageId: string) => void
  circleColors?: Map<string, string[]>
}) {
  const clr = channelColor(f.channel)
  const body = _.isString(f.subject) && f.subject.trim()
    ? cleanPreviewText(f.subject).slice(0, 60)
    : _.isString(f.bodyText)
      ? cleanPreviewText(f.bodyText).slice(0, 60)
      : 'Flagged message'
  const personColors = circleColors?.get(f.personId) ?? []
  const gradient = circleGradient(personColors)

  return (
    <div
      onClick={() => onSelect(f.personId, f.messageId)}
      className="conv-row"
      data-active={active}
    >
      <div
        className={`relative w-[42px] h-[42px] shrink-0${gradient ? ' circle-ring' : ''}`}
        style={gradient ? { '--circle-gradient': gradient } as React.CSSProperties : undefined}
      >
        {f.avatarUrl
          ? <img src={f.avatarUrl} alt="" className="w-[42px] h-[42px] rounded-full object-cover" />
          : <div className={`avatar avatar--2xl ${avatarCls(f.personId)}`}>
              {initials(f.displayName)}
            </div>}
        <span
          className="absolute -bottom-0.5 -right-1 w-4 h-4 rounded-[3px] flex items-center justify-center"
          style={{ background: clr }}
        >
          <ChannelLogo channel={f.channel} size={10} color={isLightBrandColor(clr) ? 'var(--color-black)' : 'var(--color-white)'} />
        </span>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          <span className={`flex-1 text-base truncate ${active ? 'font-semibold text-text-primary' : 'font-normal text-text-muted'}`}>
            {f.displayName}
          </span>
          <Flag size={11} className="text-warning shrink-0" fill="currentColor" />
          <span className="text-xs text-text-pending shrink-0">
            {relativeTime(f.flaggedAt)}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="flex-1 text-md truncate text-text-muted">
            {body}
          </span>
        </div>
      </div>
    </div>
  )
}

function ConversationContextMenu({ convo, x, y, circles, userId, onClose }: {
  convo: ConversationPreview; x: number; y: number
  circles: import('../../types').Circle[]
  userId?: string
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const addToCircle = useAddToCircle(userId)
  const removeFromCircle = useRemoveFromCircle(userId)
  const block = useBlockPerson(userId)
  const deselect = useInboxStore((s) => s.selectPerson)
  const markUnread = useInboxStore((s) => s.markPersonUnread)
  const markRead = useInboxStore((s) => s.markConversationRead)
  const pinAction = useInboxStore((s) => s.pinPerson)

  const personId = convo.person.id
  const hasUnread = convo.unreadCount > 0 || convo.markedUnread
  const isPinned = _.isString(convo.pinnedAt)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div ref={ref}
      className="fixed z-[400] bg-context-bg border border-border rounded-[6px] p-1 min-w-[180px] shadow-context"
      style={{ left: x, top: y }}
    >
      <div
        className="flex items-center gap-1.5 py-1.5 px-2.5 rounded-sm cursor-pointer text-text-body"
        onClick={() => {
          if (_.isString(userId)) {
            if (hasUnread) {
              markUnread(userId, personId, false)
              if (convo.unreadCount > 0) markRead(userId, personId)
            } else {
              markUnread(userId, personId, true)
            }
          }
          onClose()
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--hover-accent-subtle)' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
      >
        <BellDot size={14} />
        <span className="text-md">{hasUnread ? 'Mark as read' : 'Mark as unread'}</span>
      </div>

      <div
        className="flex items-center gap-1.5 py-1.5 px-2.5 rounded-sm cursor-pointer text-text-body"
        onClick={() => {
          if (_.isString(userId)) pinAction(userId, personId, !isPinned)
          onClose()
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--hover-accent-subtle)' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
      >
        <Pin size={14} />
        <span className="text-md">{isPinned ? 'Unpin' : 'Pin'}</span>
      </div>

      <div className="context-sep" />

      <p className="text-xs font-bold text-text-pending py-1 px-2 uppercase tracking-[.05em]">
        Circles
      </p>
      {circles.length === 0 && (
        <p className="text-sm text-text-pending py-1.5 px-2.5">No circles yet — create one in the sidebar</p>
      )}
      {circles.map((c) => (
        <div key={c.id}
          className="flex items-center justify-between py-1.5 px-2.5 rounded-sm cursor-pointer gap-2"
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--hover-accent-subtle)' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
        >
          <div className="flex items-center gap-1.5 flex-1"
            onClick={() => { addToCircle.mutate({ circleId: c.id, personId }); onClose() }}>
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: c.color ?? 'var(--color-accent)' }} />
            <span className="text-md text-text-body">{c.emoji && `${c.emoji} `}{c.name}</span>
          </div>
          <span
            title="Remove from circle"
            onClick={(e) => { e.stopPropagation(); removeFromCircle.mutate({ circleId: c.id, personId }); onClose() }}
            className="text-xs text-text-pending cursor-pointer px-0.5"
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--color-danger)' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--color-text-pending)' }}
          >✕</span>
        </div>
      ))}
      <div className="context-sep" />
      <div
        className="flex items-center gap-1.5 py-1.5 px-2.5 rounded-sm cursor-pointer text-danger"
        onClick={() => { block.mutate(personId); deselect(null); onClose() }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--hover-danger-strong)' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
      >
        <ShieldOff size={14} />
        <span className="text-md font-medium">Block</span>
      </div>
    </div>
  )
}

function Empty({ children }: { children: string }) {
  return <p className="text-center py-8 text-text-muted text-base">{children}</p>
}

function InboxSkeleton() {
  return (
    <>
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="inbox-skeleton-row">
          <div className="skeleton w-[42px] h-[42px] rounded-full shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <div className="skeleton h-3.5 rounded-sm flex-1" style={{ maxWidth: `${60 + (i % 3) * 15}%` }} />
              <div className="skeleton h-2.5 rounded-sm w-8 shrink-0" />
            </div>
            <div className="skeleton h-2.5 rounded-sm mb-1" style={{ width: `${40 + (i % 4) * 12}%` }} />
            <div className="skeleton h-2.5 rounded-sm" style={{ width: `${55 + (i % 3) * 10}%` }} />
          </div>
        </div>
      ))}
    </>
  )
}
