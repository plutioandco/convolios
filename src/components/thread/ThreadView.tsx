import _ from 'lodash'
import { useInboxStore } from '../../stores/inboxStore'
import { CHANNEL_META, formatRelativeTime } from '../../utils'
import type { Channel, Message } from '../../types'

export function ThreadView() {
  const activeThread = useInboxStore((s) => s.activeThread)
  const selectedPersonId = useInboxStore((s) => s.selectedPersonId)
  const conversations = useInboxStore((s) => s.conversations)

  if (!selectedPersonId) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
            Convolios
          </h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Select a conversation to start
          </p>
        </div>
      </div>
    )
  }

  const person = conversations.find((c) => c.person.id === selectedPersonId)?.person

  return (
    <div className="flex-1 flex flex-col">
      {person && (
        <div className="px-4 py-3 flex items-center gap-3" style={{ borderBottom: '1px solid var(--border)' }}>
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold"
            style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
          >
            {person.display_name.charAt(0).toUpperCase()}
          </div>
          <div>
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {person.display_name}
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {activeThread.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {activeThread.length === 0 && (
          <div className="text-center text-xs py-8" style={{ color: 'var(--text-muted)' }}>
            No messages yet
          </div>
        )}
      </div>
    </div>
  )
}

function MessageBubble({ message }: { message: Message }) {
  const isOutbound = message.direction === 'outbound'
  const channelMeta = CHANNEL_META[message.channel as Channel]

  return (
    <div className={`flex ${isOutbound ? 'justify-end' : 'justify-start'}`}>
      <div
        className="max-w-[70%] rounded-lg px-3 py-2"
        style={{
          backgroundColor: isOutbound ? 'var(--accent)' : 'var(--bg-tertiary)',
        }}
      >
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[10px]">{channelMeta?.icon ?? '💬'}</span>
          <span className="text-[10px]" style={{ color: isOutbound ? 'rgba(255,255,255,0.6)' : 'var(--text-muted)' }}>
            {formatRelativeTime(message.sent_at)}
          </span>
        </div>
        <p className="text-sm whitespace-pre-wrap" style={{
          color: isOutbound ? '#fff' : 'var(--text-primary)',
        }}>
          {message.body_text ?? '(attachment)'}
        </p>
      </div>
    </div>
  )
}
