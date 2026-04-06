import { useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useInboxStore } from '../stores/inboxStore'
import type { Message } from '../types'

export function useRealtimeMessages(userId: string | undefined) {
  const handleRealtimeMessage = useInboxStore((s) => s.handleRealtimeMessage)
  const fetchConversations = useInboxStore((s) => s.fetchConversations)

  useEffect(() => {
    if (!userId) return

    const channel = supabase
      .channel('messages-realtime')
      .on<Message>(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          handleRealtimeMessage(payload.new as Message)
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'messages',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          fetchConversations(userId)
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [userId, handleRealtimeMessage, fetchConversations])
}
