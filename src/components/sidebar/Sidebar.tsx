import { useState, useRef, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  Settings, Plus, Pencil, Trash2, Flag, ShieldOff,
  Inbox, Sparkles, Hourglass, CheckCircle2, DoorOpen,
  Search, Layers,
} from 'lucide-react'
import _ from 'lodash'
import { useAuth } from '../../lib/auth'
import { useInboxStore, type ActiveView } from '../../stores/inboxStore'
import { useAccountsStore } from '../../stores/accountsStore'
import { useRealtimeConnected } from '../../lib/realtimeContext'
import {
  useCircles, useCreateCircle, useUpdateCircle, useDeleteCircle,
  useBlockedCount, useSidebarUnread, useStateCounts,
  type StateCounts,
} from '../../hooks/useCircles'
import { useCommitmentsCount } from '../../hooks/useThreadContext'
import { channelColor, CIRCLE_COLORS } from '../../utils'
import { ChannelLogo } from '../icons/ChannelLogo'
import type { Channel, Circle } from '../../types'

type StateDescriptor = {
  id: Exclude<ActiveView, 'blocked' | 'flagged'>
  label: string
  icon: React.ComponentType<{ size?: number }>
}

// Top nav — the three views people actually live in.
const PRIMARY_STATES: StateDescriptor[] = [
  { id: 'all',        label: 'All',        icon: Inbox },
  { id: 'my_turn',    label: 'My Turn',    icon: Sparkles },
  { id: 'their_turn', label: 'Their Turn', icon: Hourglass },
]

const CHANNELS: { id: Channel; label: string }[] = [
  { id: 'whatsapp',  label: 'WhatsApp'  },
  { id: 'email',     label: 'Email'     },
  { id: 'linkedin',  label: 'LinkedIn'  },
  { id: 'instagram', label: 'Instagram' },
  { id: 'telegram',  label: 'Telegram'  },
  { id: 'x',         label: 'X'         },
  { id: 'imessage',  label: 'iMessage'  },
]

type ContextMenu = { circleId: string; x: number; y: number }

