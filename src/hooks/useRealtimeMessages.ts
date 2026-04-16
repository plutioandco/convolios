import { useEffect, useRef, useState, useCallback } from 'react'
import _ from 'lodash'
import { invoke } from '@tauri-apps/api/core'
import { supabase } from '../lib/supabase'
import { queryClient } from '../lib/queryClient'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import type { Message } from '../types'

const FALLBACK_POLL_INTERVAL = 8_000
const DEAD_THRESHOLD = 300_000
const AUTO_RETRY_INTERVALS = [5_000, 15_000, 30_000, 60_000]
const HEARTBEAT_INTERVAL = 60_000
const HEARTBEAT_STALE_THRESHOLD = 120_000

interface RealtimeState {
  connected: boolean
  dead: boolean
  reconnect: () => void
}

async function notifyIfAllowed(title: string, body: string) {
  try {
    let granted = await isPermissionGranted()
    if (!granted) {
      const result = await requestPermission()
      granted = result === 'granted'
    }
    if (granted) {
      sendNotification({ title, body })
    }
  } catch {
    /* notification plugin unavailable outside Tauri */
  }
}

export function useRealtimeMessages(userId: string | undefined): RealtimeState {
  const [connected, setConnected] = useState(false)
  const [dead, setDead] = useState(false)
  const [reconnectKey, setReconnectKey] = useState(0)
  const disconnectedSince = useRef<number | null>(null)
  const retryCount = useRef(0)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastEventAt = useRef(Date.now())
  const connectedRef = useRef(false)

  const reconnect = useCallback(() => {
    setDead(false)
    disconnectedSince.current = null
    retryCount.current = 0
    if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null }
    setReconnectKey((k) => k + 1)
  }, [])

  useEffect(() => {
    if (!userId) return

    let fallbackPoll: ReturnType<typeof setInterval> | null = null

    const invalidateAll = () => {
      queryClient.invalidateQueries({ queryKey: ['conversations', userId] })
      queryClient.invalidateQueries({ queryKey: ['thread'] })
      queryClient.invalidateQueries({ queryKey: ['sidebar-unread', userId] })
    }

    const debouncedInvalidateConvos = _.debounce(
      () => {
        queryClient.invalidateQueries({ queryKey: ['conversations', userId] })
        queryClient.invalidateQueries({ queryKey: ['sidebar-unread', userId] })
      },
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

    const channelName = `messages-realtime-${reconnectKey}`
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
          lastEventAt.current = Date.now()
          const msg = payload.new as Message
          if (import.meta.env.DEV) console.debug('[realtime] INSERT', msg.direction, msg.body_text?.slice(0, 30), msg.person_id)
          if (_.isString(msg.person_id)) {
            queryClient.invalidateQueries({ queryKey: ['thread', msg.person_id] })
          }
          debouncedInvalidateConvos()

          if (msg.direction === 'inbound' && !document.hasFocus()) {
            const title = _.isString(msg.sender_name) ? msg.sender_name : 'New message'
            const body = _.isString(msg.body_text) ? msg.body_text.slice(0, 100) : ''
            notifyIfAllowed(title, body)
          }
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
          lastEventAt.current = Date.now()
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
          lastEventAt.current = Date.now()
          connectedRef.current = true
          setConnected(true)
          setDead(false)
          disconnectedSince.current = null
          retryCount.current = 0
          if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null }
          stopFallbackPolling()
        }

        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          connectedRef.current = false
          setConnected(false)
          if (!disconnectedSince.current) disconnectedSince.current = Date.now()
          startFallbackPolling()

          const idx = Math.min(retryCount.current, AUTO_RETRY_INTERVALS.length - 1)
          const delay = AUTO_RETRY_INTERVALS[idx]
          retryCount.current += 1

          if (disconnectedSince.current && Date.now() - disconnectedSince.current > DEAD_THRESHOLD) {
            setDead(true)
          } else {
            if (retryTimer.current) clearTimeout(retryTimer.current)
            retryTimer.current = setTimeout(() => {
              setReconnectKey((k) => k + 1)
            }, delay)
          }
        }
      })

    const heartbeat = setInterval(() => {
      if (connectedRef.current && document.hasFocus() && Date.now() - lastEventAt.current > HEARTBEAT_STALE_THRESHOLD) {
        if (import.meta.env.DEV) console.debug('[realtime] heartbeat: no events for 2min, forcing reconnect')
        setReconnectKey((k) => k + 1)
      }
    }, HEARTBEAT_INTERVAL)

    const onFocus = () => {
      invalidateAll()
      invoke('sync_email_flags', { userId }).then((r) => {
        if (_.isString(r) && r !== '0') {
          queryClient.invalidateQueries({ queryKey: ['flagged', userId] })
          queryClient.invalidateQueries({ queryKey: ['conversations', userId] })
        }
      }).catch(() => {})
    }
    const onOnline = () => {
      invalidateAll()
      setDead(false)
      disconnectedSince.current = null
      retryCount.current = 0
      setReconnectKey((k) => k + 1)
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onOnline)

    return () => {
      debouncedInvalidateConvos.cancel()
      stopFallbackPolling()
      clearInterval(heartbeat)
      if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null }
      supabase.removeChannel(channel)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onOnline)
    }
  }, [userId, reconnectKey])

  return { connected, dead, reconnect }
}
