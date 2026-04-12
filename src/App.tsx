import { useState, useEffect, createContext, useContext, Component, useMemo } from 'react'
import type { ReactNode, ErrorInfo } from 'react'
import { Routes, Route } from 'react-router-dom'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister'
import { get, set, del } from 'idb-keyval'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Sidebar } from './components/sidebar/Sidebar'
import { InboxList } from './components/inbox/InboxList'
import { ThreadView } from './components/thread/ThreadView'
import { Settings } from './components/settings/Settings'
import { useInboxStore } from './stores/inboxStore'
import { useRealtimeMessages } from './hooks/useRealtimeMessages'
import { useConversations } from './hooks/useConversations'
import { useAuth, signOut } from './lib/auth'
import { supabase } from './lib/supabase'
import { queryClient } from './lib/queryClient'
import { useAccountsStore } from './stores/accountsStore'
import { channelLabel, channelColor, accountDisplayLabel } from './utils'
import type { ConnectedAccount } from './types'
import _ from 'lodash'

const persister = createAsyncStoragePersister({
  storage: {
    getItem: async (key) => {
      const val = await get<string>(key)
      return val ?? null
    },
    setItem: async (key, value) => { await set(key, value) },
    removeItem: async (key) => { await del(key) },
  },
  key: 'convolios-query-cache-v7',
})

window.localStorage.removeItem('convolios-query-cache-v6')

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
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          height: '100vh', background: '#1e1f22', color: '#f2f3f5', gap: 16, padding: 32,
        }}>
          <span style={{ fontSize: 20, fontWeight: 600 }}>Something went wrong</span>
          <span style={{ fontSize: 14, color: '#949ba4', maxWidth: 400, textAlign: 'center' }}>
            {this.state.error.message}
          </span>
          <button
            onClick={() => { this.setState({ error: null }); window.location.reload() }}
            style={{
              background: '#5865f2', border: 'none', cursor: 'pointer', borderRadius: 4,
              color: '#fff', fontSize: 14, fontWeight: 500, padding: '8px 20px',
            }}
          >
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

function App() {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div style={{ display: 'flex', width: '100%', height: '100vh', alignItems: 'center', justifyContent: 'center', background: '#1e1f22' }}>
        <span style={{ color: '#949ba4', fontSize: 16 }}>Loading...</span>
      </div>
    )
  }

  return (
    <ErrorBoundary>
    <PersistQueryClientProvider client={queryClient} persistOptions={{
      persister,
      maxAge: 24 * 60 * 60 * 1000,
      dehydrateOptions: {
        shouldDehydrateQuery: (query) => {
          if (query.queryKey[0] === 'attachment') return false
          return query.state.status === 'success'
        },
      },
    }}>
      <div style={{ display: 'flex', width: '100%', height: '100vh', overflow: 'hidden', background: '#1e1f22' }}>
        {!user ? <SignInScreen /> : <Authenticated userId={user.id} />}
      </div>
    </PersistQueryClientProvider>
    </ErrorBoundary>
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
      setStatus('error')
      setErrorMsg(error.message)
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
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#313338' }}>
      <div style={{ width: 360, textAlign: 'center' }}>
        <div className="av-1" style={{
          width: 80, height: 80, borderRadius: '50%',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 32, fontWeight: 700, color: '#fff', marginBottom: 16,
        }}>C</div>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: '#f2f3f5' }}>Convolios</h1>
        <p style={{ fontSize: 16, marginTop: 8, color: '#949ba4', marginBottom: 32 }}>All your messages. One inbox.</p>

        {step === 'code' ? (
          <form onSubmit={verifyCode} style={{ textAlign: 'left' }}>
            <p style={{ fontSize: 14, color: '#949ba4', marginBottom: 16, textAlign: 'center' }}>
              Enter the 6-digit code sent to <strong style={{ color: '#f2f3f5' }}>{email}</strong>
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
              style={{
                width: '100%', height: 52, marginBottom: 16,
                borderRadius: 4, padding: '0 12px', fontSize: 28, fontWeight: 600,
                textAlign: 'center', letterSpacing: '0.3em',
                background: '#1e1f22', color: '#f2f3f5',
                border: '1px solid #3f4147', outline: 'none',
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = '#5865f2' }}
              onBlur={(e) => { e.currentTarget.style.borderColor = '#3f4147' }}
            />
            {status === 'error' && (
              <p style={{ fontSize: 13, color: '#ed4245', marginBottom: 12 }}>{errorMsg}</p>
            )}
            <button
              type="submit"
              disabled={status === 'loading' || otp.length < 6}
              style={{
                width: '100%', height: 44, borderRadius: 4, border: 'none',
                background: '#5865f2', color: '#fff', fontSize: 16, fontWeight: 500,
                cursor: status === 'loading' || otp.length < 6 ? 'not-allowed' : 'pointer',
                opacity: status === 'loading' || otp.length < 6 ? 0.6 : 1,
              }}
            >
              {status === 'loading' ? 'Verifying...' : 'Verify'}
            </button>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 16, marginTop: 16 }}>
              <button
                type="button"
                onClick={() => { setStep('email'); setOtp(''); setErrorMsg('') }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#00aff4', fontSize: 13 }}
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
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#00aff4', fontSize: 13 }}
              >Resend code</button>
            </div>
          </form>
        ) : (
          <form onSubmit={sendCode} style={{ textAlign: 'left' }}>
            <label style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: '#b5bac1', letterSpacing: '.02em' }}>
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              placeholder="you@example.com"
              style={{
                width: '100%', height: 40, marginTop: 8, marginBottom: 16,
                borderRadius: 4, padding: '0 12px', fontSize: 16,
                background: '#1e1f22', color: '#dbdee1',
                border: '1px solid #3f4147', outline: 'none',
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = '#5865f2' }}
              onBlur={(e) => { e.currentTarget.style.borderColor = '#3f4147' }}
            />
            {status === 'error' && (
              <p style={{ fontSize: 13, color: '#ed4245', marginBottom: 12 }}>{errorMsg}</p>
            )}
            <button
              type="submit"
              disabled={status === 'loading'}
              style={{
                width: '100%', height: 44, borderRadius: 4, border: 'none',
                background: '#5865f2', color: '#fff', fontSize: 16, fontWeight: 500,
                cursor: status === 'loading' ? 'not-allowed' : 'pointer',
                opacity: status === 'loading' ? 0.6 : 1,
              }}
            >
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

  useEffect(() => {
    fetchAccounts(userId)
    subscribe(userId)
    invoke('startup_sync', { userId }).catch((e: unknown) => {
      if (import.meta.env.DEV) console.warn('[startup_sync]', e)
    })

    const unlisten = listen('account-disconnected', () => {
      queryClient.clear()
      del('convolios-query-cache-v7').catch(() => {})
      useInboxStore.getState().selectPerson(null)
      fetchAccounts(userId)
    })

    return () => {
      unsubscribe()
      unlisten.then((fn) => fn())
    }
  }, [userId, fetchAccounts, subscribe, unsubscribe])

  return (
    <RealtimeContext.Provider value={connected}>
    <div style={{ display: 'flex', width: '100%', height: '100%', overflow: 'hidden', flexDirection: 'column' }}>
      {dead && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          padding: '6px 16px', background: '#ed4245', flexShrink: 0,
        }}>
          <span style={{ fontSize: 13, color: '#fff' }}>Live updates paused — polling every 8s</span>
          <button onClick={reconnect} style={{
            background: 'rgba(255,255,255,.2)', border: 'none', cursor: 'pointer',
            color: '#fff', fontSize: 12, fontWeight: 600, padding: '2px 10px', borderRadius: 3,
          }}>Retry</button>
        </div>
      )}
      {!dead && !connected && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          padding: '4px 16px', background: '#f0b132', flexShrink: 0,
        }}>
          <span className="pulse-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: '#000' }} />
          <span style={{ fontSize: 12, color: '#000' }}>Connecting to live updates...</span>
        </div>
      )}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <Sidebar />
        <Routes>
          <Route path="/" element={<InboxRoute userId={userId} realtimeConnected={connected} />} />
          <Route path="/settings" element={<SettingsRoute />} />
        </Routes>
      </div>
    </div>
    </RealtimeContext.Provider>
  )
}

