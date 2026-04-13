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
      return [...((data as Message[]) ?? [])].reverse()
    },
    enabled: _.isString(personId) && _.isString(userId),
    refetchInterval: interval,
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
