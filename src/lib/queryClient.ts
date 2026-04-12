import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 24 * 60 * 60_000,
      refetchOnWindowFocus: true,
      networkMode: 'offlineFirst',
      retry: 1,
    },
  },
})
