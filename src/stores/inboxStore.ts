import { create } from 'zustand'
import { createTauriStore } from '@tauri-store/zustand'
import { invoke } from '@tauri-apps/api/core'
import _ from 'lodash'
import { supabase } from '../lib/supabase'
import { queryClient } from '../lib/queryClient'
import type { ConversationPreview } from '../types'
import type { Channel, TriageLevel } from '../types'

interface InboxState {
  selectedPersonId: string | null
  activeChannel: Channel | 'all'
  activeView: 'inbox' | 'screener' | 'blocked' | 'flagged'
  activeCircleId: string | null
  readFilter: 'all' | 'unread'

  setActiveChannel: (channel: Channel | 'all') => void
  setActiveView: (view: InboxState['activeView']) => void
  setActiveCircleId: (circleId: string | null) => void
  setReadFilter: (filter: InboxState['readFilter']) => void
  selectPerson: (personId: string | null) => void
  markConversationRead: (userId: string, personId: string) => Promise<void>
  markPersonUnread: (userId: string, personId: string, unread: boolean) => Promise<void>
  pinPerson: (userId: string, personId: string, pinned: boolean) => Promise<void>
  flagMessage: (userId: string, personId: string, messageId: string, flagged: boolean) => Promise<void>
}

export const useInboxStore = create<InboxState>((set) => ({
  selectedPersonId: null,
  activeChannel: 'all',
  activeView: 'inbox',
  activeCircleId: null,
  readFilter: 'all',

  setActiveChannel: (channel) => set({ activeChannel: channel, activeView: 'inbox', activeCircleId: null }),
  setActiveView: (activeView) => set({ activeView, activeCircleId: null, activeChannel: 'all', readFilter: 'all' }),
  setActiveCircleId: (activeCircleId) => set({ activeCircleId, activeView: 'inbox', activeChannel: 'all' }),
  setReadFilter: (readFilter) => set({ readFilter }),

  selectPerson: (personId) => set({ selectedPersonId: personId }),

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

    queryClient.setQueriesData<import('../types').Message[]>(
      { queryKey: ['thread', personId, userId] },
      (old) => {
        if (!old) return old
        return old.map((m) => {
          if (m.id === messageId) {
            if (m.channel === 'email' && _.isString(m.external_id)) emailExternalId = m.external_id
            return { ...m, flagged_at: flagged ? new Date().toISOString() : null }
          }
          return m
        })
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

inboxTauriStore.start().catch(() => {
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
  markDone: (detail: string) => void
}

export const useSyncStore = create<SyncState>((set) => ({
  lastSyncedAt: null,
  markDone: () => set({ lastSyncedAt: new Date().toISOString() }),
}))
