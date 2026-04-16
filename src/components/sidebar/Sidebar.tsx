import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Settings, Plus, Pencil, Trash2, ShieldCheck, ShieldOff, Flag } from 'lucide-react'
import { useAuth } from '../../lib/auth'
import { useInboxStore } from '../../stores/inboxStore'
import { useAccountsStore } from '../../stores/accountsStore'
import { useRealtimeConnected } from '../../App'
import { useCircles, useCreateCircle, useUpdateCircle, useDeleteCircle, usePendingCount, useBlockedCount, useSidebarUnread } from '../../hooks/useCircles'
import { channelColor } from '../../utils'
import { ChannelLogo, isLightBrandColor } from '../icons/ChannelLogo'
import type { Channel } from '../../types'

const CHANNELS: { id: Channel; label: string }[] = [
  { id: 'whatsapp',  label: 'WhatsApp'  },
  { id: 'email',     label: 'Email'     },
  { id: 'linkedin',  label: 'LinkedIn'  },
  { id: 'instagram', label: 'Instagram' },
  { id: 'telegram',  label: 'Telegram'  },
  { id: 'x',         label: 'X'         },
  { id: 'imessage',  label: 'iMessage'  },
]

const CIRCLE_COLORS = ['#5865f2','#23a559','#f0b132','#ed4245','#eb459e','#00b0f4','#ff7733']

type ContextMenu = { circleId: string; x: number; y: number }

