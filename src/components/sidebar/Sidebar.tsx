import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import _ from 'lodash'
import { useInboxStore } from '../../stores/inboxStore'
import type { Channel } from '../../types'
import { CHANNEL_META } from '../../utils'

type SidebarItem = { id: Channel | 'all'; label: string; icon: string }

const channels: SidebarItem[] = [
  { id: 'all', label: 'All', icon: '📥' },
  ...Object.entries(CHANNEL_META).map(([id, meta]) => ({
    id: id as Channel,
    label: meta.label,
    icon: meta.icon,
  })),
]

export function Sidebar() {
  const activeChannel = useInboxStore((s) => s.activeChannel)
  const setActiveChannel = useInboxStore((s) => s.setActiveChannel)
  const navigate = useNavigate()
  const location = useLocation()
  const isSettings = location.pathname === '/settings'

  return (
    <aside className="w-16 h-full flex flex-col items-center py-4 gap-1"
      style={{ backgroundColor: 'var(--bg-secondary)', borderRight: '1px solid var(--border)' }}>

      <button
        onClick={() => navigate('/')}
        className="mb-4 text-xl font-bold cursor-pointer"
        style={{ color: 'var(--accent)' }}
      >
        C
      </button>

      {channels.map(ch => (
        <button
          key={ch.id}
          onClick={() => {
            setActiveChannel(ch.id)
            if (isSettings) navigate('/')
          }}
          title={ch.label}
          className="w-10 h-10 flex items-center justify-center rounded-lg text-sm transition-colors cursor-pointer"
          style={{
            backgroundColor: !isSettings && activeChannel === ch.id ? 'var(--bg-tertiary)' : 'transparent',
            color: !isSettings && activeChannel === ch.id ? 'var(--text-primary)' : 'var(--text-muted)',
          }}
        >
          {ch.icon}
        </button>
      ))}

      <div className="mt-auto">
        <button
          onClick={() => navigate('/settings')}
          title="Settings"
          className="w-10 h-10 flex items-center justify-center rounded-lg text-sm cursor-pointer"
          style={{
            backgroundColor: isSettings ? 'var(--bg-tertiary)' : 'transparent',
            color: isSettings ? 'var(--text-primary)' : 'var(--text-muted)',
          }}
        >
          ⚙️
        </button>
      </div>
    </aside>
  )
}
