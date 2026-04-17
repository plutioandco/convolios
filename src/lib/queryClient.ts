import { QueryClient, QueryCache, MutationCache } from '@tanstack/react-query'
import { supabase } from './supabase'

function isAuthError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { status?: number; code?: string; message?: string }
  if (e.status === 401 || e.status === 403) return true
  if (e.code === 'PGRST301' || e.code === 'PGRST302') return true
  const msg = (e.message ?? '').toLowerCase()
  return msg.includes('jwt expired') || msg.includes('invalid jwt') || msg.includes('jwt verification')
}

let refreshInFlight: Promise<unknown> | null = null
async function refreshOnce() {
  if (!refreshInFlight) {
    refreshInFlight = supabase.auth.refreshSession().finally(() => {
      refreshInFlight = null
    })
  }
  return refreshInFlight
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (err) => {
      if (isAuthError(err)) {
        refreshOnce().then(() => {
          queryClient.invalidateQueries()
        })
      }
    },
  }),
  mutationCache: new MutationCache({
    onError: (err) => {
      if (isAuthError(err)) {
        refreshOnce()
      }
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 24 * 60 * 60_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      networkMode: 'always',
      retry: (failureCount, err) => {
        if (isAuthError(err)) return false
        return failureCount < 2
      },
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
    },
    mutations: {
      retry: (failureCount, err) => {
        if (isAuthError(err)) return false
        return failureCount < 1
      },
    },
  },
})
