import { create } from 'zustand'
import _ from 'lodash'
import { supabase } from '../lib/supabase'
import type { ConnectedAccount } from '../types'
import type { RealtimeChannel } from '@supabase/supabase-js'

interface AccountsState {
  accounts: ConnectedAccount[]
  loading: boolean
  error: string | null
  fetchAccounts: (userId: string) => Promise<void>
  addAccount: (account: Omit<ConnectedAccount, 'id' | 'created_at' | 'updated_at'>) => Promise<void>
  removeAccount: (accountId: string) => void
  subscribe: (userId: string) => void
  unsubscribe: () => void
}

let _channel: RealtimeChannel | null = null
let _pollTimer: ReturnType<typeof setInterval> | null = null
let _debouncedRefetch: ReturnType<typeof _.debounce> | null = null

export const useAccountsStore = create<AccountsState>((set, get) => ({
  accounts: [],
  loading: false,
  error: null,

  fetchAccounts: async (userId: string) => {
    set({ loading: true, error: null })
    try {
      const { data, error } = await supabase
        .from('connected_accounts')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })

      if (error) throw error
      set({ accounts: (data as ConnectedAccount[]) ?? [], loading: false })
    } catch (err) {
      set({ error: String(err), loading: false })
    }
  },

  addAccount: async (account) => {
    try {
      const { data, error } = await supabase
        .from('connected_accounts')
        .insert(account)
        .select()
        .single()

      if (error) throw error
      set({ accounts: [data as ConnectedAccount, ...get().accounts] })
    } catch (err) {
      set({ error: String(err) })
    }
  },

  removeAccount: (accountId: string) => {
    set({ accounts: get().accounts.filter((a) => a.account_id !== accountId) })
  },

  subscribe: (userId: string) => {
    const { unsubscribe } = get()
    unsubscribe()

    const refetch = _.debounce(() => get().fetchAccounts(userId), 500, { leading: true, trailing: true })
    _debouncedRefetch = refetch

    _channel = supabase
      .channel('connected-accounts-realtime')
      .on<ConnectedAccount>(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'connected_accounts', filter: `user_id=eq.${userId}` },
        (payload) => {
          if (import.meta.env.DEV) console.debug('[realtime] connected_accounts event', payload.eventType)
          refetch()
        },
      )
      .subscribe((status) => {
        if (import.meta.env.DEV) console.debug('[realtime] connected_accounts', status)
        if (status === 'SUBSCRIBED') {
          if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null }
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          if (!_pollTimer) {
            _pollTimer = setInterval(() => get().fetchAccounts(userId), 10_000)
          }
        }
      })
  },

  unsubscribe: () => {
    _debouncedRefetch?.cancel()
    _debouncedRefetch = null
    if (_channel) {
      supabase.removeChannel(_channel)
      _channel = null
    }
    if (_pollTimer) {
      clearInterval(_pollTimer)
      _pollTimer = null
    }
  },
}))
