import { create } from 'zustand'
import type { Channel } from '../types'

// Mirrors the payload emitted by `startup_sync_inner` in src-tauri/lib.rs.
// `account` is only present while iterating active Unipile accounts; the
// earlier phases (fetch accounts, ensure webhooks, X DMs, iMessage backfill)
// emit `detail` only. `chat` is only present inside the per-account chat
// loop — it surfaces per-chat motion on the banner so accounts with many
// threads don't look frozen.
interface SyncAccount {
  idx: number
  total: number
  channel: Channel
}

interface SyncChat {
  idx: number
  total: number
}

interface SyncStatusState {
  phase: 'idle' | 'syncing'
  detail: string | null
  account: SyncAccount | null
  chat: SyncChat | null
  startedAt: number | null
  set: (next: { phase: 'syncing'; detail: string | null; account: SyncAccount | null; chat: SyncChat | null }) => void
  reset: () => void
}

export const useSyncStatusStore = create<SyncStatusState>((set, get) => ({
  phase: 'idle',
  detail: null,
  account: null,
  chat: null,
  startedAt: null,
  set: (next) => {
    const startedAt = get().startedAt ?? Date.now()
    set({ ...next, startedAt })
  },
  reset: () => set({ phase: 'idle', detail: null, account: null, chat: null, startedAt: null }),
}))
