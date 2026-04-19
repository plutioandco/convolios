import { useEffect, useState } from 'react'
import _ from 'lodash'
import type { InfiniteData } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { supabase } from '../lib/supabase'
import { queryClient } from '../lib/queryClient'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import { cleanSenderName, REACTION_RE, LID_RE, cleanPreviewText } from '../utils'
import type { Message, ConversationPreview } from '../types'

interface RealtimeState {
  connected: boolean
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

// Look up a person's display name across every cached `['conversations', userId, …]`
// query. Used as the notification title fallback when Unipile webhook payloads
// arrive without a sender_name (common for reactions, system events).
function personDisplayName(userId: string, personId: string): string | null {
  const entries = queryClient.getQueriesData<ConversationPreview[]>({
    queryKey: ['conversations', userId],
  })
  for (const [, data] of entries) {
    const match = data?.find((c) => c.person.id === personId)
    const name = match?.person.display_name
    if (_.isString(name) && name.length > 0) return name
  }
  return null
}

// Build a clean (no LID placeholders, no gibberish) title+body for a push
// notification. Reactions get a dedicated format so the user sees "❤ reacted"
// instead of "{{145544244678857@lid}} reacted ❤".
function formatNotification(msg: Message, userId: string): { title: string; body: string } {
  const rawSender = _.isString(msg.sender_name) ? cleanSenderName(msg.sender_name) : ''
  const fallbackName = _.isString(msg.person_id) ? personDisplayName(userId, msg.person_id) : null
  const title = rawSender.length > 0
    ? rawSender
    : (fallbackName ?? 'New message')

  const raw = _.isString(msg.body_text) ? msg.body_text : ''
  const reaction = raw.match(REACTION_RE)
  const cleaned = reaction
    ? `Reacted ${reaction[1]}`
    : cleanPreviewText(raw.replace(LID_RE, '').trim())

  return { title, body: cleaned.slice(0, 140) }
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
            const { title, body } = formatNotification(msg, userId)
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
          return
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setConnected(false)
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
      supabase.removeChannel(channel)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
    }
  }, [userId])

  return { connected }
}
