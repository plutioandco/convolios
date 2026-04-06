import { useState } from 'react'

const channels = [
  { id: 'all', label: 'All', icon: '📥' },
  { id: 'whatsapp', label: 'WhatsApp', icon: '💬' },
  { id: 'linkedin', label: 'LinkedIn', icon: '💼' },
  { id: 'instagram', label: 'Instagram', icon: '📷' },
  { id: 'telegram', label: 'Telegram', icon: '✈️' },
  { id: 'email', label: 'Email', icon: '📧' },
  { id: 'x', label: 'X / Twitter', icon: '𝕏' },
  { id: 'slack', label: 'Slack', icon: '💬' },
  { id: 'clickup', label: 'ClickUp', icon: '✅' },
]

export function Sidebar() {
  const [active, setActive] = useState('all')

  return (
    <aside className="w-16 h-full flex flex-col items-center py-4 gap-1"
      style={{ backgroundColor: 'var(--bg-secondary)', borderRight: '1px solid var(--border)' }}>

      <div className="mb-4 text-xl font-bold" style={{ color: 'var(--accent)' }}>C</div>

      {channels.map(ch => (
        <button
          key={ch.id}
          onClick={() => setActive(ch.id)}
          title={ch.label}
          className="w-10 h-10 flex items-center justify-center rounded-lg text-sm transition-colors cursor-pointer"
          style={{
            backgroundColor: active === ch.id ? 'var(--bg-tertiary)' : 'transparent',
            color: active === ch.id ? 'var(--text-primary)' : 'var(--text-muted)',
          }}
        >
          {ch.icon}
        </button>
      ))}

      <div className="mt-auto">
        <button
          title="Settings"
          className="w-10 h-10 flex items-center justify-center rounded-lg text-sm cursor-pointer"
          style={{ color: 'var(--text-muted)' }}
        >
          ⚙️
        </button>
      </div>
    </aside>
  )
}
