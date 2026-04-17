import { create } from 'zustand'
import { createTauriStore } from '@tauri-store/zustand'
import { invoke } from '@tauri-apps/api/core'
import _ from 'lodash'
import { supabase } from '../lib/supabase'
import { queryClient } from '../lib/queryClient'
import type { InfiniteData } from '@tanstack/react-query'
import type { ConversationPreview, Message, ThreadState } from '../types'
import type { Channel, TriageLevel } from '../types'
import { usePreferencesStore } from './preferencesStore'

export type ActiveView =
  | 'all'
  | 'my_turn'
  | 'their_turn'
  | 'stalled'
  | 'dropped'
  | 'done'
  | 'gate'
  | 'snoozed'
  | 'blocked'
  | 'flagged'

// Single source of truth for mapping a sidebar view onto the two RPC filters
// (person.status + derived turn_state). Both InboxRoute (selection/keyboard
// nav) and InboxList (rendered list) MUST go through this so their query
// cache keys stay aligned — otherwise React Query double-fetches and the
// selection lookup can't see rows the list rendered.
export function viewToRpcParams(view: ActiveView): {
  status: 'approved' | 'pending' | 'blocked'
  state: ThreadState | null
} {
  if (view === 'gate')    return { status: 'pending',  state: 'gate' }
  if (view === 'blocked') return { status: 'blocked',  state: null   }
  if (view === 'flagged') return { status: 'approved', state: null   }
  if (view === 'all')     return { status: 'approved', state: null   }
  return { status: 'approved', state: view }
}

interface InboxState {
  selectedPersonId: string | null
  focusMessageId: string | null
  activeChannel: Channel | 'all'
  activeView: ActiveView
  activeCircleId: string | null
  readFilter: 'all' | 'unread'

  setActiveChannel: (channel: Channel | 'all') => void
  setActiveView: (view: ActiveView) => void
  setActiveCircleId: (circleId: string | null) => void
  setReadFilter: (filter: InboxState['readFilter']) => void
  selectPerson: (personId: string | null, focusMessageId?: string) => void
  markConversationRead: (userId: string, personId: string) => Promise<void>
  markPersonUnread: (userId: string, personId: string, unread: boolean) => Promise<void>
  pinPerson: (userId: string, personId: string, pinned: boolean) => Promise<void>
  flagMessage: (userId: string, personId: string, messageId: string, flagged: boolean) => Promise<void>
  markPersonDone: (userId: string, personId: string, done: boolean) => Promise<void>
}

