import { create } from 'zustand'
import _ from 'lodash'
import { supabase } from '../lib/supabase'
import type { Message, Person, ConversationPreview, Channel, TriageLevel } from '../types'

interface InboxState {
  conversations: ConversationPreview[]
  selectedPersonId: string | null
  activeChannel: Channel | 'all'
  activeThread: Message[]
  loading: boolean
  error: string | null

  setActiveChannel: (channel: Channel | 'all') => void
  selectPerson: (personId: string | null) => void
  fetchConversations: (userId: string) => Promise<void>
  fetchThread: (personId: string) => Promise<void>
  handleRealtimeMessage: (message: Message) => void
}

export const useInboxStore = create<InboxState>((set, get) => ({
  conversations: [],
  selectedPersonId: null,
  activeChannel: 'all',
  activeThread: [],
  loading: false,
  error: null,

  setActiveChannel: (channel) => set({ activeChannel: channel }),

  selectPerson: (personId) => {
    set({ selectedPersonId: personId, activeThread: [] })
    if (_.isString(personId)) {
      get().fetchThread(personId)
    }
  },

  fetchConversations: async (userId: string) => {
    set({ loading: true, error: null })
    try {
      const { data: messages, error } = await supabase
        .from('messages')
        .select('*, persons!messages_person_id_fkey(*)')
        .eq('user_id', userId)
        .order('sent_at', { ascending: false })
        .limit(200)

      if (error) throw error
      if (!messages) {
        set({ conversations: [], loading: false })
        return
      }

      const grouped = _.groupBy(messages, 'person_id')
      const previews: ConversationPreview[] = []

      for (const [personId, msgs] of Object.entries(grouped)) {
        if (_.isNil(personId) || personId === 'null') continue
        const sorted = _.orderBy(msgs, ['sent_at'], ['desc'])
        const latest = sorted[0]
        const person = (latest as unknown as { persons: Person })?.persons
        if (!person) continue

        previews.push({
          person,
          lastMessage: latest as Message,
          unreadCount: sorted.filter(
            (m) => m.direction === 'inbound' && m.triage !== 'noise'
          ).length,
        })
      }

      const sorted = _.orderBy(previews, [(p) => p.lastMessage.sent_at], ['desc'])
      set({ conversations: sorted, loading: false })
    } catch (err) {
      set({ error: String(err), loading: false })
    }
  },

  fetchThread: async (personId: string) => {
    try {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('person_id', personId)
        .order('sent_at', { ascending: true })
        .limit(100)

      if (error) throw error
      set({ activeThread: (data as Message[]) ?? [] })
    } catch (err) {
      console.error('Failed to fetch thread:', err)
    }
  },

  handleRealtimeMessage: (message: Message) => {
    const state = get()

    if (state.selectedPersonId === message.person_id) {
      set({ activeThread: [...state.activeThread, message] })
    }

    set((s) => {
      const existing = s.conversations.find(
        (c) => c.person.id === message.person_id
      )
      if (existing) {
        const updated = s.conversations.map((c) =>
          c.person.id === message.person_id
            ? { ...c, lastMessage: message, unreadCount: c.unreadCount + 1 }
            : c
        )
        return { conversations: _.orderBy(updated, [(p) => p.lastMessage.sent_at], ['desc']) }
      }
      return s
    })
  },
}))

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