function InboxRoute({ userId, realtimeConnected }: { userId: string; realtimeConnected: boolean }) {
  const pid = useInboxStore((s) => s.selectedPersonId)
  const { data: convos = [] } = useConversations(userId, realtimeConnected)
  const ch = useInboxStore((s) => s.activeChannel)
  const accounts = useAccountsStore((s) => s.accounts)
  const selectedConvo = useMemo(() => convos.find((c) => c.person.id === pid), [convos, pid])
  const person = selectedConvo?.person

  const activeChannel = selectedConvo?.lastMessage?.channel ?? (ch !== 'all' ? ch : undefined)
  const channelAccount = _.isString(activeChannel)
    ? accounts.find((a) => a.channel === activeChannel && a.status === 'active')
    : undefined

  return (
    <div style={{ display: 'flex', flex: 1, minWidth: 0, height: '100%' }}>
      <InboxList />
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <TopBar>
          {person ? (
            <>
              {person.avatar_url
                ? <img src={person.avatar_url} alt="" style={{ width: 24, height: 24, borderRadius: '50%', objectFit: 'cover' }} />
                : <span style={{
                    width: 24, height: 24, borderRadius: '50%', display: 'inline-flex',
                    alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700,
                    color: '#fff', background: '#5865f2', flexShrink: 0,
                  }}>{person.display_name?.charAt(0)?.toUpperCase()}</span>}
              <span style={{ fontSize: 16, fontWeight: 600, color: '#f2f3f5' }}>{person.display_name}</span>
              {channelAccount && <ConnectionPill account={channelAccount} />}
            </>
          ) : (
            <>
              <span style={{ fontSize: 16, fontWeight: 600, color: '#f2f3f5' }}>{ch === 'all' ? 'All Messages' : channelLabel(ch)}</span>
              {channelAccount && <ConnectionPill account={channelAccount} />}
            </>
          )}
        </TopBar>
        <ThreadView />
      </div>
    </div>
  )
}

function SettingsRoute() {
  return (
    <div className="flex-1 flex flex-col min-w-0">
      <TopBar>
        <span style={{ fontSize: 16, fontWeight: 600, color: '#f2f3f5' }}>Settings</span>
      </TopBar>
      <Settings />
    </div>
  )
}

function TopBar({ children }: { children: React.ReactNode }) {
  return (
    <header style={{
      height: 48, minHeight: 48, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0 16px', background: '#313338',
      boxShadow: '0 1px 0 rgba(4,4,5,.2), 0 1.5px 0 rgba(6,6,7,.05), 0 2px 0 rgba(4,4,5,.05)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{children}</div>
      <button
        onClick={signOut}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: '#949ba4', fontSize: 13, padding: '4px 8px',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = '#ed4245' }}
        onMouseLeave={(e) => { e.currentTarget.style.color = '#949ba4' }}
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
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      fontSize: 11, color: '#b5bac1', padding: '2px 8px',
      background: 'rgba(79,84,92,.4)', borderRadius: 10,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
      {text}
    </span>
  )
}

export default App
