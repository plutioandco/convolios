export interface Person {
  id: string
  user_id: string
  display_name: string
  avatar_url: string | null
  notes: string | null
  ai_summary: string | null
  ai_summary_updated_at: string | null
  status: 'approved' | 'pending' | 'blocked'
  created_at: string
  updated_at: string
}

export type ThreadState =
  | 'my_turn'
  | 'their_turn'
  | 'gate'

export interface OpenQuestion {
  id: string
  question_text: string
  asked_at: string
  message_id: string
}

export interface OpenCommitment {
  id: string
  commitment_text: string
  direction: 'mine' | 'theirs'
  due_hint: string | null
  created_at: string
  message_id: string
}

export interface ThreadContext {
  questions: OpenQuestion[]
  commitments: OpenCommitment[]
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
  | 'imessage'
  | 'sms'
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
  flagged_at: string | null
  _pending?: boolean
  _failed?: boolean
  _failedReason?: string
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
  channels: string[]
  markedUnread: boolean
  pinnedAt: string | null
  turnState: ThreadState
}

export interface FlaggedMessage {
  messageId: string
  personId: string
  displayName: string
  avatarUrl: string | null
  channel: string
  direction: string
  bodyText: string | null
  subject: string | null
  bodyHtml: string | null
  attachments: unknown[] | null
  senderName: string | null
  sentAt: string
  flaggedAt: string
  externalId: string | null
  threadId: string | null
  deleted: boolean | null
}

export interface Circle {
  id: string
  user_id: string
  name: string
  color: string
  emoji: string | null
  notify: 'all' | 'muted'
  sort_order: number
  created_at: string
}

export interface CircleMember {
  circle_id: string
  person_id: string
  added_at: string
}

export interface MergeClusterMember {
  id: string
  name: string
  avatar: string | null
  channels: string[]
  is_group: boolean
}

export interface MergeCluster {
  cluster_id: string
  keep_person_id: string
  keep_person_name: string
  keep_person_avatar: string | null
  members: MergeClusterMember[]
  match_type: 'identifier' | 'name'
  match_detail: string
  score: number
}

export interface MergeLogEntry {
  id: string
  user_id: string
  keep_person_id: string
  merged_person_id: string
  merged_person_name: string
  merged_identities: { id: string; channel: string; handle: string }[]
  merged_message_count: number
  merged_at: string
  undone_at: string | null
}
