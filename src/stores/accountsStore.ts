import { create } from 'zustand'
import { supabase } from '../lib/supabase'
import type { ConnectedAccount } from '../types'

interface AccountsState {
  accounts: ConnectedAccount[]
  loading: boolean
  error: string | null
  fetchAccounts: (userId: string) => Promise<void>
  addAccount: (account: Omit<ConnectedAccount, 'id' | 'created_at' | 'updated_at'>) => Promise<void>
}

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
}))
