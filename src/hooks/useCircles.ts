import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import _ from 'lodash'
import { supabase } from '../lib/supabase'
import type { Circle } from '../types'

export function useCircles(userId: string | undefined) {
  return useQuery({
    queryKey: ['circles', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('circles')
        .select('*')
        .eq('user_id', userId!)
        .order('sort_order')
      if (error) throw error
      return (data ?? []) as Circle[]
    },
    enabled: _.isString(userId),
  })
}

export function useCreateCircle(userId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (circle: { name: string; color?: string; emoji?: string }) => {
      const { data, error } = await supabase
        .from('circles')
        .insert({ user_id: userId!, ...circle })
        .select()
        .single()
      if (error) throw error
      return data as Circle
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['circles', userId] }),
  })
}

export function useUpdateCircle(userId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, ...updates }: Partial<Circle> & { id: string }) => {
      const { error } = await supabase.from('circles').update(updates).eq('id', id)
      if (error) throw error
    },
    onMutate: async ({ id, ...updates }) => {
      await qc.cancelQueries({ queryKey: ['circles', userId] })
      await qc.cancelQueries({ queryKey: ['person-circle-colors', userId] })

      const prevCircles = qc.getQueryData<Circle[]>(['circles', userId])
      const prevColors = qc.getQueryData<Map<string, string[]>>(['person-circle-colors', userId])

      if (prevCircles) {
        qc.setQueryData<Circle[]>(['circles', userId],
          prevCircles.map((c) => c.id === id ? { ...c, ...updates } : c)
        )
      }

      if (_.isString(updates.color) && prevCircles && prevColors) {
        const oldColor = prevCircles.find((c) => c.id === id)?.color
        if (_.isString(oldColor) && oldColor !== updates.color) {
          const newMap = new Map(prevColors)
          for (const [personId, colors] of newMap) {
            const idx = colors.indexOf(oldColor)
            if (idx !== -1) {
              const updated = [...colors]
              updated[idx] = updates.color
              newMap.set(personId, updated)
            }
          }
          qc.setQueryData(['person-circle-colors', userId], newMap)
        }
      }

      return { prevCircles, prevColors }
    },
    onError: (_err, _vars, context) => {
      if (context?.prevCircles) qc.setQueryData(['circles', userId], context.prevCircles)
      if (context?.prevColors) qc.setQueryData(['person-circle-colors', userId], context.prevColors)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['circles', userId] })
      qc.invalidateQueries({ queryKey: ['person-circle-colors', userId] })
    },
  })
}

export function useDeleteCircle(userId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('circles').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['circles', userId] })
      qc.invalidateQueries({ queryKey: ['person-circle-colors', userId] })
    },
  })
}

export function useAddToCircle(userId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ circleId, personId }: { circleId: string; personId: string }) => {
      const { error } = await supabase
        .from('circle_members')
        .upsert({ circle_id: circleId, person_id: personId }, { onConflict: 'circle_id,person_id' })
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['circles', userId] })
      qc.invalidateQueries({ queryKey: ['conversations'] })
      qc.invalidateQueries({ queryKey: ['person-circle-colors', userId] })
    },
  })
}

export function useRemoveFromCircle(userId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ circleId, personId }: { circleId: string; personId: string }) => {
      const { error } = await supabase
        .from('circle_members')
        .delete()
        .eq('circle_id', circleId)
        .eq('person_id', personId)
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['circles', userId] })
      qc.invalidateQueries({ queryKey: ['conversations'] })
      qc.invalidateQueries({ queryKey: ['person-circle-colors', userId] })
    },
  })
}

export function usePendingCount(userId: string | undefined, realtimeConnected?: boolean) {
  const interval = realtimeConnected === false ? 15_000 : 60_000
  return useQuery({
    queryKey: ['pending-count', userId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_pending_count', { p_user_id: userId! })
      if (error) throw error
      return Number(data) || 0
    },
    enabled: _.isString(userId),
    refetchInterval: interval,
    staleTime: 30_000,
  })
}

