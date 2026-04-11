import { useEffect, useState } from 'react'
import _ from 'lodash'
import type { User, Session } from '@supabase/supabase-js'
import { supabase } from './supabase'

interface AuthState {
  user: User | null
  session: Session | null
  loading: boolean
}

function extractTokensFromUrl(url: string): { access_token: string; refresh_token: string } | null {
  const hashIdx = url.indexOf('#')
  if (hashIdx === -1) return null
  const fragment = url.slice(hashIdx + 1)
  const params = new URLSearchParams(fragment)
  const access_token = params.get('access_token')
  const refresh_token = params.get('refresh_token')
  if (_.isString(access_token) && _.isString(refresh_token)) {
    return { access_token, refresh_token }
  }
  return null
}

async function handleDeepLinkUrls(urls: string[]) {
  for (const url of urls) {
    const tokens = extractTokensFromUrl(url)
    if (tokens) {
      await supabase.auth.setSession(tokens).catch(() => {})
      return
    }
  }
}

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({ user: null, session: null, loading: true })

  useEffect(() => {
    supabase.auth.getSession()
      .then(({ data: { session } }) => {
        setState({ user: session?.user ?? null, session, loading: false })
      })
      .catch(() => {
        setState({ user: null, session: null, loading: false })
      })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({ user: session?.user ?? null, session, loading: false })
    })

    let unlisten: (() => void) | null = null

    import('@tauri-apps/plugin-deep-link').then(({ getCurrent, onOpenUrl }) => {
      getCurrent().then((urls) => {
        if (urls) handleDeepLinkUrls(urls)
      }).catch(() => {})

      onOpenUrl((urls) => {
        handleDeepLinkUrls(urls)
      }).then((fn) => { unlisten = fn }).catch(() => {})
    }).catch(() => {})

    return () => {
      subscription.unsubscribe()
      unlisten?.()
    }
  }, [])

  return state
}

export async function signOut() {
  await supabase.auth.signOut()
}
