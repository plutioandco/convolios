import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'

export interface SnoozeArgs {
  personId: string
  snoozeUntil?: string | null
  onTheirReply?: boolean
}

export function useSnoozePerson() {
  const qc = useQueryClient()
  const { user } = useAuth()
  return useMutation({
    mutationFn: async ({ personId, snoozeUntil, onTheirReply }: SnoozeArgs) => {
      const { error } = await supabase.rpc('snooze_person', {
        p_person_id: personId,
        p_snooze_until: snoozeUntil ?? null,
        p_on_their_reply: onTheirReply ?? false,
      })
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversations', user?.id] })
      qc.invalidateQueries({ queryKey: ['state-counts', user?.id] })
    },
  })
}

export function useUnsnoozePerson() {
  const qc = useQueryClient()
  const { user } = useAuth()
  return useMutation({
    mutationFn: async (personId: string) => {
      const { error } = await supabase.rpc('unsnooze_person', { p_person_id: personId })
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversations', user?.id] })
      qc.invalidateQueries({ queryKey: ['state-counts', user?.id] })
    },
  })
}

// Useful presets. Returns ISO timestamps in UTC.
export const snoozePresets = {
  threeHours: () => new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
  tonight: () => {
    const d = new Date()
    d.setHours(20, 0, 0, 0)
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1)
    return d.toISOString()
  },
  tomorrowMorning: () => {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    d.setHours(9, 0, 0, 0)
    return d.toISOString()
  },
  nextWeek: () => {
    const d = new Date()
    d.setDate(d.getDate() + 7)
    d.setHours(9, 0, 0, 0)
    return d.toISOString()
  },
}