export const useInboxStore = create<InboxState>((set) => ({
  selectedPersonId: null,
  focusMessageId: null,
  activeChannel: 'all',
  activeView: 'all',
  activeCircleId: null,
  readFilter: 'all',

  setActiveChannel: (channel) => set({ activeChannel: channel }),
  setActiveView: (activeView) => set({ activeView }),
  setActiveCircleId: (activeCircleId) => set({ activeCircleId }),
  setReadFilter: (readFilter) => set({ readFilter }),

  selectPerson: (personId, focusMessageId) => set({ selectedPersonId: personId, focusMessageId: focusMessageId ?? null }),

  markConversationRead: async (userId: string, personId: string) => {
    queryClient.setQueriesData<ConversationPreview[]>(
      { queryKey: ['conversations', userId] },
      (old) => {
        if (!old) return old
        return old.map((c) =>
          c.person.id === personId ? { ...c, unreadCount: 0 } : c
        )
      }
    )

    const { error } = await supabase.rpc('mark_conversation_read', {
      p_user_id: userId,
      p_person_id: personId,
    })

    if (error) {
      queryClient.invalidateQueries({ queryKey: ['conversations', userId] })
    }
    queryClient.invalidateQueries({ queryKey: ['sidebar-unread', userId] })

    if (usePreferencesStore.getState().syncReadStatus) {
      invoke('chat_action', {
        userId, personId,
        action: 'mark_read',
      }).catch((e) => {
        if (import.meta.env.DEV) console.warn('[chat_action] read sync:', e)
      })
    }
  },

  markPersonUnread: async (userId: string, personId: string, unread: boolean) => {
    queryClient.setQueriesData<ConversationPreview[]>(
      { queryKey: ['conversations', userId] },
      (old) => {
        if (!old) return old
        return old.map((c) =>
          c.person.id === personId ? { ...c, markedUnread: unread } : c
        )
      }
    )

    invoke('chat_action', {
      userId, personId,
      action: unread ? 'mark_unread' : 'mark_read',
    }).catch((e) => {
      if (import.meta.env.DEV) console.warn('[chat_action] unread sync:', e)
    })

    const { error } = await supabase.rpc('mark_person_unread', {
      p_user_id: userId,
      p_person_id: personId,
      p_unread: unread,
    })

    if (error) {
      queryClient.invalidateQueries({ queryKey: ['conversations', userId] })
    }
    queryClient.invalidateQueries({ queryKey: ['sidebar-unread', userId] })
  },

  pinPerson: async (userId: string, personId: string, pinned: boolean) => {
    queryClient.setQueriesData<ConversationPreview[]>(
      { queryKey: ['conversations', userId] },
      (old) => {
        if (!old) return old
        return old.map((c) =>
          c.person.id === personId
            ? { ...c, pinnedAt: pinned ? new Date().toISOString() : null }
            : c
        )
      }
    )

    invoke('chat_action', {
      userId, personId,
      action: pinned ? 'pin' : 'unpin',
    }).catch((e) => {
      if (import.meta.env.DEV) console.warn('[chat_action] pin sync:', e)
    })

    const { error } = await supabase.rpc('pin_person', {
      p_user_id: userId,
      p_person_id: personId,
      p_pinned: pinned,
    })

    if (error) {
      queryClient.invalidateQueries({ queryKey: ['conversations', userId] })
    }
  },

  flagMessage: async (userId: string, personId: string, messageId: string, flagged: boolean) => {
    let emailExternalId: string | null = null

    queryClient.setQueriesData<InfiniteData<Message[]>>(
      { queryKey: ['thread', personId, userId] },
      (old) => {
        if (!old) return old
        return {
          ...old,
          pages: old.pages.map((page) =>
            page.map((m) => {
              if (m.id === messageId) {
                if (m.channel === 'email' && _.isString(m.external_id)) emailExternalId = m.external_id
                return { ...m, flagged_at: flagged ? new Date().toISOString() : null }
              }
              return m
            })
          ),
        }
      }
    )

    const { error } = await supabase.rpc('flag_message', {
      p_user_id: userId,
      p_message_id: messageId,
      p_flagged: flagged,
    })

    if (error) {
      queryClient.invalidateQueries({ queryKey: ['thread', personId, userId] })
    }
    queryClient.invalidateQueries({ queryKey: ['flagged', userId] })

    if (emailExternalId) {
      invoke('email_flag_action', {
        emailExternalId,
        flagged,
      }).catch((e) => {
        if (import.meta.env.DEV) console.warn('[email_flag_action] sync:', e)
      })
    }
  },

  markPersonDone: async (userId: string, personId: string, done: boolean) => {
    // Optimistic: toggle done_at + turn_state only for the "done -> done"
    // case. Un-done-ing depends on time thresholds (2d / 3d) that live in
    // SQL — we don't try to replicate them client-side; just invalidate on
    // success so the server-derived turn_state lands quickly.
    const nowIso = new Date().toISOString()
    queryClient.setQueriesData<ConversationPreview[]>(
      { queryKey: ['conversations', userId] },
      (old) => {
        if (!old) return old
        return old.map((c) =>
          c.person.id === personId
            ? {
                ...c,
                person: { ...c.person, done_at: done ? nowIso : null },
                ...(done ? { turnState: 'done' as const } : {}),
              }
            : c
        )
      }
    )

    const { error } = await supabase.rpc(done ? 'mark_person_done' : 'unmark_person_done', {
      p_person_id: personId,
    })

    if (error) {
      queryClient.invalidateQueries({ queryKey: ['conversations', userId] })
      return
    }
    queryClient.invalidateQueries({ queryKey: ['conversations', userId] })
    queryClient.invalidateQueries({ queryKey: ['state-counts', userId] })
  },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const inboxTauriStore = createTauriStore('inbox', useInboxStore as any)

// Nav-reachable views. Stalled/Dropped/Done are valid turn-states in data
// but are no longer exposed as sidebar nav — auto-migrate those to 'all'.
const VALID_VIEWS: ReadonlySet<ActiveView> = new Set([
  'all', 'my_turn', 'their_turn', 'gate', 'snoozed', 'blocked', 'flagged',
])

inboxTauriStore.start()
  .then(() => {
    const current = useInboxStore.getState().activeView as string
    if (!VALID_VIEWS.has(current as ActiveView)) {
      useInboxStore.setState({ activeView: 'all' })
    }
  })
  .catch(() => {
    if (import.meta.env.DEV) console.warn('Tauri store not available (non-Tauri env)')
  })

interface FilterState {
  triageFilter: TriageLevel | 'all'
  searchQuery: string
  setTriageFilter: (level: TriageLevel | 'all') => void
  setSearchQuery: (query: string) => void
}

export const useFilterStore = create<FilterState>((set) => ({
  triageFilter: 'all',
  searchQuery: '',
  setTriageFilter: (triageFilter) => set({ triageFilter }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
}))

interface SyncState {
  lastSyncedAt: string | null
  markDone: () => void
}

export const useSyncStore = create<SyncState>((set) => ({
  lastSyncedAt: null,
  markDone: () => set({ lastSyncedAt: new Date().toISOString() }),
}))
