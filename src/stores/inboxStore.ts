import { create } from 'zustand'
import { createTauriStore } from '@tauri-store/zustand'
import { supabase } from '../lib/supabase'
import { queryClient } from '../lib/queryClient'
import type { ConversationPreview } from '../types'
import type { Channel, TriageLevel } from '../types'

interface InboxState {
  selectedPersonId: string | null
  activeChannel: Channel | 'all'
  activeView: 'inbox' | 'screener' | 'blocked'
  activeCircleId: string | null
  readFilter: 'all' | 'unread'

  setActiveChannel: (channel: Channel | 'all') => void
  setActiveView: (view: InboxState['activeView']) => void
  setActiveCircleId: (circleId: string | null) => void
  setReadFilter: (filter: InboxState['readFilter']) => void
  selectPerson: (personId: string | null) => void
  markConversationRead: (userId: string, personId: string) => Promise<void>
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
    // setQueriesData does partial-key matching — hits all 4-part conversation keys for this user
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
