import { useEffect, useRef, useState, useCallback } from 'react'
import _ from 'lodash'
import { supabase } from '../lib/supabase'
import { queryClient } from '../lib/queryClient'
import type { Message } from '../types'

const FALLBACK_POLL_INTERVAL = 8_000
const DEAD_THRESHOLD = 120_000

interface RealtimeState {
  connected: boolean
  dead: boolean
  reconnect: () => void
}

export function useRealtimeMessages(userId: string | undefined): RealtimeState {
  const [connected, setConnected] = useState(false)
  const [dead, setDead] = useState(false)
  const disconnectedSince = useRef<number | null>(null)

  const reconnect = useCallback(() => {
    setDead(false)
    disconnectedSince.current = null
    supabase.realtime.connect()
  }, [])

  useEffect(() => {
    if (!userId) return

    let fallbackPoll: ReturnType<typeof setInterval> | null = null

    const invalidateAll = () => {
      queryClient.invalidateQueries({ queryKey: ['conversations', userId] })
      queryClient.invalidateQueries({ queryKey: ['thread'] })
    }

    const debouncedInvalidateConvos = _.debounce(
      () => queryClient.invalidateQueries({ queryKey: ['conversations', userId] }),
      1500,
      { leading: true, trailing: true, maxWait: 3000 }
    )

    const startFallbackPolling = () => {
      if (fallbackPoll) return
      fallbackPoll = setInterval(() => {
        invalidateAll()
        if (disconnectedSince.current && Date.now() - disconnectedSince.current > DEAD_THRESHOLD) {
          setDead(true)
        }
      }, FALLBACK_POLL_INTERVAL)
    }

    const stopFallbackPolling = () => {
      if (fallbackPoll) { clearInterval(fallbackPoll); fallbackPoll = null }
    }

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
          const msg = payload.new as Message
          if (import.meta.env.DEV) console.debug('[realtime] INSERT', msg.direction, msg.body_text?.slice(0, 30), msg.person_id)
          if (_.isString(msg.person_id)) {
            queryClient.invalidateQueries({ queryKey: ['thread', msg.person_id] })
          }
          debouncedInvalidateConvos()
        }
      )
      .on<Message>(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'messages',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const msg = payload.new as Message
          if (import.meta.env.DEV) console.debug('[realtime] UPDATE', msg.direction, msg.body_text?.slice(0, 30), msg.person_id)
          if (_.isString(msg.person_id)) {
            queryClient.invalidateQueries({ queryKey: ['thread', msg.person_id] })
          }
          debouncedInvalidateConvos()
        }
      )
      .subscribe((status) => {
        if (import.meta.env.DEV) console.debug('[realtime] status', status)

        if (status === 'SUBSCRIBED') {
          setConnected(true)
          setDead(false)
          disconnectedSince.current = null
          stopFallbackPolling()
        }

        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setConnected(false)
          if (!disconnectedSince.current) disconnectedSince.current = Date.now()
          startFallbackPolling()
        }
      })

    const onFocus = () => invalidateAll()
    const onOnline = () => {
      invalidateAll()
      if (!supabase.realtime.isConnected()) {
        supabase.realtime.connect()
      }
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onOnline)

    return () => {
      debouncedInvalidateConvos.cancel()
      stopFallbackPolling()
      supabase.removeChannel(channel)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onOnline)
    }
  }, [userId])

  return { connected, dead, reconnect }
}
