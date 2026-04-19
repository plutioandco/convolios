import { create } from 'zustand'
import type { Channel } from '../types'

// Mirrors the payload emitted by `startup_sync_inner` in src-tauri/lib.rs.
// `account` is only present while iterating active Unipile accounts; the
// earlier phases (fetch accounts, ensure webhooks, X DMs, iMessage backfill)
// emit `detail` only. Frontend treats both the same — account, when present,
// formats to "Syncing {channel} ({idx} of {total})"; otherwise we show the
// raw detail string.
interface SyncAccount {
  idx: number
  total: number
  channel: Channel
}

interface SyncStatusState {
  phase: 'idle' | 'syncing'
  detail: string | null
  account: SyncAccount | null
  startedAt: number | null
  set: (next: { phase: 'syncing'; detail: string | null; account: SyncAccount | null }) => void
  reset: () => void
}

export const useSyncStatusStore = create<SyncStatusState>((set, get) => ({
  phase: 'idle',
  detail: null,
  account: null,
  startedAt: null,
  set: (next) => {
    const startedAt = get().startedAt ?? Date.now()
    set({ ...next, startedAt })
  },
  reset: () => set({ phase: 'idle', detail: null, account: null, startedAt: null }),
}))
