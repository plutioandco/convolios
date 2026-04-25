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

// Keeps the on-device bridges warm for `userId`.
//
// Message delivery to the webhook is handled server-side by Rust
// (using x-webhook-secret + x-on-device-user-id). This hook only
// manages the sidecar lifecycle and handles lightweight events
// (account_status, cookies_updated, query invalidation).
export function useOnDeviceBridge(userId: string | undefined) {
  useEffect(() => {
    if (!_.isString(userId)) return

    let unlisten: UnlistenFn | null = null
    let cancelled = false

    const run = async () => {
      unlisten = await listen<OnDeviceEventPayload>('on_device:event', handleEvent)

      if (cancelled) {
        try { unlisten?.() } catch { /* HMR */ }
        unlisten = null
        return
      }

      const delays = [0, 3000, 5000, 10000, 20000]
      for (const delay of delays) {
        if (cancelled) return
        if (delay > 0) await new Promise((r) => setTimeout(r, delay))
        try {
          const n = await invoke<number>('on_device_resume_all', { userId })
          if (n >= 0) return
        } catch (e) {
          console.warn(`[on-device] resume_all attempt failed:`, e)
        }
      }
      console.error('[on-device] resume_all: all attempts exhausted')
    }

    run().catch((e) => console.error('[on-device] setup failed:', e))

    return () => {
      cancelled = true
      try { unlisten?.() } catch { /* listener may already be invalidated by HMR */ }
    }
  }, [userId])
}

async function handleEvent(evt: { payload: OnDeviceEventPayload }) {
  const { type, account_id, payload } = evt.payload ?? ({} as OnDeviceEventPayload)

  if (type === 'account_status') {
    const { data: { session } } = await supabase.auth.getSession()
    const userId = session?.user?.id
    queryClient.invalidateQueries({ queryKey: ['conversations', userId] })
    if (_.isString(userId)) useAccountsStore.getState().fetchAccounts(userId)
    return
  }

  if (type === 'cookies_updated') {
    const cookies = payload?.cookies
    if (cookies && _.isString(account_id)) {
      const { data: { session } } = await supabase.auth.getSession()
      const userId = session?.user?.id
      if (_.isString(userId)) {
        invoke('on_device_update_cookies', { userId, accountId: account_id, cookies: JSON.stringify(cookies) })
          .catch((e) => console.warn('[on-device] cookie persist failed:', e))
      }
    }
    return
  }

  if (type === 'typing') return

  if (type === 'message_received') {
    const { data: { session } } = await supabase.auth.getSession()
    const userId = session?.user?.id
    if (_.isString(userId)) {
      queryClient.invalidateQueries({ queryKey: ['conversations', userId] })
    }
  }
}
