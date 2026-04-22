import { useEffect } from 'react'
import _ from 'lodash'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { supabase } from '../lib/supabase'
import { queryClient } from '../lib/queryClient'
import { useAccountsStore } from '../stores/accountsStore'

interface OnDeviceEventPayload {
  type: 'message_received' | 'account_status' | 'cookies_updated' | 'typing'
  account_id: string
  channel: string
  payload: Record<string, unknown>
}

/// Keeps the on-device bridges warm for `userId` and forwards the events they
/// emit to the `unipile-webhook` Edge Function.
///
/// Why the event pipeline lives in the frontend: the Edge Function expects a
/// user JWT to authorize an `on_device.message_received` event, and the
/// frontend is the only side that already holds a live, auto-refreshed JWT
/// (via Supabase's client). The Rust layer is kept blissfully ignorant of
/// auth tokens — it just emits `on_device:event` and we handle the rest here.
export function useOnDeviceBridge(userId: string | undefined) {
  useEffect(() => {
    if (!_.isString(userId)) return

    let unlisten: UnlistenFn | null = null
    let cancelled = false

    const run = async () => {
      // Install the listener BEFORE kicking off resume_all. Sidecars emit
      // `account_status` + queued messages immediately after `begin_events`,
      // and we'd lose any of those if we raced in the other order.
      unlisten = await listen<OnDeviceEventPayload>('on_device:event', handleEvent)

      if (cancelled) {
        unlisten?.()
        unlisten = null
        return
      }

      try {
        await invoke<number>('on_device_resume_all', { userId })
      } catch (e) {
        console.warn('[on-device] resume_all failed, retrying in 3s:', e)
        await new Promise((r) => setTimeout(r, 3000))
        if (!cancelled) {
          try {
            await invoke<number>('on_device_resume_all', { userId })
          } catch (e2) {
            console.warn('[on-device] resume_all retry failed:', e2)
          }
        }
      }
    }

    run().catch((e) => console.error('[on-device] setup failed:', e))

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [userId])
}

async function handleEvent(evt: { payload: OnDeviceEventPayload }) {
  const { type, channel, account_id, payload } = evt.payload ?? ({} as OnDeviceEventPayload)

  if (type === 'account_status') {
    const userId = (await supabase.auth.getUser()).data.user?.id
    queryClient.invalidateQueries({ queryKey: ['conversations', userId] })
    if (_.isString(userId)) useAccountsStore.getState().fetchAccounts(userId)
    return
  }

  if (type === 'cookies_updated') {
    const cookies = payload?.cookies
    if (cookies && _.isString(account_id)) {
      const userId = (await supabase.auth.getUser()).data.user?.id
      if (_.isString(userId)) {
        invoke('on_device_update_cookies', { userId, accountId: account_id, cookies: JSON.stringify(cookies) })
          .catch((e) => console.warn('[on-device] cookie persist failed:', e))
      }
    }
    return
  }

  if (type === 'typing') return

  if (type !== 'message_received') return

  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!_.isString(token)) {
    console.warn('[on-device] dropping message event — no session token')
    return
  }

  const url = import.meta.env.VITE_SUPABASE_URL
  if (!_.isString(url)) {
    console.error('[on-device] VITE_SUPABASE_URL missing; cannot forward event')
    return
  }

  // The bridge emits an already-normalized payload shape.
  // Re-wrap it in the JSON envelope the Edge Function expects.
  const body = JSON.stringify({
    event: 'on_device.message_received',
    account_id,
    channel,
    ...payload,
  })

  await postWithRetry(`${url}/functions/v1/unipile-webhook`, body, token)

  const userId = session?.user?.id
  if (_.isString(userId)) {
    queryClient.invalidateQueries({ queryKey: ['conversations', userId] })
  }
}

// Simple exponential backoff: 0.5s, 1s, 2s. After that we give up and log —
// the sidecar has already consumed the event from Meta, so losing it here is
// real data loss. Retrying beyond a few seconds on the hot path isn't useful;
// a longer-term durable queue is future work.
async function postWithRetry(url: string, body: string, token: string) {
  const delays = [500, 1000, 2000]
  let attempt = 0
  while (true) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body,
      })
      if (resp.ok) return
      if (resp.status < 500 && resp.status !== 429) {
        const text = await resp.text().catch(() => '')
        console.error(`[on-device] webhook ${resp.status} (non-retryable): ${text}`)
        return
      }
      console.warn(`[on-device] webhook ${resp.status} — retrying`)
    } catch (e) {
      console.warn('[on-device] webhook fetch failed — retrying:', e)
    }

    if (attempt >= delays.length) {
      console.error('[on-device] giving up on event delivery')
      return
    }
    await new Promise((r) => setTimeout(r, delays[attempt]))
    attempt += 1
  }
}
