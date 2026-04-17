import { useEffect, useRef, useState, useCallback } from 'react'
import _ from 'lodash'
import type { InfiniteData } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { supabase } from '../lib/supabase'
import { queryClient } from '../lib/queryClient'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import type { Message } from '../types'

const DEAD_THRESHOLD = 120_000
const CONNECTING_GRACE_MS = 3_000

interface RealtimeState {
  connected: boolean
  showConnecting: boolean
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

function patchThread(personId: string, userId: string | undefined, msg: Message, mode: 'insert' | 'update') {
  const key = ['thread', personId, userId] as const
  queryClient.setQueryData<InfiniteData<Message[]>>(key, (prev) => {
    if (!prev) return prev
    if (mode === 'update') {
      const pages = prev.pages.map((page) => page.map((m) => (m.id === msg.id ? { ...m, ...msg } : m)))
      return { ...prev, pages }
    }
    const [first, ...rest] = prev.pages
    if (!first) return prev
    if (first.some((m) => m.id === msg.id)) return prev
    return { ...prev, pages: [[msg, ...first], ...rest] }
  })
}

export function useRealtimeMessages(userId: string | undefined): RealtimeState {
  const [connected, setConnected] = useState(false)
  const [dead, setDead] = useState(false)
  const [showConnecting, setShowConnecting] = useState(false)
  const disconnectedSince = useRef<number | null>(null)
  const connectingGraceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const deadTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const reconnect = useCallback(() => {
    setDead(false)
    disconnectedSince.current = null
    supabase.realtime.disconnect()
    supabase.realtime.connect()
  }, [])

  useEffect(() => {
    if (!userId) return

    const invalidateConvos = () => {
      queryClient.invalidateQueries({ queryKey: ['conversations', userId] })
      queryClient.invalidateQueries({ queryKey: ['sidebar-unread', userId] })
    }

    const debouncedInvalidateConvos = _.debounce(invalidateConvos, 1500, {
      leading: true,
      trailing: true,
      maxWait: 3000,
    })

    const channel = supabase
      .channel(`messages:${userId}`)
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
          if (_.isString(msg.person_id)) {
            patchThread(msg.person_id, userId, msg, 'insert')
          }
          debouncedInvalidateConvos()

          if (msg.direction === 'inbound' && !document.hasFocus()) {
            const title = _.isString(msg.sender_name) ? msg.sender_name : 'New message'
            const body = _.isString(msg.body_text) ? msg.body_text.slice(0, 100) : ''
            notifyIfAllowed(title, body)
          }
        },
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
          if (_.isString(msg.person_id)) {
            patchThread(msg.person_id, userId, msg, 'update')
          }
          debouncedInvalidateConvos()
        },
      )
      .subscribe((status) => {
        if (import.meta.env.DEV) console.debug('[realtime] status', status)

        if (status === 'SUBSCRIBED') {
          setConnected(true)
          setDead(false)
          setShowConnecting(false)
          disconnectedSince.current = null
          if (connectingGraceTimer.current) {
            clearTimeout(connectingGraceTimer.current)
            connectingGraceTimer.current = null
          }
          if (deadTimer.current) {
            clearTimeout(deadTimer.current)
            deadTimer.current = null
          }
          return
        }

        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setConnected(false)
          if (!disconnectedSince.current) disconnectedSince.current = Date.now()

          if (!connectingGraceTimer.current) {
            connectingGraceTimer.current = setTimeout(() => {
              setShowConnecting(true)
              connectingGraceTimer.current = null
            }, CONNECTING_GRACE_MS)
          }

          if (!deadTimer.current) {
            deadTimer.current = setTimeout(() => {
              setDead(true)
              deadTimer.current = null
            }, DEAD_THRESHOLD)
          }
        }
      })

    const onWake = _.throttle(() => {
      supabase.auth.getSession().then(() => {
        invalidateConvos()
        if (_.isString(userId)) {
          queryClient.invalidateQueries({ queryKey: ['thread'], predicate: (q) => q.queryKey[2] === userId })
        }
      })
      invoke('sync_email_flags', { userId })
        .then((r) => {
          if (_.isString(r) && r !== '0') {
            queryClient.invalidateQueries({ queryKey: ['flagged', userId] })
            queryClient.invalidateQueries({ queryKey: ['conversations', userId] })
          }
        })
        .catch(() => {})
    }, 1000, { leading: true, trailing: false })

    const onFocus = () => onWake()
    const onVisibility = () => {
      if (document.visibilityState === 'visible') onWake()
    }
    const onOnline = () => onWake()

    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)

    return () => {
      debouncedInvalidateConvos.cancel()
      onWake.cancel()
      if (connectingGraceTimer.current) {
        clearTimeout(connectingGraceTimer.current)
        connectingGraceTimer.current = null
      }
      if (deadTimer.current) {
        clearTimeout(deadTimer.current)
        deadTimer.current = null
      }
      supabase.removeChannel(channel)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
    }
  }, [userId])

  return { connected, showConnecting: showConnecting && !connected, dead, reconnect }
}
