import { useQuery } from '@tanstack/react-query'
import _ from 'lodash'
import { supabase } from '../lib/supabase'
import { queryClient } from '../lib/queryClient'
import type { ConversationPreview, Channel, Message, Person, ThreadState, TriageLevel } from '../types'

function rowToPreview(row: Record<string, unknown>, userId: string, status?: string): ConversationPreview {
  const person: Person = {
    id: row.person_id as string,
    user_id: userId,
    display_name: (row.display_name as string) ?? '',
    avatar_url: (row.avatar_url as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    ai_summary: (row.ai_summary as string | null) ?? null,
    ai_summary_updated_at: null,
    status: (status as Person['status']) ?? 'approved',
    created_at: '',
    updated_at: '',
  }

  const lastMessage: Message = {
    id: row.last_message_id as string,
    user_id: userId,
    person_id: row.person_id as string,
    identity_id: null,
    external_id: (row.last_external_id as string | null) ?? null,
    channel: row.last_channel as Channel,
    direction: row.last_direction as 'inbound' | 'outbound',
    message_type: (row.last_message_type as string) ?? 'individual',
    subject: (row.last_subject as string | null) ?? null,
    body_text: (row.last_body_text as string | null) ?? null,
    body_html: null,
    attachments: (row.last_attachments as unknown[]) ?? [],
    thread_id: (row.last_thread_id as string | null) ?? null,
    sender_name: (row.last_sender_name as string | null) ?? null,
    reactions: [],
    sent_at: row.last_sent_at as string,
    synced_at: '',
    triage: (row.last_triage as TriageLevel) ?? 'unclassified',
    seen: (row.last_seen as boolean) ?? false,
    delivered: (row.last_delivered as boolean) ?? false,
    seen_by: null,
    edited: false,
    deleted: false,
    hidden: false,
    is_event: false,
    event_type: null,
    quoted_text: null,
    quoted_sender: null,
    provider_id: null,
    chat_provider_id: null,
    in_reply_to_message_id: null,
    smtp_message_id: null,
    unipile_account_id: null,
    folder: null,
    read_at: null,
    flagged_at: null,
  }

  return {
    person,
    lastMessage,
    unreadCount: Number(row.unread_count) || 0,
    prevInboundBody: null,
    prevInboundSender: null,
    channels: _.isArray(row.channels) ? (row.channels as string[]) : [],
    markedUnread: (row.marked_unread as boolean) ?? false,
    pinnedAt: (row.pinned_at as string | null) ?? null,
    turnState: ((row.turn_state as string) ?? 'their_turn') as ThreadState,
  }
}

function enrichPrevInbound(previews: ConversationPreview[], userId: string, batchMap: Record<string, Record<string, unknown>>): ConversationPreview[] {
  return previews.map((c) => {
    if (c.lastMessage.direction !== 'outbound') return c

    const cached = queryClient.getQueryData<Message[]>(['thread', c.person.id, userId])
    if (cached) {
      const inbound = _.findLast(cached, (m) => m.direction === 'inbound')
      if (inbound?.body_text) {
        return { ...c, prevInboundBody: inbound.body_text, prevInboundSender: inbound.sender_name }
      }
    }

    const fromBatch = batchMap[c.person.id]
    if (fromBatch && _.isString(fromBatch.body_text)) {
      return { ...c, prevInboundBody: fromBatch.body_text as string, prevInboundSender: (fromBatch.sender_name as string | null) ?? null }
    }

    return c
  })
}

async function fetchConversations(
  userId: string,
  status?: string,
  circleId?: string | null,
  state?: ThreadState | null,
): Promise<ConversationPreview[]> {
  const params: Record<string, unknown> = { p_user_id: userId }
  if (_.isString(status)) params.p_status = status
  if (_.isString(circleId)) params.p_circle_id = circleId
  if (_.isString(state)) params.p_state = state

  const { data: rows, error } = await supabase.rpc('get_conversations', params)

  if (error) throw error
  if (!rows?.length) return []

  let previews = (rows as Record<string, unknown>[]).map((r) => rowToPreview(r, userId, status))

  const outboundPersonIds = previews
    .filter((c) => c.lastMessage.direction === 'outbound')
    .map((c) => c.person.id)

  const batchMap: Record<string, Record<string, unknown>> = {}
  if (outboundPersonIds.length > 0) {
    const { data: inboundRows, error: batchErr } = await supabase.rpc('get_prev_inbound_batch', {
      p_user_id: userId,
      p_person_ids: outboundPersonIds,
    })
    if (!batchErr && inboundRows) {
      for (const row of inboundRows as Record<string, unknown>[]) {
        batchMap[row.person_id as string] = row
      }
    }
  }

  previews = enrichPrevInbound(previews, userId, batchMap)

  return previews
}

export function useConversations(
  userId: string | undefined,
  realtimeConnected?: boolean,
  status?: string,
  circleId?: string | null,
  state?: ThreadState | null,
) {
  return useQuery({
    queryKey: ['conversations', userId, status ?? 'approved', circleId ?? null, state ?? null],
    queryFn: () => fetchConversations(userId!, status, circleId, state),
    enabled: _.isString(userId),
    refetchInterval: realtimeConnected === false ? 15_000 : 60_000,
  })
}
