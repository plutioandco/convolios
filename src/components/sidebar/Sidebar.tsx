import { useNavigate, useLocation } from 'react-router-dom'
import { useInboxStore } from '../../stores/inboxStore'
import { useAccountsStore } from '../../stores/accountsStore'
import { channelColor } from '../../utils'
import type { Channel } from '../../types'

const CHANNELS: { id: Channel; label: string; abbr: string }[] = [
  { id: 'whatsapp',  label: 'WhatsApp',  abbr: 'WA' },
  { id: 'email',     label: 'Email',     abbr: 'EM' },
  { id: 'linkedin',  label: 'LinkedIn',  abbr: 'LI' },
  { id: 'instagram', label: 'Instagram', abbr: 'IG' },
  { id: 'telegram',  label: 'Telegram',  abbr: 'TG' },
]

export function Sidebar() {
  const ch = useInboxStore((s) => s.activeChannel)
  const set = useInboxStore((s) => s.setActiveChannel)
  const accounts = useAccountsStore((s) => s.accounts)
  const nav = useNavigate()
  const loc = useLocation()
  const onSettings = loc.pathname === '/settings'

  const connectedChannels = new Set(
    accounts.filter((a) => a.status === 'active').map((a) => a.channel)
  )

  const go = (id: Channel | 'all') => { set(id); nav('/') }

  return (
    <nav style={{
      width: 72, height: '100%', flexShrink: 0, display: 'flex', flexDirection: 'column',
      alignItems: 'center', paddingTop: 12, paddingBottom: 12,
      background: '#1e1f22', overflowY: 'auto',
    }} className="thin-scroll select-none">

      <GuildBtn active={!onSettings && ch === 'all'} bg="#5865f2"
        onClick={() => go('all')} label="All Messages">
        <span style={{ fontSize: 18, fontWeight: 800, color: '#fff' }}>C</span>
      </GuildBtn>

      <div style={{ width: 32, height: 2, borderRadius: 1, background: 'rgba(78,80,88,.48)', margin: '4px 0' }} />

      {CHANNELS.filter((c) => connectedChannels.has(c.id)).map((c) => (
        <GuildBtn key={c.id} active={!onSettings && ch === c.id} bg={channelColor(c.id)}
          onClick={() => go(c.id)} label={c.label}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#fff' }}>{c.abbr}</span>
        </GuildBtn>
      ))}

      <div style={{ flex: 1 }} />
      <div style={{ width: 32, height: 2, borderRadius: 1, background: 'rgba(78,80,88,.48)', margin: '4px 0' }} />

      <GuildBtn active={onSettings} bg="#23a559" onClick={() => nav('/settings')} label="Settings">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style={{ color: onSettings ? '#fff' : '#dbdee1' }}>
          <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87a.48.48 0 0 0 .12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/>
        </svg>
      </GuildBtn>
    </nav>
  )
}

function GuildBtn({ active, bg, onClick, label, children }: {
  active: boolean; bg: string; onClick: () => void; label: string; children: React.ReactNode
}) {
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', marginBottom: 8 }}
      title={label}>
      {/* pill */}
      <span className="guild-pill" style={{ height: active ? 40 : 0, opacity: active ? 1 : 0, top: active ? 4 : 24 }} />
      <div className={`guild-icon ${active ? 'active' : ''}`}
        onClick={onClick}
        style={{ background: active ? bg : '#313338', color: active ? '#fff' : '#dbdee1' }}
        onMouseEnter={(e) => { if (!active) { (e.currentTarget as HTMLElement).style.background = bg; (e.currentTarget as HTMLElement).style.color = '#fff' } }}
        onMouseLeave={(e) => { if (!active) { (e.currentTarget as HTMLElement).style.background = '#313338'; (e.currentTarget as HTMLElement).style.color = '#dbdee1' } }}>
        {children}
      </div>
    </div>
  )
}
