import { create } from 'zustand'
import { createTauriStore } from '@tauri-store/zustand'
import { supabase } from '../lib/supabase'
import { queryClient } from '../lib/queryClient'
import type { ConversationPreview } from '../types'
import type { Channel, TriageLevel } from '../types'

interface InboxState {
  selectedPersonId: string | null
  activeChannel: Channel | 'all'

  setActiveChannel: (channel: Channel | 'all') => void
  selectPerson: (personId: string | null) => void
  markConversationRead: (userId: string, personId: string) => Promise<void>
}

export const useInboxStore = create<InboxState>((set) => ({
  selectedPersonId: null,
  activeChannel: 'all',

  setActiveChannel: (channel) => set({ activeChannel: channel }),

  selectPerson: (personId) => set({ selectedPersonId: personId }),

  markConversationRead: async (userId: string, personId: string) => {
    queryClient.setQueryData<ConversationPreview[]>(
      ['conversations', userId],
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
  },
}))

export const inboxTauriStore = createTauriStore('inbox', useInboxStore)

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
