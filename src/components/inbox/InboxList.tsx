import { useState, useRef, useEffect } from 'react'
import _ from 'lodash'
import { useAuth } from '../../lib/auth'
import { useInboxStore, useFilterStore, viewToRpcParams, type ActiveView } from '../../stores/inboxStore'
import { useRealtimeConnected } from '../../lib/realtimeContext'
import { useConversations } from '../../hooks/useConversations'
import { useFlaggedMessages } from '../../hooks/useFlaggedMessages'
import {
  useCircles, useApprovePerson, useBlockPerson, useAddToCircle, useRemoveFromCircle, usePersonCircleColors,
} from '../../hooks/useCircles'
import { useOpenContextsByPerson, type PersonOpenContext } from '../../hooks/useThreadContext'
import {
  Check, CheckCheck, Users, X, ShieldOff, Pin, BellDot, Flag, HelpCircle,
} from 'lucide-react'
import {
  channelColor, channelLabel, relativeTime, initials, avatarCls,
  cleanPreviewText, circleGradient, isLightBrandColor,
} from '../../utils'
import { ChannelLogo } from '../icons/ChannelLogo'
import { AvatarImage } from '../AvatarImage'
import type { ConversationPreview, FlaggedMessage, ThreadState, Channel } from '../../types'

const REACTION_PREVIEW_RE = /^\{\{[^}]+\}\}\s*reacted\s+/

const STATE_LABEL: Record<ThreadState, string> = {
  my_turn:    'My Turn',
  their_turn: 'Their Turn',
  gate:       'Gate',
}

