import { useQuery } from '@tanstack/react-query'
import _ from 'lodash'
import { supabase } from '../lib/supabase'
import type { FlaggedMessage } from '../types'

export function useFlaggedMessages(userId: string | undefined) {
  return useQuery({
    queryKey: ['flagged', userId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_flagged_messages', {
        p_user_id: userId!,
      })
      if (error) throw error
      return ((data as Record<string, unknown>[]) ?? []).map(rowToFlagged)
    },
    enabled: _.isString(userId),
  })
}

function rowToFlagged(row: Record<string, unknown>): FlaggedMessage {
  return {
    messageId: row.message_id as string,
    personId: row.person_id as string,
    displayName: row.display_name as string,
    avatarUrl: (row.avatar_url as string | null) ?? null,
    channel: row.channel as string,
    direction: row.direction as string,
    bodyText: (row.body_text as string | null) ?? null,
    subject: (row.subject as string | null) ?? null,
    bodyHtml: (row.body_html as string | null) ?? null,
    attachments: _.isArray(row.attachments) ? (row.attachments as unknown[]) : null,
    senderName: (row.sender_name as string | null) ?? null,
    sentAt: row.sent_at as string,
    flaggedAt: row.flagged_at as string,
    externalId: (row.external_id as string | null) ?? null,
    threadId: (row.thread_id as string | null) ?? null,
    deleted: (row.deleted as boolean | null) ?? null,
  }
}