export function Sidebar() {
  const ch = useInboxStore((s) => s.activeChannel)
  const set = useInboxStore((s) => s.setActiveChannel)
  const activeView = useInboxStore((s) => s.activeView)
  const setActiveView = useInboxStore((s) => s.setActiveView)
  const activeCircleId = useInboxStore((s) => s.activeCircleId)
  const setActiveCircleId = useInboxStore((s) => s.setActiveCircleId)
  const accounts = useAccountsStore((s) => s.accounts)
  const { user } = useAuth()
  const rtConnected = useRealtimeConnected()
  const { data: circles = [] } = useCircles(user?.id)
  const { data: pendingCount = 0 } = usePendingCount(user?.id, rtConnected)
  const { data: blockedCount = 0 } = useBlockedCount(user?.id)
  const { data: unread } = useSidebarUnread(user?.id, rtConnected)
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
  const createInputRef = useRef<HTMLInputElement>(null)
  const createPopoverRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)

  const connectedChannels = new Set(
    accounts.filter((a) => a.status === 'active').map((a) => a.channel)
  )

  const go = (id: Channel | 'all') => { set(id); nav('/') }

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

  useEffect(() => { if (showCreate) createInputRef.current?.focus() }, [showCreate])
  useEffect(() => { if (renamingId) renameInputRef.current?.focus() }, [renamingId])

  useEffect(() => {
    if (!showCreate) return
    const handler = (e: MouseEvent) => {
      if (createPopoverRef.current && !createPopoverRef.current.contains(e.target as Node)) {
        setShowCreate(false)
        setCreateName('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showCreate])

  const submitCreate = useCallback(() => {
    const name = createName.trim()
    if (!name) return
    createCircle.mutate({ name, color: createColor }, {
      onSuccess: () => { setShowCreate(false); setCreateName('') },
    })
  }, [createName, createColor, createCircle])

  const submitRename = useCallback(() => {
    const name = renameValue.trim()
    if (!name || !renamingId) { setRenamingId(null); return }
    updateCircle.mutate({ id: renamingId, name }, {
      onSuccess: () => setRenamingId(null),
    })
  }, [renamingId, renameValue, updateCircle])

  const handleRightClick = (e: React.MouseEvent, circleId: string) => {
    e.preventDefault()
    setContextMenu({ circleId, x: e.clientX, y: e.clientY })
  }

  const createEnabled = createName.trim().length > 0 && !createCircle.isPending

  return (
    <>
      <nav className="sidebar-nav thin-scroll select-none">

        <GuildBtn active={activeView === 'screener' && !onSettings} bg="var(--color-danger)"
          onClick={() => { setActiveView('screener'); nav('/') }} label="Requests (Gate)"
          badge={pendingCount}>
          <ShieldCheck size={18} color="var(--color-white)" />
        </GuildBtn>

        <div className="sidebar-divider" />

        <GuildBtn active={!onSettings && activeView === 'inbox' && ch === 'all' && !activeCircleId} bg="var(--color-accent)"
          onClick={() => go('all')} label="All Messages"
          badge={unread?.total ?? 0}>
          <span className="sidebar-all-msg-mark">C</span>
        </GuildBtn>

        <div className="sidebar-divider" />

        {circles.map((c) => (
          renamingId === c.id ? (
            <div key={c.id} className="sidebar-circle-rename">
              <input
                ref={renameInputRef}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitRename()
                  if (e.key === 'Escape') setRenamingId(null)
                }}
                onBlur={submitRename}
                className="sidebar-circle-rename-input"
              />
            </div>
          ) : (
            <GuildBtn
              key={c.id}
              active={!onSettings && activeCircleId === c.id}
              bg={c.color ?? 'var(--color-accent)'}
              onClick={() => { setActiveCircleId(c.id); nav('/') }}
              onContextMenu={(e) => handleRightClick(e, c.id)}
              label={c.name}
              lightBg={isLightBrandColor(c.color ?? '#5865f2')}
              badge={unread?.circles[c.id] ?? 0}
            >
              <span className="sidebar-guild-emoji">{c.emoji ?? c.name.charAt(0).toUpperCase()}</span>
            </GuildBtn>
          )
        ))}

        <div className="sidebar-add-circle-wrap">
          <div
            title="New circle"
            onClick={() => setShowCreate((v) => !v)}
            className="sidebar-add-circle-btn"
            data-open={showCreate ? 'true' : 'false'}
          >
            <Plus size={20} />
          </div>

          {showCreate && (
            <div
              ref={createPopoverRef}
              className="sidebar-popover"
              onKeyDown={(e) => { if (e.key === 'Escape') { setShowCreate(false); setCreateName('') } }}
            >
              <p className="sidebar-popover-label">New Circle</p>
              <input
                ref={createInputRef}
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
        </div>

        {circles.length > 0 && (
          <div className="sidebar-divider sidebar-divider--after-circles" />
        )}

        {CHANNELS.filter((c) => connectedChannels.has(c.id)).map((c) => {
          const light = isLightBrandColor(channelColor(c.id))
          const chUnread = unread?.channels[c.id] ?? 0
          return (
            <GuildBtn key={c.id} active={!onSettings && activeView === 'inbox' && ch === c.id && !activeCircleId} bg={channelColor(c.id)}
              onClick={() => go(c.id)} label={c.label} lightBg={light} badge={chUnread}>
              <ChannelLogo channel={c.id} size={18} />
            </GuildBtn>
          )
        })}

        <GuildBtn active={!onSettings && activeView === 'flagged'} bg="var(--color-warning)"
          onClick={() => { setActiveView('flagged'); nav('/') }} label="Action Items">
          <Flag size={18} color={activeView === 'flagged' && !onSettings ? 'var(--color-white)' : 'var(--color-text-body)'} />
        </GuildBtn>

        <div className="sidebar-spacer" />
        <div className="sidebar-divider" />

        {blockedCount > 0 && (
          <GuildBtn active={!onSettings && activeView === 'blocked'} bg="var(--color-text-muted)"
            onClick={() => { setActiveView('blocked'); nav('/') }} label="Blocked"
            badge={blockedCount}>
            <ShieldOff size={18} color={activeView === 'blocked' && !onSettings ? 'var(--color-white)' : 'var(--color-text-body)'} />
          </GuildBtn>
        )}

        <GuildBtn active={onSettings} bg="var(--color-success)" onClick={() => nav('/settings')} label="Settings">
          <Settings size={20} color={onSettings ? 'var(--color-white)' : 'var(--color-text-body)'} />
        </GuildBtn>
      </nav>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="sidebar-context"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {(() => {
            const circle = circles.find((c) => c.id === contextMenu.circleId)
            if (!circle) return null
            return (
              <>
                <p className="sidebar-context-title">{circle.name}</p>
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
                <div className="sidebar-context-sep" />
                <ContextItem icon={<Pencil size={14} />} label="Rename"
                  onClick={() => {
                    setRenamingId(circle.id)
                    setRenameValue(circle.name)
                    setContextMenu(null)
                  }}
                />
                <div className="sidebar-context-sep" />
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
      className="sidebar-context-item"
      data-danger={danger ? 'true' : 'false'}
    >
      {icon} {label}
    </div>
  )
}

function GuildBtn({ active, bg, onClick, onContextMenu, label, children, badge, lightBg }: {
  active: boolean; bg: string; onClick: () => void; onContextMenu?: (e: React.MouseEvent) => void
  label: string; children: React.ReactNode; badge?: number; lightBg?: boolean
}) {
  const fgActive = lightBg ? 'var(--color-black)' : 'var(--color-white)'
  const fgHover = lightBg ? 'var(--color-black)' : 'var(--color-white)'
  return (
    <div
      className="guild-btn-wrap"
      style={{ '--accent': bg, '--accent-fg': fgActive, '--accent-fg-hover': fgHover } as React.CSSProperties}
      title={label}
    >
      <span className="guild-pill" data-active={active ? 'true' : 'false'} />
      <div
        className={`guild-icon ${active ? 'active' : ''}`}
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
        {children}
      </div>
      {(badge ?? 0) > 0 && <CountBadge count={badge!} />}
    </div>
  )
}

function CountBadge({ count }: { count: number }) {
  const text = count > 99 ? '99+' : String(count)
  const multi = text.length > 1
  return (
    <span className={multi ? 'guild-count-badge guild-count-badge--multi' : 'guild-count-badge guild-count-badge--single'}>{text}</span>
  )
}
