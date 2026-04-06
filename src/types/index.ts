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
  sent_at: string
  synced_at: string
  triage: TriageLevel
}

export interface ConnectedAccount {
  id: string
  user_id: string
  provider: string
  channel: Channel
  account_id: string | null
  status: 'active' | 'disconnected' | 'expired'
  created_at: string
  updated_at: string
}

export interface ConversationPreview {
  person: Person
  lastMessage: Message
  unreadCount: number
}
