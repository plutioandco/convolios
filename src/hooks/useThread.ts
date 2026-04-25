import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo } from 'react'
import { create } from 'zustand'
import _ from 'lodash'
import { supabase } from '../lib/supabase'
import type { Message } from '../types'

const PAGE_SIZE = 80

// ─── Pending messages store ───────────────────────────────────────────────────
// Zustand so React sees a fresh reference on every mutation (no tearing under
// concurrent rendering). Lives outside React Query so refetches never discard
// unsent messages.

interface PendingState {
  byPerson: Record<string, Message[]>
  add: (personId: string, msg: Message) => void
  markFailed: (personId: string, optId: string, reason?: string) => void
  remove: (personId: string, optId: string) => void
  patchExternalId: (personId: string, optId: string, externalId: string) => void
}

const usePendingStore = create<PendingState>((set) => ({
  byPerson: {},
  add: (personId, msg) =>
    set((state) => ({
      byPerson: {
        ...state.byPerson,
        [personId]: [...(state.byPerson[personId] ?? []), { ...msg, _pending: true }],
      },
    })),
  markFailed: (personId, optId, reason) =>
    set((state) => {
      const list = state.byPerson[personId]
      if (!list) return state
      return {
        byPerson: {
          ...state.byPerson,
          [personId]: list.map((m) => (m.id === optId ? { ...m, _failed: true, _failedReason: reason } : m)),
        },
      }
    }),
  remove: (personId, optId) =>
    set((state) => {
      const list = state.byPerson[personId]
      if (!list) return state
      const next = list.filter((m) => m.id !== optId)
      const byPerson = { ...state.byPerson }
      if (next.length) byPerson[personId] = next
      else delete byPerson[personId]
      return { byPerson }
    }),
  patchExternalId: (personId, optId, externalId) =>
    set((state) => {
      const list = state.byPerson[personId]
      if (!list) return state
      return {
        byPerson: {
          ...state.byPerson,
          [personId]: list.map((m) => (m.id === optId ? { ...m, external_id: externalId } : m)),
        },
      }
    }),
}))

export function addPendingMessage(personId: string, msg: Message) {
  usePendingStore.getState().add(personId, msg)
}

export function markPendingFailed(personId: string, optId: string, reason?: string) {
  usePendingStore.getState().markFailed(personId, optId, reason)
}

export function removePending(personId: string, optId: string) {
  usePendingStore.getState().remove(personId, optId)
}

export function patchPendingExternalId(personId: string, optId: string, externalId: string) {
  usePendingStore.getState().patchExternalId(personId, optId, externalId)
}

const EMPTY: Message[] = []

function usePendingMessages(personId: string | null): Message[] {
  return usePendingStore((s) => (personId ? s.byPerson[personId] ?? EMPTY : EMPTY))
}

function isMatch(real: Message, opt: Message): boolean {
  if (real.direction !== 'outbound') return false
  if (_.isString(real.external_id) && _.isString(opt.external_id)) {
    return real.external_id === opt.external_id
  }
  if ((real.body_text ?? '').trim() !== (opt.body_text ?? '').trim()) return false
  const realT = new Date(real.sent_at).getTime()
  const optT = new Date(opt.sent_at).getTime()
  return Math.abs(realT - optT) < 60_000
}

function dedup(raw: Message[]): Message[] {
  const seenExtIds = new Set<string>()
  const pass1 = raw.filter((m) => {
    if (!_.isString(m.external_id)) return true
    if (seenExtIds.has(m.external_id)) return false
    seenExtIds.add(m.external_id)
    return true
  })

  const seenContent = new Set<string>()
  return pass1.filter((m) => {
    if (_.isString(m.external_id)) return true
    const key = `${m.direction}:${m.sent_at}:${m.body_text ?? ''}`
    if (seenContent.has(key)) return false
    seenContent.add(key)
    return true
  })
}

// ─── useThread ────────────────────────────────────────────────────────────────

export function useThread(personId: string | null, userId?: string, realtimeConnected?: boolean) {
  const pendingMsgs = usePendingMessages(personId)

  const query = useInfiniteQuery({
    queryKey: ['thread', personId, userId],
    queryFn: async ({ pageParam }): Promise<Message[]> => {
      let q = supabase
        .from('messages')
        .select('*')
        .eq('person_id', personId!)
        .order('sent_at', { ascending: false })
        .limit(PAGE_SIZE)

      if (_.isString(userId)) {
        q = q.eq('user_id', userId)
      }

      if (_.isString(pageParam)) {
        q = q.lt('sent_at', pageParam)
      }

      const { data, error } = await q
      if (error) throw error
      return (data as Message[]) ?? []
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => {
      if (lastPage.length < PAGE_SIZE) return undefined
      return lastPage[lastPage.length - 1]?.sent_at
    },
    enabled: _.isString(personId) && _.isString(userId),
    refetchInterval: realtimeConnected === false ? 15_000 : false,
  })

  const realMessages = useMemo(() => {
    if (!query.data?.pages) return []
    const flat = query.data.pages.flatMap((page) => page)
    const chronological = [...flat].reverse()
    return dedup(chronological)
  }, [query.data])

  useEffect(() => {
    if (!personId || pendingMsgs.length === 0 || realMessages.length === 0) return
    for (const opt of pendingMsgs) {
      if (realMessages.some((real) => isMatch(real, opt))) {
        removePending(personId, opt.id)
      }
    }
  }, [personId, pendingMsgs, realMessages])

  const unmatched = pendingMsgs.filter(
    (opt) => !realMessages.some((real) => isMatch(real, opt))
  )

  const merged = unmatched.length > 0
    ? [...realMessages, ...unmatched]
    : realMessages

  return {
    data: merged,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    hasMore: query.hasNextPage ?? false,
    loadMore: query.fetchNextPage,
    isLoadingMore: query.isFetchingNextPage,
  }
}

export function useCancelThreadQueries(personId: string | null, userId?: string) {
  const qc = useQueryClient()
  return useCallback(() => {
    if (!_.isString(personId)) return
    qc.cancelQueries({ queryKey: ['thread', personId, userId] })
  }, [qc, personId, userId])
}
