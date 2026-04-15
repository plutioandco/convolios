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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['circles', userId] }),
  })
}

export function useDeleteCircle(userId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('circles').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['circles', userId] }),
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
    },
  })
}

export function usePendingCount(userId: string | undefined, realtimeConnected?: boolean) {
  const interval = realtimeConnected === false ? 8_000 : 30_000
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

export interface SidebarUnread {
  channels: Record<string, number>
  circles: Record<string, number>
  total: number
}

export function useSidebarUnread(userId: string | undefined, realtimeConnected?: boolean) {
  const interval = realtimeConnected === false ? 8_000 : 30_000
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
