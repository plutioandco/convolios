import { useQuery, useQueryClient } from '@tanstack/react-query'
import _ from 'lodash'
import { supabase } from '../lib/supabase'
import type { Message } from '../types'

const PAGE_SIZE = 80

export function useThread(personId: string | null, userId?: string, realtimeConnected?: boolean) {
  const interval = realtimeConnected === false ? 8_000 : 30_000
  return useQuery({
    queryKey: ['thread', personId, userId],
    queryFn: async (): Promise<Message[]> => {
      let query = supabase
        .from('messages')
        .select('*')
        .eq('person_id', personId!)
        .order('sent_at', { ascending: false })
        .limit(PAGE_SIZE)

      if (_.isString(userId)) {
        query = query.eq('user_id', userId)
      }

      const { data, error } = await query
      if (error) throw error

      const raw = [...((data as Message[]) ?? [])].reverse()

      // Pass 1: deduplicate by external_id (Unipile can return same message with
      // two different IDs in send-response vs. chat-history, causing two DB rows).
      const seenExtIds = new Set<string>()
      const pass1 = raw.filter((m) => {
        if (!_.isString(m.external_id)) return true
        if (seenExtIds.has(m.external_id)) return false
        seenExtIds.add(m.external_id)
        return true
      })

      // Pass 2: content-based dedup for messages with NULL external_id
      // (same sent_at + direction + body_text = same message, different DB rows).
      const seenContent = new Set<string>()
      return pass1.filter((m) => {
        if (_.isString(m.external_id)) return true
        const key = `${m.direction}:${m.sent_at}:${m.body_text ?? ''}`
        if (seenContent.has(key)) return false
        seenContent.add(key)
        return true
      })
    },
    enabled: _.isString(personId) && _.isString(userId),
    refetchInterval: interval,
    staleTime: 30_000,
  })
}

export function useAddOptimisticMessage(personId: string | null, userId?: string) {
  const qc = useQueryClient()

  return (message: Message) => {
    if (!_.isString(personId)) return
    qc.setQueryData<Message[]>(
      ['thread', personId, userId],
      (old) => {
        if (!old) return [message]
        return [...old, message]
      }
    )
  }
}
