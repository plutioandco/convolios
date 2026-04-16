import { useState, useEffect, createContext, useContext, Component, useMemo, useCallback, useRef } from 'react'
import type { ReactNode, ErrorInfo } from 'react'
import { Routes, Route, useNavigate } from 'react-router-dom'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Sidebar } from './components/sidebar/Sidebar'
import { AlertTriangle, WifiOff, Search } from 'lucide-react'
import { InboxList } from './components/inbox/InboxList'
import { ThreadView } from './components/thread/ThreadView'
import { Settings } from './components/settings/Settings'
import { useInboxStore, useSyncStore, useFilterStore } from './stores/inboxStore'
import { useRealtimeMessages } from './hooks/useRealtimeMessages'
import { useConversations } from './hooks/useConversations'
import { useAuth, signOut } from './lib/auth'
import { useUpdater } from './hooks/useUpdater'
import { supabase } from './lib/supabase'
import { queryClient } from './lib/queryClient'
import { useAccountsStore } from './stores/accountsStore'
import { channelLabel, channelColor, accountDisplayLabel, initials, avatarCls, relativeTime, cleanPreviewText } from './utils'
import { ChannelLogo } from './components/icons/ChannelLogo'
import type { ConnectedAccount, Channel } from './types'
import _ from 'lodash'

const persister = createSyncStoragePersister({
  storage: window.localStorage,
  key: 'convolios-query-cache-v9',
})

for (const k of Object.keys(window.localStorage)) {
  if (k.startsWith('convolios-query-cache') && k !== 'convolios-query-cache-v9') {
    window.localStorage.removeItem(k)
  }
}

const PERSIST_ALLOWED_KEYS = new Set([
  'conversations', 'circles', 'sidebar-unread', 'pending-count',
])

