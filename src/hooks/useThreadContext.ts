import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import _ from 'lodash'
import { supabase } from '../lib/supabase'
import type { ThreadContext } from '../types'

const EMPTY_CONTEXT: ThreadContext = { questions: [], commitments: [] }

export function useThreadContext(personId: string | null | undefined) {
  return useQuery({
    queryKey: ['thread-context', personId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_thread_context', { p_person_id: personId! })
      if (error) throw error
      return (data ?? EMPTY_CONTEXT) as ThreadContext
    },
    enabled: _.isString(personId),
    staleTime: 30_000,
  })
}

export function useResolveQuestion(personId: string | null | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (questionId: string) => {
      const { error } = await supabase.rpc('resolve_question', { p_question_id: questionId })
      if (error) throw error
    },
    onMutate: async (questionId) => {
      if (!_.isString(personId)) return
      await qc.cancelQueries({ queryKey: ['thread-context', personId] })
      const prev = qc.getQueryData<ThreadContext>(['thread-context', personId])
      if (prev) {
        qc.setQueryData<ThreadContext>(['thread-context', personId], {
          ...prev,
          questions: prev.questions.filter((q) => q.id !== questionId),
        })
      }
      return { prev }
    },
    onError: (_err, _vars, ctx) => {
      if (_.isString(personId) && ctx?.prev) {
        qc.setQueryData(['thread-context', personId], ctx.prev)
      }
    },
    onSettled: () => {
      if (_.isString(personId)) qc.invalidateQueries({ queryKey: ['thread-context', personId] })
      qc.invalidateQueries({ queryKey: ['commitments-count'] })
    },
  })
}

export function useResolveCommitment(personId: string | null | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (commitmentId: string) => {
      const { error } = await supabase.rpc('resolve_commitment', { p_commitment_id: commitmentId })
      if (error) throw error
    },
    onMutate: async (commitmentId) => {
      if (!_.isString(personId)) return
      await qc.cancelQueries({ queryKey: ['thread-context', personId] })
      const prev = qc.getQueryData<ThreadContext>(['thread-context', personId])
      if (prev) {
        qc.setQueryData<ThreadContext>(['thread-context', personId], {
          ...prev,
          commitments: prev.commitments.filter((c) => c.id !== commitmentId),
        })
      }
      return { prev }
    },
    onError: (_err, _vars, ctx) => {
      if (_.isString(personId) && ctx?.prev) {
        qc.setQueryData(['thread-context', personId], ctx.prev)
      }
    },
    onSettled: () => {
      if (_.isString(personId)) qc.invalidateQueries({ queryKey: ['thread-context', personId] })
      qc.invalidateQueries({ queryKey: ['commitments-count'] })
    },
  })
}

export interface CommitmentsCount {
  mine: number
  theirs: number
  questions: number
}

export function useCommitmentsCount(userId: string | undefined) {
  return useQuery({
    queryKey: ['commitments-count', userId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_open_commitments_count', { p_user_id: userId! })
      if (error) throw error
      return (data ?? { mine: 0, theirs: 0, questions: 0 }) as CommitmentsCount
    },
    enabled: _.isString(userId),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
}

export interface PersonOpenContext {
  questions: number
  myCommitments: number
  theirCommitments: number
}

export function useOpenContextsByPerson(userId: string | undefined) {
  return useQuery({
    queryKey: ['open-contexts-by-person', userId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_open_contexts_by_person', { p_user_id: userId! })
      if (error) throw error
      const map = new Map<string, PersonOpenContext>()
      for (const row of (data ?? []) as Array<{
        person_id: string; open_questions: number
        open_my_commitments: number; open_their_commitments: number
      }>) {
        map.set(row.person_id, {
          questions: Number(row.open_questions) || 0,
          myCommitments: Number(row.open_my_commitments) || 0,
          theirCommitments: Number(row.open_their_commitments) || 0,
        })
      }
      return map
    },
    enabled: _.isString(userId),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
}
