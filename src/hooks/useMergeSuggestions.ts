import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import _ from 'lodash'
import { supabase } from '../lib/supabase'
import type { MergeLogEntry, MergeCluster } from '../types'

export function useMergeClusters(userId: string | undefined) {
  return useQuery({
    queryKey: ['merge-clusters', userId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_merge_clusters', { p_user_id: userId! })
      if (error) throw error
      return (data ?? []) as MergeCluster[]
    },
    enabled: _.isString(userId),
  })
}

export function useFuzzyMergeSuggestions(userId: string | undefined) {
  return useQuery({
    queryKey: ['merge-suggestions-fuzzy', userId],
    queryFn: async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) throw new Error('Not authenticated')

      const { data, error } = await supabase.functions.invoke('merge-suggestions', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (error) throw error
      return (data ?? []) as MergeCluster[]
    },
    enabled: _.isString(userId),
    staleTime: 5 * 60 * 1000,
  })
}

export function useMergeCluster(userId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ keepId, mergeIds }: { keepId: string; mergeIds: string[] }) => {
      const { data, error } = await supabase.rpc('merge_cluster', {
        p_user_id: userId!,
        p_keep_id: keepId,
        p_merge_ids: mergeIds,
      })
      if (error) throw error
      return data as string
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['merge-clusters', userId] })
      qc.invalidateQueries({ queryKey: ['merge-suggestions-fuzzy', userId] })
      qc.invalidateQueries({ queryKey: ['conversations'] })
      qc.invalidateQueries({ queryKey: ['merge-log', userId] })
      qc.invalidateQueries({ queryKey: ['thread'] })
    },
  })
}

export function useMergePersons(userId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ keepId, mergeId }: { keepId: string; mergeId: string }) => {
      const { data, error } = await supabase.rpc('merge_persons', {
        p_user_id: userId!, p_keep_id: keepId, p_merge_id: mergeId,
      })
      if (error) throw error
      return data as string
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversations'] })
      qc.invalidateQueries({ queryKey: ['merge-log', userId] })
      qc.invalidateQueries({ queryKey: ['thread'] })
    },
  })
}

export function useUndoMerge(userId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (mergeLogId: string) => {
      const { data, error } = await supabase.rpc('undo_merge', {
        p_user_id: userId!, p_merge_log_id: mergeLogId,
      })
      if (error) throw error
      return data as string
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversations'] })
      qc.invalidateQueries({ queryKey: ['merge-log', userId] })
      qc.invalidateQueries({ queryKey: ['thread'] })
    },
  })
}

export function useDismissMerge(userId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ personA, personB }: { personA: string; personB: string }) => {
      const { error } = await supabase.rpc('dismiss_merge', {
        p_user_id: userId!, p_person_a: personA, p_person_b: personB,
      })
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['merge-clusters', userId] })
      qc.invalidateQueries({ queryKey: ['merge-suggestions-fuzzy', userId] })
    },
  })
}

export function useMergeLog(userId: string | undefined) {
  return useQuery({
    queryKey: ['merge-log', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('merge_log')
        .select('*')
        .eq('user_id', userId!)
        .order('merged_at', { ascending: false })
      if (error) throw error
      return (data ?? []) as MergeLogEntry[]
    },
    enabled: _.isString(userId),
  })
}
