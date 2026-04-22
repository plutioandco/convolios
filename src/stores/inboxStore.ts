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
  | 'gate'
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
      // Length-based mark_read delay. Firing `seen` on Unipile
      // milliseconds after the thread opens is one of the strongest
      // automation tells on IG/WA — real users take at least a second
      // or two to read even a short message. Derive the delay from
      // the last inbound message length so a one-liner gets ~1.5s and
      // a long paragraph gets several. Fire-and-forget: UI stays
      // optimistically-read immediately; only the provider-side
      // `seen` is delayed.
      const convs = queryClient.getQueryData<ConversationPreview[]>(['conversations', userId])
        ?? queryClient.getQueriesData<ConversationPreview[]>({ queryKey: ['conversations', userId] })
          .flatMap(([, v]) => v ?? [])
      const preview = convs?.find((c) => c.person.id === personId)
      const charLen = preview?.lastMessage?.body_text?.length ?? 0
      const perCharMs = 40 + Math.floor(Math.random() * 20)
      const jitterMs = Math.floor((Math.random() - 0.5) * 800)
      const delayMs = _.clamp(1000 + charLen * perCharMs + jitterMs, 1500, 15000)
      setTimeout(() => {
        invoke('chat_action', {
          userId, personId,
          action: 'mark_read',
        }).catch((e) => {
          if (import.meta.env.DEV) console.warn('[chat_action] read sync:', e)
        })
      }, delayMs)
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
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const inboxTauriStore = createTauriStore('inbox', useInboxStore as any)

// Nav-reachable views. Anything else (legacy persisted values like
// 'stalled', 'dropped', 'done', 'snoozed') is auto-migrated to 'all'.
const VALID_VIEWS: ReadonlySet<ActiveView> = new Set([
  'all', 'my_turn', 'their_turn', 'gate', 'blocked', 'flagged',
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

