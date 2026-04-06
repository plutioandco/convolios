const mockConversations = [
  { id: '1', name: 'Alex Chen', channel: 'whatsapp', message: 'Hey, checking in on the contract...', time: '2m ago', unread: true },
  { id: '2', name: 'Sarah Kim', channel: 'linkedin', message: 'Thanks for the intro — let\'s schedule...', time: '15m ago', unread: true },
  { id: '3', name: 'Dev Team', channel: 'slack', message: 'Deployed v2.1 to staging ✅', time: '1h ago', unread: false },
  { id: '4', name: 'Jordan Lee', channel: 'email', message: 'Re: Partnership proposal — attached...', time: '2h ago', unread: false },
  { id: '5', name: 'Maria Santos', channel: 'instagram', message: 'Loved your last post! Quick question...', time: '3h ago', unread: false },
  { id: '6', name: 'Taskbot', channel: 'clickup', message: 'Sprint review due tomorrow', time: '4h ago', unread: false },
]

const channelBadge: Record<string, string> = {
  whatsapp: '💬',
  linkedin: '💼',
  instagram: '📷',
  telegram: '✈️',
  email: '📧',
  x: '𝕏',
  slack: '🔗',
  clickup: '✅',
}

export function InboxList() {
  return (
    <div className="h-full flex flex-col" style={{ width: 320, borderRight: '1px solid var(--border)' }}>
      <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border)' }}>
        <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Inbox</h2>
        <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: 'var(--accent)', color: '#fff' }}>
          2 new
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {mockConversations.map(conv => (
          <div
            key={conv.id}
            className="px-4 py-3 cursor-pointer transition-colors hover:bg-[var(--bg-tertiary)]"
            style={{ borderBottom: '1px solid var(--border)' }}
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs">{channelBadge[conv.channel]}</span>
              <span className="text-sm font-medium flex-1" style={{
                color: conv.unread ? 'var(--text-primary)' : 'var(--text-secondary)'
              }}>
                {conv.name}
              </span>
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{conv.time}</span>
            </div>
            <p className="text-xs truncate" style={{
              color: conv.unread ? 'var(--text-secondary)' : 'var(--text-muted)'
            }}>
              {conv.message}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}
