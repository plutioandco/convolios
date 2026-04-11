import { useEffect, useRef, useState, useCallback } from 'react'
import _ from 'lodash'
import { supabase } from '../lib/supabase'
import { queryClient } from '../lib/queryClient'
import type { Message } from '../types'

const HEARTBEAT_INTERVAL = 30_000
const RECONNECT_DELAY = 3_000
const MAX_RETRIES = 8
const FALLBACK_POLL_INTERVAL = 8_000

interface RealtimeState {
  connected: boolean
  dead: boolean
  reconnect: () => void
}

export function useRealtimeMessages(userId: string | undefined): RealtimeState {
  const lastEventRef = useRef(Date.now())
  const [attempt, setAttempt] = useState(0)
  const [connected, setConnected] = useState(false)
  const dead = !_.isString(userId) ? false : attempt >= MAX_RETRIES

  const reconnect = useCallback(() => setAttempt(0), [])

  useEffect(() => {
    if (!userId) return

    let heartbeatTimer: ReturnType<typeof setInterval> | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let fallbackPoll: ReturnType<typeof setInterval> | null = null
    let cleaned = false

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
      fallbackPoll = setInterval(invalidateAll, FALLBACK_POLL_INTERVAL)
    }

    const stopFallbackPolling = () => {
      if (fallbackPoll) { clearInterval(fallbackPoll); fallbackPoll = null }
    }

    if (attempt >= MAX_RETRIES) {
      setConnected(false)
      startFallbackPolling()
      const onFocus = () => invalidateAll()
      window.addEventListener('focus', onFocus)
      return () => {
        stopFallbackPolling()
        window.removeEventListener('focus', onFocus)
      }
    }

    const channelName = attempt === 0 ? 'messages-realtime' : `messages-realtime-${attempt}`

    const channel = supabase
      .channel(channelName)
      .on<Message>(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          lastEventRef.current = Date.now()
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
          lastEventRef.current = Date.now()
          const msg = payload.new as Message
          if (import.meta.env.DEV) console.debug('[realtime] UPDATE', msg.direction, msg.body_text?.slice(0, 30), msg.person_id)
          if (_.isString(msg.person_id)) {
            queryClient.invalidateQueries({ queryKey: ['thread', msg.person_id] })
          }
          debouncedInvalidateConvos()
        }
      )
      .subscribe((status) => {
        if (import.meta.env.DEV) console.debug('[realtime]', channelName, status)

        if (status === 'SUBSCRIBED') {
          setAttempt(0)
          setConnected(true)
          stopFallbackPolling()
          heartbeatTimer = setInterval(() => {
            const silent = Date.now() - lastEventRef.current
            if (silent > HEARTBEAT_INTERVAL * 3) {
              invalidateAll()
              lastEventRef.current = Date.now()
            }
          }, HEARTBEAT_INTERVAL)
        }

        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setConnected(false)
          startFallbackPolling()
          if (import.meta.env.DEV) console.warn('[realtime] channel error/timeout, reconnecting...', { attempt })
          if (reconnectTimer) clearTimeout(reconnectTimer)
          const delay = RECONNECT_DELAY * Math.min(2 ** attempt, 32)
          reconnectTimer = setTimeout(() => {
            if (cleaned) return
            supabase.removeChannel(channel)
            invalidateAll()
            setAttempt((a) => a + 1)
          }, delay)
        }
      })

    const onFocus = () => invalidateAll()
    const onOnline = () => {
      invalidateAll()
      if (attempt > 0) setAttempt(0)
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onOnline)

    return () => {
      cleaned = true
      debouncedInvalidateConvos.cancel()
      stopFallbackPolling()
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      supabase.removeChannel(channel)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onOnline)
    }
  }, [userId, attempt])

  return { connected, dead, reconnect }
}