function headingFor({
  view, circleName, channel,
}: {
  view: ActiveView
  circleName: string | null
  channel: Channel | 'all'
}): string {
  if (view === 'blocked') return 'Blocked'
  const parts: string[] = []
  if (view === 'flagged') parts.push('Action items')
  else if (view === 'all') parts.push('All')
  else if (view === 'gate') parts.push('Gate')
  else parts.push(STATE_LABEL[view as ThreadState])
  if (circleName) parts.push(circleName)
  if (channel !== 'all') parts.push(channelLabel(channel))
  return parts.join(' · ')
}

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
  const [query, setQuery] = useState('')

  const { data: circles = [] } = useCircles(user?.id)
  const { data: circleColors } = usePersonCircleColors(user?.id)
  const { data: openContexts } = useOpenContextsByPerson(user?.id)
  const activeCircle = activeCircleId ? circles.find((c) => c.id === activeCircleId) : null
  const activeCircleName = activeCircle?.name ?? (activeCircleId ? 'Circle' : null)

  const [showAddPeople, setShowAddPeople] = useState(false)
  const [rowContextMenu, setRowContextMenu] = useState<{ convo: ConversationPreview; x: number; y: number } | null>(null)

  const isFlagged = activeView === 'flagged'
  const isBlocked = activeView === 'blocked'
  const isGate    = activeView === 'gate'

  const { status: rpcStatus, state: rpcState } = viewToRpcParams(activeView)

  const { data: convos = [], isLoading, error } = useConversations(
    isFlagged ? undefined : user?.id,
    rtConnected,
    rpcStatus,
    activeCircleId,
    rpcState,
  )
  const { data: flaggedAll = [], isLoading: flaggedLoading } = useFlaggedMessages(
    isFlagged ? user?.id : undefined,
  )

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

  const flaggedVisible = isFlagged
    ? flaggedAll.filter((f) => ch === 'all' || f.channel === ch)
    : []

  const heading = headingFor({ view: activeView, circleName: activeCircleName, channel: ch })
  const total = isFlagged ? flaggedVisible.length : deduped.length

  const showEmptyState =
    !isLoading && !error && !isFlagged && deduped.length === 0 && !showAddPeople

  return (
    <div className="inbox-panel">
      <div className="inbox-search-bar">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a conversation"
          className="inbox-search-input"
        />
      </div>

      <div className="section-header">
        <div>
          {heading}
          {total > 0 && (
            <span className="text-xs font-normal normal-case tracking-normal text-text-pending ml-1.5">
              {total}
            </span>
          )}
        </div>
        {!isBlocked && !isFlagged && (
          <div className="flex gap-1 items-center">
            {activeCircleId && (
              <button
                onClick={() => setShowAddPeople((v) => !v)}
                title="Add people to circle"
                className="triage-pill triage-pill--icon normal-case tracking-normal"
                data-active={showAddPeople ? 'true' : 'false'}
                aria-label="Add people"
              >+</button>
            )}
            <FilterPill active={readFilter === 'all'} onClick={() => setReadFilter('all')}>All</FilterPill>
            <FilterPill active={readFilter === 'unread'} onClick={() => setReadFilter('unread')}>Unread</FilterPill>
          </div>
        )}
      </div>

      <div className="thin-scroll flex-1 min-h-0 px-2 pb-2">
        {isFlagged ? (
          <>
            {flaggedLoading && flaggedVisible.length === 0 && <InboxSkeleton />}
            {!flaggedLoading && flaggedVisible.length === 0 && <EmptyState view="flagged" />}
            {flaggedVisible
              .filter((f) => !query || f.displayName.toLowerCase().includes(query.toLowerCase()))
              .map((f) => (
                <FlaggedRow
                  key={f.messageId}
                  f={f}
                  active={focusMsg === f.messageId}
                  onSelect={(personId, messageId) => pick(personId, messageId)}
                  circleColors={circleColors}
                />
              ))}
          </>
        ) : isBlocked ? (
          <>
            {isLoading && deduped.length === 0 && <InboxSkeleton />}
            {!isLoading && deduped.length === 0 && <EmptyState view="blocked" />}
            {deduped.map((c) => <BlockedRow key={c.person.id} c={c} userId={user?.id} />)}
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
            {isLoading && deduped.length === 0 && <InboxSkeleton />}
            {!isLoading && error && deduped.length === 0 && (
              <div className="inbox-empty">Error loading conversations</div>
            )}
            {showEmptyState && (
              activeCircleId ? (
                <div className="inbox-empty">
                  <p>No one in this circle yet</p>
                  <button
                    onClick={() => setShowAddPeople(true)}
                    className="btn-primary btn-primary-sm"
                  >+ Add people</button>
                </div>
              ) : (
                <EmptyState view={activeView} />
              )
            )}

            {isGate
              ? deduped.map((c) => (
                  <GatekeeperCard
                    key={c.person.id}
                    c={c}
                    active={sel === c.person.id}
                    onSelect={pick}
                    userId={user?.id}
                  />
                ))
              : (
                <>
                  {pinned.map((c) => (
                    <ConversationRow
                      key={c.person.id} c={c} active={sel === c.person.id} onSelect={pick}
                      onContextMenu={(convo, x, y) => setRowContextMenu({ convo, x, y })}
                      circleColors={circleColors} activeCircleColor={activeCircle?.color}
                      context={openContexts?.get(c.person.id)}
                      showStateBadge
                    />
                  ))}
                  {pinned.length > 0 && unpinned.length > 0 && (
                    <div className="h-px bg-border mx-1 my-1" />
                  )}
                  {unpinned.map((c) => (
                    <ConversationRow
                      key={c.person.id} c={c} active={sel === c.person.id} onSelect={pick}
                      onContextMenu={(convo, x, y) => setRowContextMenu({ convo, x, y })}
                      circleColors={circleColors} activeCircleColor={activeCircle?.color}
                      context={openContexts?.get(c.person.id)}
                      showStateBadge
                    />
                  ))}
                </>
              )
            }
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

function EmptyState({ view }: { view: ActiveView }) {
  const msg = (() => {
    switch (view) {
      case 'all':        return 'No conversations.'
      case 'my_turn':    return 'Inbox zero. You owe no one a reply.'
      case 'their_turn': return 'You\u2019re waiting on no one right now.'
      case 'gate':       return 'No new senders waiting.'
      case 'blocked':    return 'No blocked contacts.'
      case 'flagged':    return 'No flagged messages.'
      default:           return 'No conversations.'
    }
  })()
  return <div className="inbox-empty">{msg}</div>
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
        <button onClick={onClose} className="text-text-pending text-xl leading-none px-1">✕</button>
      </div>

      <div className="thin-scroll flex-1 min-h-0">
        {isLoading && <p className="text-text-pending text-md py-3">Loading…</p>}
        {filtered.map((c) => {
          const isMember = inCircleIds.has(c.person.id) || addedIds.has(c.person.id)
          return (
            <div key={c.person.id} className="conv-row" onClick={() => handleToggle(c.person.id)}>
              <AvatarImage
                src={c.person.avatar_url}
                className="w-8 h-8 rounded-full object-cover shrink-0"
                fallback={<div className={`avatar avatar--lg ${avatarCls(c.person.id)}`}>{initials(c.person.display_name)}</div>}
              />
              <span className="flex-1 text-base text-text-body truncate">{c.person.display_name}</span>
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
    <div className="channel-badge-stack">
      {channels.slice(0, 4).map((ch, i) => (
        <span key={ch}
          style={{ background: channelColor(ch), marginLeft: i > 0 ? -3 : 0, zIndex: channels.length - i }}
        >
          <ChannelLogo channel={ch} size={8} color={isLightBrandColor(channelColor(ch)) ? 'var(--color-black)' : 'var(--color-white)'} />
        </span>
      ))}
    </div>
  )
}

function StateChip({ state }: { state: ThreadState }) {
  if (state === 'their_turn') return null
  return <span className="state-chip" data-state={state}>{STATE_LABEL[state]}</span>
}

function ConversationRow({ c, active, onSelect, onContextMenu, circleColors, activeCircleColor, showStateBadge, context }: {
  c: ConversationPreview; active: boolean
  onSelect: (id: string) => void
  onContextMenu: (convo: ConversationPreview, x: number, y: number) => void
  circleColors?: Map<string, string[]>
  activeCircleColor?: string
  showStateBadge?: boolean
  context?: PersonOpenContext
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
        <AvatarImage
          src={c.person.avatar_url}
          className="w-[42px] h-[42px] rounded-full object-cover"
          fallback={
            <div className={`avatar avatar--2xl ${avatarCls(c.person.id)} ${isGroup ? 'avatar--group' : ''}`}>
              {isGroup ? <Users size={18} /> : initials(c.person.display_name)}
            </div>
          }
        />
        <span className="channel-chip channel-chip--md" style={{ background: clr }}>
          <ChannelLogo channel={c.lastMessage.channel} size={10} color={isLightBrandColor(clr) ? 'var(--color-black)' : 'var(--color-white)'} />
        </span>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          <span className={`flex-1 text-base truncate ${hasUnread || active ? 'font-semibold text-text-primary' : 'font-normal text-text-muted'}`}>
            {c.person.display_name}
          </span>
          <ChannelBadges channels={c.channels} />
          {context && context.questions > 0 && (
            <span className="row-context-mark" title={`${context.questions} open question${context.questions === 1 ? '' : 's'}`}>
              <HelpCircle size={10} />
            </span>
          )}
          {isPinned && <Pin size={11} className="text-text-pending shrink-0" />}
          <span className="text-xs text-text-pending shrink-0">
            {relativeTime(c.lastMessage.sent_at)}
          </span>
        </div>

        {prevLine && (
          <div className="text-sm text-text-pending truncate">{prevLine}</div>
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
          {showStateBadge && <StateChip state={c.turnState} />}
          {hasUnread && (
            <span className="w-2 h-2 rounded-full bg-danger shrink-0" />
          )}
        </div>
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
    <div className="gatekeeper-card" data-active={active} onClick={() => onSelect(c.person.id)}>
      <div className="relative w-9 h-9 shrink-0">
        <AvatarImage
          src={c.person.avatar_url}
          className="w-9 h-9 rounded-full object-cover"
          fallback={<div className={`avatar w-9 h-9 text-md ${avatarCls(c.person.id)}`}>{initials(c.person.display_name)}</div>}
        />
        <span className="channel-chip channel-chip--sm" style={{ background: clr }}>
          <ChannelLogo channel={c.lastMessage.channel} size={8} color={isLightBrandColor(clr) ? 'var(--color-black)' : 'var(--color-white)'} />
        </span>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          <span className="text-base font-medium text-text-primary truncate flex-1">{c.person.display_name}</span>
          <ChannelBadges channels={c.channels} />
        </div>
        <span className="block text-sm text-text-muted truncate">{previewText(c)}</span>
      </div>

      <div className="gatekeeper-actions">
        <button className="gatekeeper-accept" onClick={(e) => { e.stopPropagation(); approve.mutate(c.person.id) }} title="Accept">
          <Check size={14} />
        </button>
        <button className="gatekeeper-block" onClick={(e) => { e.stopPropagation(); block.mutate(c.person.id) }} title="Block">
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
        <AvatarImage
          src={c.person.avatar_url}
          className="w-9 h-9 rounded-full object-cover grayscale"
          fallback={<div className={`avatar w-9 h-9 text-md ${avatarCls(c.person.id)}`}>{initials(c.person.display_name)}</div>}
        />
        <span className="channel-chip channel-chip--sm" style={{ background: clr }}>
          <ChannelLogo channel={c.lastMessage.channel} size={8} color={isLightBrandColor(clr) ? 'var(--color-black)' : 'var(--color-white)'} />
        </span>
      </div>

      <div className="flex-1 min-w-0">
        <span className="text-base text-text-muted truncate block">{c.person.display_name}</span>
        <span className="block text-sm text-text-pending truncate">{previewText(c)}</span>
      </div>

      <button className="blocked-unblock-btn" onClick={() => approve.mutate(c.person.id)}>Unblock</button>
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
    <div onClick={() => onSelect(f.personId, f.messageId)} className="conv-row" data-active={active}>
      <div
        className={`relative w-[42px] h-[42px] shrink-0${gradient ? ' circle-ring' : ''}`}
        style={gradient ? { '--circle-gradient': gradient } as React.CSSProperties : undefined}
      >
        <AvatarImage
          src={f.avatarUrl}
          className="w-[42px] h-[42px] rounded-full object-cover"
          fallback={<div className={`avatar avatar--2xl ${avatarCls(f.personId)}`}>{initials(f.displayName)}</div>}
        />
        <span className="channel-chip channel-chip--md" style={{ background: clr }}>
          <ChannelLogo channel={f.channel} size={10} color={isLightBrandColor(clr) ? 'var(--color-black)' : 'var(--color-white)'} />
        </span>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          <span className={`flex-1 text-base truncate ${active ? 'font-semibold text-text-primary' : 'font-normal text-text-muted'}`}>
            {f.displayName}
          </span>
          <Flag size={11} className="text-warning shrink-0" fill="currentColor" />
          <span className="text-xs text-text-pending shrink-0">{relativeTime(f.flaggedAt)}</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="flex-1 text-md truncate text-text-muted">{body}</span>
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
    <div ref={ref} className="context-menu" style={{ left: x, top: y }}>
      <div
        className="context-menu-item"
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
      >
        <BellDot size={14} />
        <span className="text-md">{hasUnread ? 'Mark as read' : 'Mark as unread'}</span>
      </div>

      <div
        className="context-menu-item"
        onClick={() => {
          if (_.isString(userId)) pinAction(userId, personId, !isPinned)
          onClose()
        }}
      >
        <Pin size={14} />
        <span className="text-md">{isPinned ? 'Unpin' : 'Pin'}</span>
      </div>

      <div className="context-sep" />

      <p className="context-menu-label">Circles</p>
      {circles.length === 0 && (
        <p className="text-sm text-text-pending py-1.5 px-2.5">No circles yet — create one in the sidebar</p>
      )}
      {circles.map((c) => (
        <div key={c.id} className="context-menu-row">
          <div className="flex items-center gap-1.5 flex-1"
            onClick={() => { addToCircle.mutate({ circleId: c.id, personId }); onClose() }}>
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: c.color ?? 'var(--color-accent)' }} />
            <span className="text-md text-text-body">{c.emoji && `${c.emoji} `}{c.name}</span>
          </div>
          <span
            title="Remove from circle"
            onClick={(e) => { e.stopPropagation(); removeFromCircle.mutate({ circleId: c.id, personId }); onClose() }}
            className="context-menu-row-close"
          >✕</span>
        </div>
      ))}
      <div className="context-sep" />
      <div
        className="context-menu-item"
        data-danger="true"
        onClick={() => { block.mutate(personId); deselect(null); onClose() }}
      >
        <ShieldOff size={14} />
        <span className="text-md font-medium">Block</span>
      </div>
    </div>
  )
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