export function useBlockedCount(userId: string | undefined) {
  return useQuery({
    queryKey: ['blocked-count', userId],
    queryFn: async () => {
      const { count, error } = await supabase
        .from('persons')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId!)
        .eq('status', 'blocked')
      if (error) throw error
      return count ?? 0
    },
    enabled: _.isString(userId),
    staleTime: 60_000,
  })
}

export function useApprovePerson(userId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (personId: string) => {
      const { error } = await supabase.rpc('approve_person', { p_user_id: userId!, p_person_id: personId })
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversations'] })
      qc.invalidateQueries({ queryKey: ['pending-count', userId] })
      qc.invalidateQueries({ queryKey: ['blocked-count', userId] })
      qc.invalidateQueries({ queryKey: ['sidebar-unread', userId] })
    },
  })
}

export function useBlockPerson(userId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (personId: string) => {
      const { error } = await supabase.rpc('block_person', { p_user_id: userId!, p_person_id: personId })
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversations'] })
      qc.invalidateQueries({ queryKey: ['pending-count', userId] })
      qc.invalidateQueries({ queryKey: ['blocked-count', userId] })
      qc.invalidateQueries({ queryKey: ['sidebar-unread', userId] })
    },
  })
}

export function usePersonCircleColors(userId: string | undefined) {
  return useQuery({
    queryKey: ['person-circle-colors', userId],
    queryFn: async () => {
      const { data: circles, error: cErr } = await supabase
        .from('circles')
        .select('id, color, sort_order')
        .eq('user_id', userId!)
        .order('sort_order')
      if (cErr) throw cErr

      const circleIds = (circles ?? []).map((c) => c.id)
      if (!circleIds.length) return new Map<string, string[]>()

      const { data: members, error: mErr } = await supabase
        .from('circle_members')
        .select('circle_id, person_id')
        .in('circle_id', circleIds)
      if (mErr) throw mErr

      const membersByCircle = new Map<string, string[]>()
      for (const m of members ?? []) {
        const list = membersByCircle.get(m.circle_id)
        if (list) list.push(m.person_id)
        else membersByCircle.set(m.circle_id, [m.person_id])
      }

      const map = new Map<string, string[]>()
      for (const circle of circles!) {
        const personIds = membersByCircle.get(circle.id) ?? []
        for (const personId of personIds) {
          const existing = map.get(personId)
          if (existing) existing.push(circle.color)
          else map.set(personId, [circle.color])
        }
      }
      return map
    },
    enabled: _.isString(userId),
    staleTime: 60_000,
  })
}

export interface SidebarUnread {
  channels: Record<string, number>
  circles: Record<string, number>
  total: number
}

export function useSidebarUnread(userId: string | undefined, realtimeConnected?: boolean) {
  const interval = realtimeConnected === false ? 15_000 : 60_000
  return useQuery({
    queryKey: ['sidebar-unread', userId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_sidebar_unread', { p_user_id: userId! })
      if (error) throw error
      return (data ?? { channels: {}, circles: {}, total: 0 }) as SidebarUnread
    },
    enabled: _.isString(userId),
    refetchInterval: interval,
    staleTime: 15_000,
  })
}

export interface StateCounts {
  my_turn: number
  their_turn: number
  stalled: number
  dropped: number
  done: number
  gate: number
  snoozed: number
}

const EMPTY_STATE_COUNTS: StateCounts = {
  my_turn: 0, their_turn: 0, stalled: 0, dropped: 0, done: 0, gate: 0, snoozed: 0,
}

export function useStateCounts(userId: string | undefined, realtimeConnected?: boolean) {
  const interval = realtimeConnected === false ? 15_000 : 60_000
  return useQuery({
    queryKey: ['state-counts', userId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_state_counts', { p_user_id: userId! })
      if (error) throw error
      return (data ?? EMPTY_STATE_COUNTS) as StateCounts
    },
    enabled: _.isString(userId),
    refetchInterval: interval,
    staleTime: 15_000,
  })
}
