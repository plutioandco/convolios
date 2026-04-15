import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { useSyncExternalStore, useCallback, useEffect, useMemo } from 'react'
import _ from 'lodash'
import { supabase } from '../lib/supabase'
import type { Message } from '../types'

const PAGE_SIZE = 80

// ─── Pending messages store ───────────────────────────────────────────────────
// Lives outside React Query so refetches never discard unsent messages.

const pending = new Map<string, Message[]>()
let listeners = new Set<() => void>()
const notify = () => listeners.forEach((fn) => fn())

function getSnapshot() { return pending }
function subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb) } }

export function addPendingMessage(personId: string, msg: Message) {
  const list = pending.get(personId) ?? []
  pending.set(personId, [...list, { ...msg, _pending: true }])
  notify()
}

export function markPendingFailed(personId: string, optId: string) {
  const list = pending.get(personId)
  if (!list) return
  pending.set(personId, list.map((m) => m.id === optId ? { ...m, _failed: true } : m))
  notify()
}

export function removePending(personId: string, optId: string) {
  const list = pending.get(personId)
  if (!list) return
  const next = list.filter((m) => m.id !== optId)
  if (next.length) pending.set(personId, next)
  else pending.delete(personId)
  notify()
}

export function patchPendingExternalId(personId: string, optId: string, externalId: string) {
  const list = pending.get(personId)
  if (!list) return
  pending.set(personId, list.map((m) => m.id === optId ? { ...m, external_id: externalId } : m))
  notify()
}

function usePendingMessages(personId: string | null): Message[] {
  const store = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return personId ? store.get(personId) ?? [] : []
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
  const interval = realtimeConnected === false ? 8_000 : 30_000
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
    refetchInterval: interval,
    staleTime: 30_000,
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
