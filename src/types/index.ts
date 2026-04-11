export interface Person {
  id: string
  user_id: string
  display_name: string
  avatar_url: string | null
  notes: string | null
  ai_summary: string | null
  ai_summary_updated_at: string | null
  created_at: string
  updated_at: string
}

export interface Identity {
  id: string
  person_id: string
  channel: Channel
  handle: string
  display_name: string | null
  unipile_account_id: string | null
  metadata: Record<string, unknown>
  created_at: string
}

export type Channel =
  | 'whatsapp'
  | 'linkedin'
  | 'instagram'
  | 'telegram'
  | 'email'
  | 'x'
  | 'slack'
  | 'clickup'
  | 'google_chat'

export type TriageLevel =
  | 'urgent'
  | 'human'
  | 'newsletter'
  | 'notification'
  | 'noise'
  | 'unclassified'

export type Direction = 'inbound' | 'outbound'

export interface Message {
  id: string
  user_id: string
  person_id: string | null
  identity_id: string | null
  external_id: string | null
  channel: Channel
  direction: Direction
  message_type: string
  subject: string | null
  body_text: string | null
  body_html: string | null
  attachments: unknown[]
  thread_id: string | null
  sender_name: string | null
  reactions: { value?: string; emoji?: string; sender_id?: string; is_sender?: boolean }[]
  sent_at: string
  synced_at: string
  triage: TriageLevel
  seen: boolean
  seen_by: Record<string, boolean | string> | null
  delivered: boolean
  edited: boolean
  deleted: boolean
  hidden: boolean
  is_event: boolean
  event_type: string | null
  quoted_text: string | null
  quoted_sender: string | null
  provider_id: string | null
  chat_provider_id: string | null
  in_reply_to_message_id: string | null
  smtp_message_id: string | null
  unipile_account_id: string | null
  folder: string | null
  read_at: string | null
}

export interface ConnectedAccount {
  id: string
  user_id: string
  provider: string
  channel: Channel
  account_id: string | null
  status: 'active' | 'disconnected' | 'expired' | 'credentials' | 'error'
  display_name: string | null
  email: string | null
  phone: string | null
  username: string | null
  avatar_url: string | null
  provider_type: string | null
  connection_params: Record<string, unknown>
  last_synced_at: string | null
  created_at: string
  updated_at: string
}

export interface ConversationPreview {
  person: Person
  lastMessage: Message
  unreadCount: number
  prevInboundBody: string | null
  prevInboundSender: string | null
}
