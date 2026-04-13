import { useNavigate, useLocation } from 'react-router-dom'
import { Settings } from 'lucide-react'
import { useInboxStore } from '../../stores/inboxStore'
import { useAccountsStore } from '../../stores/accountsStore'
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

      {CHANNELS.filter((c) => connectedChannels.has(c.id)).map((c) => {
        const light = isLightBrandColor(channelColor(c.id))
        return (
          <GuildBtn key={c.id} active={!onSettings && ch === c.id} bg={channelColor(c.id)}
            onClick={() => go(c.id)} label={c.label} lightBg={light}>
            <ChannelLogo channel={c.id} size={18} />
          </GuildBtn>
        )
      })}

      <div style={{ flex: 1 }} />
      <div style={{ width: 32, height: 2, borderRadius: 1, background: 'rgba(78,80,88,.48)', margin: '4px 0' }} />

      <GuildBtn active={onSettings} bg="#23a559" onClick={() => nav('/settings')} label="Settings">
        <Settings size={20} color={onSettings ? '#fff' : '#dbdee1'} />
      </GuildBtn>
    </nav>
  )
}

function GuildBtn({ active, bg, onClick, label, children, lightBg }: {
  active: boolean; bg: string; onClick: () => void; label: string; children: React.ReactNode; lightBg?: boolean
}) {
  const fgActive = lightBg ? '#000' : '#fff'
  const fgHover = lightBg ? '#000' : '#fff'
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', marginBottom: 8 }}
      title={label}>
      {/* pill */}
      <span className="guild-pill" style={{ height: active ? 40 : 0, opacity: active ? 1 : 0, top: active ? 4 : 24 }} />
      <div className={`guild-icon ${active ? 'active' : ''}`}
        onClick={onClick}
        style={{ background: active ? bg : '#313338', color: active ? fgActive : '#dbdee1' }}
        onMouseEnter={(e) => { if (!active) { (e.currentTarget as HTMLElement).style.background = bg; (e.currentTarget as HTMLElement).style.color = fgHover } }}
        onMouseLeave={(e) => { if (!active) { (e.currentTarget as HTMLElement).style.background = '#313338'; (e.currentTarget as HTMLElement).style.color = '#dbdee1' } }}>
        {children}
      </div>
    </div>
  )
}