export function Sidebar() {
  const activeChannel = useInboxStore((s) => s.activeChannel)
  const setActiveChannel = useInboxStore((s) => s.setActiveChannel)
  const activeView = useInboxStore((s) => s.activeView)
  const setActiveView = useInboxStore((s) => s.setActiveView)
  const activeCircleId = useInboxStore((s) => s.activeCircleId)
  const setActiveCircleId = useInboxStore((s) => s.setActiveCircleId)
  const accounts = useAccountsStore((s) => s.accounts)
  const { user } = useAuth()
  const rtConnected = useRealtimeConnected()
  const { data: circles = [] } = useCircles(user?.id)
  const { data: stateCounts } = useStateCounts(user?.id, rtConnected)
  const { data: blockedCount = 0 } = useBlockedCount(user?.id)
  const { data: unread } = useSidebarUnread(user?.id, rtConnected)
  const { data: commitmentsCount } = useCommitmentsCount(user?.id)
  const createCircle = useCreateCircle(user?.id)
  const updateCircle = useUpdateCircle(user?.id)
  const deleteCircle = useDeleteCircle(user?.id)
  const nav = useNavigate()
  const loc = useLocation()
  const onSettings = loc.pathname === '/settings'

  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createColor, setCreateColor] = useState(CIRCLE_COLORS[0])
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const createPopoverRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const addBtnRef = useRef<HTMLButtonElement>(null)
  const [popoverPos, setPopoverPos] = useState<{ x: number; y: number } | null>(null)

  const connectedChannels = new Set(
    accounts.filter((a) => a.status === 'active').map((a) => a.channel)
  )

  useEffect(() => {
    if (!contextMenu) return
    const handler = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [contextMenu])

  useEffect(() => { if (renamingId) renameInputRef.current?.focus() }, [renamingId])

  useEffect(() => {
    if (!showCreate) return
    const handler = (e: MouseEvent) => {
      if (createPopoverRef.current && !createPopoverRef.current.contains(e.target as Node)
          && addBtnRef.current && !addBtnRef.current.contains(e.target as Node)) {
        setShowCreate(false)
        setCreateName('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showCreate])

  const toggleCreate = () => {
    if (showCreate) { setShowCreate(false); setCreateName(''); return }
    const rect = addBtnRef.current?.getBoundingClientRect()
    if (rect) setPopoverPos({ x: rect.right + 8, y: rect.top })
    setShowCreate(true)
  }

  const submitCreate = () => {
    const name = createName.trim()
    if (!name) return
    createCircle.mutate({ name, color: createColor }, {
      onSuccess: () => { setShowCreate(false); setCreateName('') },
    })
  }

  const submitRename = () => {
    const name = renameValue.trim()
    if (!name || !renamingId) { setRenamingId(null); return }
    updateCircle.mutate({ id: renamingId, name }, {
      onSuccess: () => setRenamingId(null),
    })
  }

  const handleCircleContext = (e: React.MouseEvent, circleId: string) => {
    e.preventDefault()
    setContextMenu({ circleId, x: e.clientX, y: e.clientY })
  }

  const selectState = (view: ActiveView) => {
    setActiveView(view)
    if (onSettings) nav('/')
  }

  // Library views (Gate, Action items, Snoozed, Blocked) are "reset-and-view"
  // entries — they snap channel + circle filters back to All so the user sees
  // every item in that context, then can narrow from there.
  const selectLibraryView = (view: ActiveView) => {
    setActiveView(view)
    setActiveChannel('all')
    setActiveCircleId(null)
    if (onSettings) nav('/')
  }

  const selectChannel = (id: Channel | 'all') => {
    setActiveChannel(id)
    if (onSettings) nav('/')
  }

  const selectCircle = (id: string | null) => {
    setActiveCircleId(id)
    if (onSettings) nav('/')
  }

  const createEnabled = createName.trim().length > 0 && !createCircle.isPending
  // The inbox route is mounted (not on settings). Primary state rows ("All",
  // "My Turn", "Their Turn") use this + activeView matching to light up.
  const onInbox = !onSettings
  // Views where the channel filter is meaningful — blocked ignores it; every
  // other view (including Action items / Gate / Snoozed) now respects it.
  const channelFilterInUse = onInbox && activeView !== 'blocked'
  // Views where the circle filter is meaningful — action items and blocked
  // don't currently filter by circle.
  const circleFilterInUse = onInbox
    && activeView !== 'blocked'
    && activeView !== 'flagged'

  const openSearch = () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
  }

  return (
    <>
      <nav className="nav-sidebar">
        <div className="nav-brand">
          <span className="avatar avatar--sm av-1">C</span>
          <span className="nav-brand-title">Convolios</span>
        </div>

        <button className="nav-search" onClick={openSearch} type="button">
          <Search size={14} />
          <span>Search…</span>
          <span className="nav-search-kbd">⌘K</span>
        </button>

        <div className="nav-scroll thin-scroll">
          <div className="nav-section">
            {PRIMARY_STATES.map((s) => {
              const count = s.id === 'all'
                ? (unread?.total ?? 0)
                : (stateCounts?.[s.id as keyof StateCounts] ?? 0)
              const isActive = onInbox && activeView === s.id
              return (
                <button
                  key={s.id}
                  type="button"
                  className="nav-item"
                  data-active={isActive ? 'true' : 'false'}
                  onClick={() => {
                    selectState(s.id)
                    if (s.id === 'all') { setActiveCircleId(null); setActiveChannel('all') }
                  }}
                >
                  <span className="nav-item-icon">
                    <s.icon size={14} />
                  </span>
                  <span className="nav-item-label">{s.label}</span>
                  {count > 0 && (
                    <span className="nav-item-count" data-state={s.id !== 'all' ? s.id : undefined}>{count}</span>
                  )}
                </button>
              )
            })}
          </div>

          <div className="nav-section">
            <div className="nav-section-header">
              <span>Circles</span>
              <button
                ref={addBtnRef}
                type="button"
                className="nav-section-action"
                onClick={toggleCreate}
                title="New circle"
              >
                <Plus size={12} />
              </button>
            </div>

            {circles.map((c) => {
              if (renamingId === c.id) {
                return (
                  <div key={c.id} className="nav-item" data-active="true">
                    <span className="nav-circle-dot" style={{ ['--dot-bg' as string]: c.color ?? 'var(--color-accent)' }} />
                    <input
                      ref={renameInputRef}
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitRename()
                        if (e.key === 'Escape') setRenamingId(null)
                      }}
                      onBlur={submitRename}
                      className="nav-rename-input"
                    />
                  </div>
                )
              }
              const isActive = circleFilterInUse && activeCircleId === c.id
              const count = unread?.circles[c.id] ?? 0
              return (
                <button
                  key={c.id}
                  type="button"
                  className="nav-item"
                  data-active={isActive ? 'true' : 'false'}
                  onClick={() => selectCircle(c.id)}
                  onContextMenu={(e) => handleCircleContext(e, c.id)}
                >
                  {_.isString(c.emoji) && c.emoji.length > 0
                    ? <span className="nav-circle-emoji">{c.emoji}</span>
                    : <span className="nav-circle-dot" style={{ ['--dot-bg' as string]: c.color ?? 'var(--color-accent)' }} />}
                  <span className="nav-item-label">{c.name}</span>
                  {count > 0 && <span className="nav-item-count">{count}</span>}
                </button>
              )
            })}
          </div>

          <div className="nav-section">
            <div className="nav-section-header"><span>Channels</span></div>
            <button
              type="button"
              className="nav-item"
              data-active={channelFilterInUse && activeChannel === 'all' ? 'true' : 'false'}
              onClick={() => selectChannel('all')}
            >
              <span className="nav-item-icon"><Layers size={14} /></span>
              <span className="nav-item-label">All channels</span>
              {(unread?.total ?? 0) > 0 && (
                <span className="nav-item-count">{unread?.total ?? 0}</span>
              )}
            </button>
            {CHANNELS.filter((c) => connectedChannels.has(c.id)).map((c) => {
              const isActive = channelFilterInUse && activeChannel === c.id
              const count = unread?.channels[c.id] ?? 0
              return (
                <button
                  key={c.id}
                  type="button"
                  className="nav-item"
                  data-active={isActive ? 'true' : 'false'}
                  onClick={() => selectChannel(c.id)}
                >
                  <span className="nav-channel-dot" style={{ ['--dot-bg' as string]: channelColor(c.id) }} />
                  <span className="nav-item-label inline-flex items-center gap-1.5">
                    <ChannelLogo channel={c.id} size={12} />
                    {c.label}
                  </span>
                  {count > 0 && <span className="nav-item-count">{count}</span>}
                </button>
              )
            })}
          </div>

          <div className="nav-section">
            <div className="nav-section-header"><span>Library</span></div>
            {(() => {
              const gateCount = stateCounts?.gate ?? 0
              const isActive = onInbox && activeView === 'gate'
              return (
                <button
                  type="button"
                  className="nav-item"
                  data-active={isActive ? 'true' : 'false'}
                  onClick={() => selectLibraryView('gate')}
                >
                  <span className="nav-item-icon"><DoorOpen size={14} /></span>
                  <span className="nav-item-label">Gate</span>
                  {gateCount > 0 && (
                    <span className="nav-item-count" data-state="gate">{gateCount}</span>
                  )}
                </button>
              )
            })()}
            <button
              type="button"
              className="nav-item"
              data-active={!onSettings && activeView === 'flagged' ? 'true' : 'false'}
              onClick={() => selectLibraryView('flagged')}
            >
              <span className="nav-item-icon"><Flag size={14} /></span>
              <span className="nav-item-label">Action items</span>
            </button>
            {(commitmentsCount?.mine ?? 0) + (commitmentsCount?.questions ?? 0) > 0 && (
              <div className="nav-item" data-active="false" title="Open commitments">
                <span className="nav-item-icon"><CheckCircle2 size={14} /></span>
                <span className="nav-item-label">Commitments</span>
                <span className="nav-item-count">
                  {(commitmentsCount?.mine ?? 0) + (commitmentsCount?.questions ?? 0)}
                </span>
              </div>
            )}
            {blockedCount > 0 && (
              <button
                type="button"
                className="nav-item"
                data-active={!onSettings && activeView === 'blocked' ? 'true' : 'false'}
                onClick={() => selectLibraryView('blocked')}
              >
                <span className="nav-item-icon"><ShieldOff size={14} /></span>
                <span className="nav-item-label">Blocked</span>
                <span className="nav-item-count">{blockedCount}</span>
              </button>
            )}
          </div>
        </div>

        <div className="nav-footer">
          <span className="avatar avatar--sm av-1">
            {user?.email ? user.email.charAt(0).toUpperCase() : 'U'}
          </span>
          <span className="nav-footer-name">{user?.email ?? 'Signed in'}</span>
          <button
            type="button"
            className="nav-footer-btn"
            title="Settings"
            data-active={onSettings ? 'true' : 'false'}
            onClick={() => nav('/settings')}
          >
            <Settings size={14} />
          </button>
        </div>
      </nav>

      {showCreate && popoverPos && (
        <div
          ref={createPopoverRef}
          className="sidebar-popover"
          style={{ left: popoverPos.x, top: popoverPos.y }}
          onKeyDown={(e) => { if (e.key === 'Escape') { setShowCreate(false); setCreateName('') } }}
        >
          <p className="sidebar-popover-label">New circle</p>
          <input
            autoFocus
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitCreate() }}
            placeholder="Circle name…"
            className="sidebar-popover-input"
          />
          <div className="sidebar-color-row">
            {CIRCLE_COLORS.map((col) => (
              <div
                key={col}
                onClick={() => setCreateColor(col)}
                className="sidebar-color-swatch"
                data-selected={createColor === col ? 'true' : 'false'}
                style={{ background: col }}
              />
            ))}
          </div>
          <button
            onClick={submitCreate}
            disabled={!createEnabled}
            className="sidebar-popover-submit"
            data-enabled={createEnabled ? 'true' : 'false'}
          >
            {createCircle.isPending ? 'Creating…' : 'Create circle'}
          </button>
        </div>
      )}

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="context-menu context-menu--sidebar"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {(() => {
            const circle = circles.find((c: Circle) => c.id === contextMenu.circleId)
            if (!circle) return null
            return (
              <>
                <p className="context-menu-label">{circle.name}</p>
                <div className="sidebar-color-row px-2 py-1 mb-0">
                  {CIRCLE_COLORS.map((col) => (
                    <div
                      key={col}
                      onClick={() => {
                        updateCircle.mutate({ id: circle.id, color: col })
                        setContextMenu(null)
                      }}
                      className="sidebar-color-swatch"
                      data-selected={circle.color === col ? 'true' : 'false'}
                      style={{ background: col }}
                    />
                  ))}
                </div>
                <div className="context-sep" />
                <ContextItem icon={<Pencil size={14} />} label="Rename"
                  onClick={() => {
                    setRenamingId(circle.id)
                    setRenameValue(circle.name)
                    setContextMenu(null)
                  }}
                />
                <div className="context-sep" />
                <ContextItem icon={<Trash2 size={14} />} label="Delete circle" danger
                  onClick={() => {
                    deleteCircle.mutate(circle.id)
                    setContextMenu(null)
                    if (activeCircleId === circle.id) setActiveCircleId(null)
                  }}
                />
              </>
            )
          })()}
        </div>
      )}
    </>
  )
}

function ContextItem({ icon, label, danger, onClick }: { icon: React.ReactNode; label: string; danger?: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      className="context-menu-item"
      data-danger={danger ? 'true' : 'false'}
    >
      {icon} {label}
    </div>
  )
}