const RealtimeContext = createContext(true)
export const useRealtimeConnected = () => useContext(RealtimeContext)

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) console.error('[ErrorBoundary]', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="app-error-fullscreen">
          <span className="app-error-title">Something went wrong</span>
          <span className="app-error-msg">{this.state.error.message}</span>
          <button
            type="button"
            className="app-btn-primary"
            onClick={() => { this.setState({ error: null }); window.location.reload() }}
          >
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

class SectionErrorBoundary extends Component<{ children: ReactNode; name: string }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) console.error(`[${this.props.name}]`, error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="app-section-error">
          <span className="app-section-error-title">{this.props.name} failed to load</span>
          <span className="app-section-error-msg">{this.state.error.message}</span>
          <button type="button" className="app-btn-primary app-btn-primary-sm" onClick={() => this.setState({ error: null })}>
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

function UpdateBanner() {
  const { updateAvailable, updating, version, installUpdate } = useUpdater()
  if (!updateAvailable) return null
  return (
    <div className="flex items-center justify-between px-4 py-2 bg-blue-600 text-white text-sm">
      <span>Update {version} available</span>
      <button
        onClick={installUpdate}
        disabled={updating}
        className="px-3 py-1 bg-white text-blue-600 rounded text-xs font-medium hover:bg-blue-50 disabled:opacity-50"
      >
        {updating ? 'Updating...' : 'Restart & Update'}
      </button>
    </div>
  )
}

function App() {
  const { user, loading } = useAuth()

  return (
    <ErrorBoundary>
    <PersistQueryClientProvider client={queryClient} persistOptions={{
      persister,
      maxAge: 24 * 60 * 60 * 1000,
      dehydrateOptions: {
        shouldDehydrateQuery: (query) => {
          const key = query.queryKey[0] as string
          if (!PERSIST_ALLOWED_KEYS.has(key)) return false
          return query.state.status === 'success'
        },
      },
    }}>
      <UpdateBanner />
      <div className="flex w-full h-screen overflow-hidden bg-surface-deep">
        {user ? <Authenticated userId={user.id} /> : loading ? <AppShellSkeleton /> : <SignInScreen />}
      </div>
    </PersistQueryClientProvider>
    </ErrorBoundary>
  )
}

function AppShellSkeleton() {
  return (
    <div className="app-shell">
      <div className="app-main">
        <nav className="sidebar-nav">
          <div className="flex flex-col items-center gap-2 pt-2">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="skeleton w-12 h-12 rounded-2xl shrink-0" />
            ))}
          </div>
        </nav>
        <div className="inbox-panel">
          <div className="inbox-search-bar">
            <div className="skeleton h-8 rounded-md mx-3 mt-1" />
          </div>
          <div className="px-2 pt-3">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="inbox-skeleton-row">
                <div className="skeleton w-[42px] h-[42px] rounded-full shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <div className="skeleton h-3.5 rounded-sm flex-1" style={{ maxWidth: `${60 + (i % 3) * 15}%` }} />
                    <div className="skeleton h-2.5 rounded-sm w-8 shrink-0" />
                  </div>
                  <div className="skeleton h-2.5 rounded-sm mb-1" style={{ width: `${40 + (i % 4) * 12}%` }} />
                  <div className="skeleton h-2.5 rounded-sm" style={{ width: `${55 + (i % 3) * 10}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="app-content-col" />
      </div>
    </div>
  )
}

function SignInScreen() {
  const [email, setEmail] = useState('')
  const [otp, setOtp] = useState('')
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  const sendCode = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim()) return
    setStatus('loading')
    setErrorMsg('')
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: 'convolios://auth' },
    })
    if (error) {
      if (error.message.toLowerCase().includes('rate limit')) {
        setStep('code')
        setStatus('idle')
        setErrorMsg('')
      } else {
        setStatus('error')
        setErrorMsg(error.message)
      }
    } else {
      setStatus('idle')
      setStep('code')
    }
  }

  const verifyCode = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!otp.trim()) return
    setStatus('loading')
    setErrorMsg('')
    const { error } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: otp.trim(),
      type: 'email',
    })
    if (error) {
      setStatus('error')
      setErrorMsg(error.message)
    } else {
      setStatus('idle')
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="avatar avatar--hero av-1 mb-4">C</div>
        <h1 className="auth-title">Convolios</h1>
        <p className="auth-subtitle">All your messages. One inbox.</p>

        {step === 'code' ? (
          <form onSubmit={verifyCode}>
            <p className="auth-hint">
              Enter the 6-digit code sent to <strong className="text-text-primary">{email}</strong>
            </p>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              autoFocus
              placeholder="000000"
              className="auth-input auth-input--otp"
            />
            {status === 'error' && (
              <p className="auth-error">{errorMsg}</p>
            )}
            <button type="submit" disabled={status === 'loading' || otp.length < 6} className="auth-btn">
              {status === 'loading' ? 'Verifying...' : 'Verify'}
            </button>
            <div className="auth-links">
              <button
                type="button"
                onClick={() => { setStep('email'); setOtp(''); setErrorMsg('') }}
                className="auth-link"
              >Different email</button>
              <button
                type="button"
                onClick={async () => {
                  setErrorMsg('')
                  setStatus('loading')
                  const { error } = await supabase.auth.signInWithOtp({
                    email: email.trim(),
                    options: { emailRedirectTo: 'convolios://auth' },
                  })
                  setStatus(error ? 'error' : 'idle')
                  if (error) setErrorMsg(error.message)
                }}
                className="auth-link"
              >Resend code</button>
            </div>
          </form>
        ) : (
          <form onSubmit={sendCode}>
            <label className="auth-label">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              placeholder="you@example.com"
              className="auth-input"
            />
            {status === 'error' && (
              <p className="auth-error">{errorMsg}</p>
            )}
            <button type="submit" disabled={status === 'loading'} className="auth-btn">
              {status === 'loading' ? 'Sending...' : 'Continue'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

function Authenticated({ userId }: { userId: string }) {
  const { connected, dead, reconnect } = useRealtimeMessages(userId)
  const fetchAccounts = useAccountsStore((s) => s.fetchAccounts)
  const subscribe = useAccountsStore((s) => s.subscribe)
  const unsubscribe = useAccountsStore((s) => s.unsubscribe)
  const accounts = useAccountsStore((s) => s.accounts)
  const [online, setOnline] = useState(navigator.onLine)
  const [searchOpen, setSearchOpen] = useState(false)
  const nav = useNavigate()

  const disconnectedAccounts = useMemo(
    () => accounts.filter((a) => a.status === 'credentials' || a.status === 'error' || a.status === 'disconnected'),
    [accounts],
  )

  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setSearchOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    fetchAccounts(userId)
    subscribe(userId)
    invoke('startup_sync', { userId }).then(() => {
      queryClient.invalidateQueries({ queryKey: ['conversations', userId] })
    }).catch((e: unknown) => {
      if (import.meta.env.DEV) console.warn('[startup_sync]', e)
    })

    const syncInterval = setInterval(() => {
      invoke('startup_sync', { userId }).then(() => {
        queryClient.invalidateQueries({ queryKey: ['conversations', userId] })
      }).catch((e: unknown) => {
        if (import.meta.env.DEV) console.warn('[periodic_sync]', e)
      })
    }, 300_000)

    const unlistenDisconnect = listen('account-disconnected', () => {
      queryClient.clear()
      try { window.localStorage.removeItem('convolios-query-cache-v9') } catch { /* best-effort */ }
      useInboxStore.getState().selectPerson(null)
      fetchAccounts(userId)
    })

    const { markDone } = useSyncStore.getState()
    const unlistenSync = listen<{ phase: string; detail?: string }>('sync-status', (event) => {
      const { phase, detail } = event.payload
      if (phase === 'done' || phase === 'idle') {
        markDone(detail ?? '')
      }
    })

    return () => {
      clearInterval(syncInterval)
      unsubscribe()
      unlistenDisconnect.then((fn) => fn())
      unlistenSync.then((fn) => fn())
    }
  }, [userId, fetchAccounts, subscribe, unsubscribe])

  return (
    <RealtimeContext.Provider value={connected}>
    <div className="app-shell">
      {!online && (
        <div className="app-banner app-banner--danger">
          <WifiOff size={14} />
          <span>You are offline — messages will sync when reconnected</span>
        </div>
      )}
      {dead && (
        <div className="app-banner app-banner--danger">
          <span>Live updates paused — polling every 8s</span>
          <button onClick={reconnect} className="bg-[var(--hover-accent)] text-sm font-semibold px-2.5 py-0.5 rounded-sm">Retry</button>
        </div>
      )}
      {!dead && !connected && online && (
        <div className="app-banner app-banner--warning">
          <span className="pulse-dot w-1.5 h-1.5 rounded-full bg-black" />
          <span className="text-sm">Connecting...</span>
        </div>
      )}
      {disconnectedAccounts.length > 0 && (
        <div className="app-banner app-banner--warning-subtle">
          <AlertTriangle size={13} />
          <span className="text-sm">
            {disconnectedAccounts.length === 1
              ? `${channelLabel(disconnectedAccounts[0].channel)} needs reconnecting`
              : `${disconnectedAccounts.length} accounts need reconnecting`}
          </span>
          <button onClick={() => nav('/settings')} className="app-banner-link text-sm p-0">
            Fix in Settings
          </button>
        </div>
      )}
      <div className="app-main">
        <Sidebar />
        <Routes>
          <Route path="/" element={<InboxRoute userId={userId} realtimeConnected={connected} />} />
          <Route path="/settings" element={<SettingsRoute />} />
        </Routes>
      </div>
      {searchOpen && (
        <SearchModal
          userId={userId}
          onClose={() => setSearchOpen(false)}
          onSelectPerson={(personId) => {
            setSearchOpen(false)
            useInboxStore.getState().selectPerson(personId)
            nav('/')
          }}
        />
      )}
    </div>
    </RealtimeContext.Provider>
  )
}

function InboxRoute({ userId, realtimeConnected }: { userId: string; realtimeConnected: boolean }) {
  const pid = useInboxStore((s) => s.selectedPersonId)
  const pick = useInboxStore((s) => s.selectPerson)
  const { data: convos = [] } = useConversations(userId, realtimeConnected, 'approved')
  const { data: pendingConvos = [] } = useConversations(userId, realtimeConnected, 'pending')
  const ch = useInboxStore((s) => s.activeChannel)
  const accounts = useAccountsStore((s) => s.accounts)
  const accountsLoading = useAccountsStore((s) => s.loading)
  const selectedConvo = useMemo(() =>
    convos.find((c) => c.person.id === pid) ?? pendingConvos.find((c) => c.person.id === pid),
    [convos, pendingConvos, pid]
  )
  const person = selectedConvo?.person
  const nav = useNavigate()

  const activeChannel = selectedConvo?.lastMessage?.channel ?? (ch !== 'all' ? ch : undefined)
  const channelAccount = _.isString(activeChannel)
    ? accounts.find((a) => a.channel === activeChannel && a.status === 'active')
    : undefined

  const filteredIds = useMemo(() => {
    const triageFilter = useFilterStore.getState().triageFilter
    return convos
      .filter((c) => ch === 'all' || c.lastMessage.channel === ch)
      .filter((c) => triageFilter === 'all' || c.lastMessage.triage === triageFilter)
      .map((c) => c.person.id)
  }, [convos, ch])

  const handleKeyNav = useCallback((e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const idx = pid ? filteredIds.indexOf(pid) : -1
      const next = e.key === 'ArrowDown'
        ? Math.min(idx + 1, filteredIds.length - 1)
        : Math.max(idx - 1, 0)
      if (filteredIds[next]) pick(filteredIds[next])
    }

    if (e.key === 'Escape' && pid) {
      e.preventDefault()
      pick(null)
    }
  }, [pid, filteredIds, pick])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyNav)
    return () => window.removeEventListener('keydown', handleKeyNav)
  }, [handleKeyNav])

  if (!accountsLoading && accounts.length === 0) {
    return <WelcomeOnboarding onGoToSettings={() => nav('/settings')} />
  }

  return (
    <div className="app-inbox-route">
      <SectionErrorBoundary name="Inbox">
        <InboxList />
      </SectionErrorBoundary>
      <div className="app-content-col">
        <TopBar>
          {person ? (
            <>
              {person.avatar_url
                ? <img src={person.avatar_url} alt="" className="w-6 h-6 rounded-full object-cover" />
                : <span className="avatar avatar--sm av-1">{person.display_name?.charAt(0)?.toUpperCase()}</span>}
              <span className="top-bar-title">{person.display_name}</span>
              {channelAccount && <ConnectionPill account={channelAccount} />}
            </>
          ) : (
            <>
              <span className="top-bar-title">{ch === 'all' ? 'All Messages' : channelLabel(ch)}</span>
              {channelAccount && <ConnectionPill account={channelAccount} />}
            </>
          )}
        </TopBar>
        <SectionErrorBoundary name="Messages">
          <ThreadView />
        </SectionErrorBoundary>
      </div>
    </div>
  )
}

function SettingsRoute() {
  return (
    <div className="app-content-col">
      <TopBar>
        <span className="top-bar-title">Settings</span>
      </TopBar>
      <SectionErrorBoundary name="Settings">
        <Settings />
      </SectionErrorBoundary>
    </div>
  )
}

function TopBar({ children }: { children: React.ReactNode }) {
  return (
    <header className="top-bar">
      <div className="top-bar-left">{children}</div>
      <button
        onClick={signOut}
        className="text-text-muted text-md px-2 py-1"
        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-danger)' }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-muted)' }}
      >
        Sign out
      </button>
    </header>
  )
}

function ConnectionPill({ account }: { account: ConnectedAccount }) {
  const color = channelColor(account.channel)
  const text = accountDisplayLabel(account)
  return (
    <span className="connection-pill">
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} />
      <ChannelLogo channel={account.channel} size={12} color={color} />
      {text}
    </span>
  )
}

function WelcomeOnboarding({ onGoToSettings }: { onGoToSettings: () => void }) {
  return (
    <div className="welcome-screen">
      <div className="text-center max-w-[420px]">
        <div className="avatar avatar--hero av-1 mb-5">C</div>
        <h1 className="welcome-title">Welcome to Convolios</h1>
        <p className="text-body text-text-secondary mt-2 leading-normal">
          All your messages, one inbox. Connect your first account to get started.
        </p>
        <button
          onClick={onGoToSettings}
          className="btn-primary btn-primary-lg mt-6"
        >
          Connect an Account
        </button>
        <p className="text-md text-text-pending mt-3">
          WhatsApp, Gmail, LinkedIn, Instagram, Telegram, and more
        </p>
      </div>
    </div>
  )
}

interface SearchResult {
  message_id: string
  person_id: string
  display_name: string
  avatar_url: string | null
  channel: string
  body_text: string | null
  subject: string | null
  sent_at: string
}

function SearchModal({ userId, onClose, onSelectPerson }: {
  userId: string
  onClose: () => void
  onSelectPerson: (personId: string) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const rtConnected = useRealtimeConnected()
  const { data: convos = [] } = useConversations(userId, rtConnected, 'approved')

  useEffect(() => { inputRef.current?.focus() }, [])

  const personMatches = useMemo(() => {
    if (!query.trim()) return []
    const q = query.toLowerCase()
    return convos
      .filter((c) => c.person.display_name.toLowerCase().includes(q))
      .slice(0, 5)
  }, [query, convos])

  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); return }
    setLoading(true)
    const ctrl = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const { data, error } = await supabase.rpc('search_messages', {
          p_user_id: userId,
          p_query: query.trim(),
          p_limit: 15,
        })
        if (ctrl.signal.aborted) return
        if (error) { setResults([]); return }
        setResults((data ?? []) as SearchResult[])
      } finally {
        if (!ctrl.signal.aborted) setLoading(false)
      }
    }, 300)
    return () => { clearTimeout(timer); ctrl.abort(); setLoading(false) }
  }, [query, userId])

  const totalItems = personMatches.length + results.length

  useEffect(() => { setActiveIdx(0) }, [query])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, totalItems - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (activeIdx < personMatches.length) {
        onSelectPerson(personMatches[activeIdx].person.id)
      } else {
        const r = results[activeIdx - personMatches.length]
        if (r) onSelectPerson(r.person_id)
      }
    }
  }

  return (
    <div
      onClick={onClose}
      className="modal-backdrop modal-backdrop--top z-[100]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="modal-panel search-modal"
      >
        <div className="modal-header">
          <Search size={18} className="text-text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search people and messages..."
            className="search-input"
          />
          <kbd className="search-kbd">ESC</kbd>
        </div>

        <div className="thin-scroll flex-1 overflow-y-auto py-1">
          {!query.trim() && (
            <p className="search-empty">
              Type to search across people and messages
            </p>
          )}

          {personMatches.length > 0 && (
            <>
              <div className="search-section-label">People</div>
              {personMatches.map((c, i) => (
                <SearchRow
                  key={`p-${c.person.id}`}
                  active={activeIdx === i}
                  onClick={() => onSelectPerson(c.person.id)}
                >
                  {c.person.avatar_url
                    ? <img src={c.person.avatar_url} alt="" className="w-7 h-7 rounded-full object-cover" />
                    : <span className={`avatar avatar--md ${avatarCls(c.person.id)}`}>{initials(c.person.display_name)}</span>}
                  <span className="text-base text-text-primary">{c.person.display_name}</span>
                  <span className="text-sm text-text-pending ml-auto">
                    {channelLabel(c.lastMessage.channel)}
                  </span>
                </SearchRow>
              ))}
            </>
          )}

          {results.length > 0 && (
            <>
              <div className="search-section-label">Messages</div>
              {results.map((r, i) => {
                const idx = personMatches.length + i
                const snippet = (r.body_text ? cleanPreviewText(r.body_text) : r.subject ?? '').slice(0, 80)
                return (
                  <SearchRow
                    key={`m-${r.message_id}`}
                    active={activeIdx === idx}
                    onClick={() => onSelectPerson(r.person_id)}
                  >
                    {r.avatar_url
                      ? <img src={r.avatar_url} alt="" className="w-7 h-7 rounded-full object-cover" />
                      : <span className={`avatar avatar--md ${avatarCls(r.person_id)}`}>{initials(r.display_name)}</span>}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-md font-medium text-text-primary">{r.display_name}</span>
                        <span className="text-xs text-text-pending">{relativeTime(r.sent_at)}</span>
                      </div>
                      <p className="text-sm text-text-secondary overflow-hidden text-ellipsis whitespace-nowrap">
                        {snippet}
                      </p>
                    </div>
                    <ChannelLogo channel={r.channel as Channel} size={14} className="shrink-0 text-text-muted" />
                  </SearchRow>
                )
              })}
            </>
          )}

          {query.trim().length >= 2 && !loading && personMatches.length === 0 && results.length === 0 && (
            <p className="search-empty">
              No results found
            </p>
          )}

          {loading && results.length === 0 && (
            <div className="py-2 px-4">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="flex items-center gap-2.5 py-1.5">
                  <div className="skeleton w-7 h-7 rounded-full shrink-0" />
                  <div className="flex-1">
                    <div className="skeleton w-[40%] h-3 rounded-sm mb-1" />
                    <div className="skeleton w-[70%] h-2.5 rounded-sm" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function SearchRow({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode
}) {
  return (
    <div
      onClick={onClick}
      className="search-row"
      data-active={active}
    >
      {children}
    </div>
  )
}

export default App
