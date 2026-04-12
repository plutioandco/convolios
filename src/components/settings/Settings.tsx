import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../../lib/auth'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-shell'
import { useAccountsStore } from '../../stores/accountsStore'
import { queryClient } from '../../lib/queryClient'
import { channelLabel, channelColor, relativeTime } from '../../utils'
import type { ConnectedAccount } from '../../types'
import _ from 'lodash'

const PROVIDERS = [
  { providers: ['WHATSAPP'],  label: 'WhatsApp',  desc: 'QR code',  channel: 'whatsapp' },
  { providers: ['GOOGLE'],    label: 'Gmail',      desc: 'OAuth',    channel: 'email' },
  { providers: ['LINKEDIN'],  label: 'LinkedIn',   desc: 'Sign in',  channel: 'linkedin' },
  { providers: ['INSTAGRAM'], label: 'Instagram',  desc: 'Sign in',  channel: 'instagram' },
  { providers: ['TELEGRAM'],  label: 'Telegram',   desc: 'QR code',  channel: 'telegram' },
  { providers: ['MICROSOFT'], label: 'Outlook',    desc: 'OAuth',    channel: 'email' },
  { providers: ['X'],         label: 'X',          desc: 'OAuth',    channel: 'x' },
]

export function Settings() {
  const { user } = useAuth()
  const accounts = useAccountsStore((s) => s.accounts)
  const loading = useAccountsStore((s) => s.loading)
  const fetchAccounts = useAccountsStore((s) => s.fetchAccounts)
  const removeAccount = useAccountsStore((s) => s.removeAccount)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const [pulling, setPulling] = useState(false)
  const [pullMsg, setPullMsg] = useState('')
  const [disconnecting, setDisconnecting] = useState<string | null>(null)
  const [disconnectErr, setDisconnectErr] = useState('')

  const refresh = useCallback(() => {
    if (user?.id) fetchAccounts(user.id)
  }, [user?.id, fetchAccounts])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const sync = async () => {
    if (!user?.id) return
    setSyncing(true); setSyncMsg('')
    try { setSyncMsg(await invoke<string>('sync_unipile_accounts', { userId: user.id })); refresh() }
    catch (e) { setSyncMsg(String(e)) }
    finally { setSyncing(false) }
  }

  const pull = async () => {
    if (!user?.id) return
    setPulling(true); setPullMsg('')
    try {
      setPullMsg(await invoke<string>('backfill_messages', { userId: user.id }))
      queryClient.invalidateQueries({ queryKey: ['conversations', user.id] })
    }
    catch (e) { setPullMsg(String(e)) }
    finally { setPulling(false) }
  }

  const disconnect = async (accountId: string) => {
    if (!user?.id || _.isNil(accountId)) return
    setDisconnecting(accountId)
    setDisconnectErr('')
    try {
      await invoke<string>('disconnect_account', { accountId, userId: user.id })
      removeAccount(accountId)
      queryClient.invalidateQueries({ queryKey: ['conversations', user.id] })
    } catch (e) {
      setDisconnectErr(String(e))
    } finally {
      setDisconnecting(null)
    }
  }

  return (
    <div style={{ flex: 1, display: 'flex', background: '#2b2d31', overflow: 'hidden' }}>
      {/* left nav */}
      <div style={{ width: 218, flexShrink: 0, display: 'flex', justifyContent: 'flex-end' }}>
        <div style={{ width: 192, paddingTop: 60, paddingBottom: 20, paddingRight: 6, paddingLeft: 20 }}>
          <SectionLabel>User Settings</SectionLabel>
          <NavItem active>Connections</NavItem>
        </div>
      </div>

      {/* main content */}
      <div style={{ flex: 1, maxWidth: 740, paddingTop: 60, paddingBottom: 80, paddingLeft: 40, paddingRight: 40, overflowY: 'auto' }}>

        <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 20, color: '#f2f3f5' }}>Connections</h2>
        <p style={{ fontSize: 14, marginBottom: 20, color: '#b5bac1' }}>
          Connect your accounts to bring messages into Convolios
        </p>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 40 }}>
          {PROVIDERS.map((p) => (
            <ProviderCard key={p.label} {...p} userId={user?.id} />
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.02em', color: '#b5bac1' }}>
            Connected Accounts
          </h2>
          <Btn small onClick={sync} busy={syncing}>{syncing ? 'Syncing...' : 'Sync'}</Btn>
        </div>
        {syncMsg && <Hint>{syncMsg}</Hint>}
        {disconnectErr && <Hint>{disconnectErr}</Hint>}
        {loading && accounts.length === 0 && <Hint>Loading accounts...</Hint>}
        {!loading && accounts.length === 0 && <Hint>No accounts connected yet</Hint>}

        {accounts.map((a) => (
          <AccountCard key={a.id} account={a} disconnecting={disconnecting} onDisconnect={disconnect} />
        ))}

        <div style={{ height: 1, background: '#3f4147', margin: '40px 0' }} />

        <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 20, color: '#f2f3f5' }}>Data & Privacy</h2>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 16, padding: 16,
          borderRadius: 8, marginBottom: 8, background: '#1e1f22', border: '1px solid #3f4147',
        }}>
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 16, color: '#f2f3f5' }}>Message History</p>
            <p style={{ fontSize: 14, marginTop: 4, color: '#b5bac1' }}>
              Pull recent chats from all your connected accounts
            </p>
          </div>
          <Btn onClick={pull} busy={pulling}>{pulling ? 'Pulling...' : 'Pull History'}</Btn>
        </div>
        {pullMsg && <Hint>{pullMsg}</Hint>}

        <div style={{ height: 1, background: '#3f4147', margin: '40px 0' }} />

        <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 20, color: '#f2f3f5' }}>System Health</h2>

        <HealthCard label="Unipile API" cmd="check_unipile_connection" />
        <HealthCard label="Gemini AI" cmd="check_gemini_connection" />
        <WebhookCard />
      </div>
    </div>
  )
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.02em', padding: '0 10px 6px', color: '#b5bac1' }}>
      {children}
    </div>
  )
}

function NavItem({ children, active }: { children: string; active?: boolean }) {
  return (
    <div style={{
      fontSize: 16, padding: '6px 10px', borderRadius: 4, marginBottom: 2, cursor: 'pointer',
      color: active ? '#f2f3f5' : '#b5bac1',
      background: active ? 'rgba(79,84,92,.6)' : 'transparent',
    }}>
      {children}
    </div>
  )
}

function Btn({ onClick, busy, small, children }: {
  onClick: () => void; busy?: boolean; small?: boolean; children: React.ReactNode
}) {
  return (
    <button onClick={onClick} disabled={busy} style={{
      fontSize: 14, fontWeight: 500, borderRadius: 3, height: 32,
      padding: '2px 16px', minWidth: small ? 60 : 96,
      background: '#5865f2', color: '#fff', opacity: busy ? .5 : 1,
      cursor: busy ? 'not-allowed' : 'pointer', border: 'none',
    }}
    onMouseEnter={(e) => { e.currentTarget.style.background = '#4752c4' }}
    onMouseLeave={(e) => { e.currentTarget.style.background = '#5865f2' }}>
      {children}
    </button>
  )
}

function Hint({ children }: { children: string }) {
  return <p style={{ fontSize: 14, marginTop: 4, marginBottom: 8, color: '#949ba4' }}>{children}</p>
}

function ProviderCard({ providers, label, desc, channel, userId }: {
  providers: string[]; label: string; desc: string; channel: string; userId?: string
}) {
  const [st, setSt] = useState<'idle' | 'loading' | 'waiting' | 'syncing' | 'done' | 'err'>('idle')
  const accounts = useAccountsStore((s) => s.accounts)
  const countBefore = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  useEffect(() => {
    if (st !== 'waiting') return
    const current = accounts.filter((a) => a.channel === channel && a.status === 'active').length
    if (current > countBefore.current) {
      setSt('syncing')
      if (userId) {
        invoke<string>('backfill_messages', { userId }).then(() => {
          queryClient.invalidateQueries({ queryKey: ['conversations', userId] })
        }).catch(() => {}).finally(() => {
          setSt('done')
          timerRef.current = setTimeout(() => setSt('idle'), 3_000)
        })
      } else {
        setSt('done')
        timerRef.current = setTimeout(() => setSt('idle'), 3_000)
      }
    }
  }, [st, accounts, channel, userId])

  const go = async () => {
    if (!userId) return
    setSt('loading')
    countBefore.current = accounts.filter((a) => a.channel === channel && a.status === 'active').length
    try {
      let link: string
      if (channel === 'x') {
        link = await invoke<string>('connect_x_account', { userId })
      } else {
        const url = import.meta.env.VITE_SUPABASE_URL
        link = await invoke<string>('create_connect_link', {
          userId, providers,
          notifyUrl: `${url}/functions/v1/unipile-account-callback`,
          successRedirectUrl: null,
        })
      }
      if (!link) throw new Error('No link')
      await open(link)
      setSt('waiting')
    } catch {
      setSt('err')
      timerRef.current = setTimeout(() => setSt('idle'), 4_000)
    }
  }

  const stColor = st === 'done' ? '#23a559' : st === 'err' ? '#ed4245' : st === 'waiting' || st === 'syncing' ? '#f0b132' : '#949ba4'
  const stText = st === 'loading' ? 'Opening...'
    : st === 'waiting' ? 'Waiting...'
    : st === 'syncing' ? 'Syncing messages...'
    : st === 'done' ? 'Connected!'
    : st === 'err' ? 'Error' : desc

  return (
    <button onClick={go} disabled={st === 'loading' || st === 'waiting'} style={{
      width: 164, height: 48, borderRadius: 8, display: 'flex', alignItems: 'center',
      gap: 8, padding: '0 12px', background: '#1e1f22',
      border: st === 'waiting' ? '1px solid #f0b132' : st === 'done' ? '1px solid #23a559' : '1px solid #3f4147',
      cursor: st === 'loading' || st === 'waiting' ? 'default' : 'pointer',
    }}
    onMouseEnter={(e) => { if (st === 'idle') e.currentTarget.style.background = '#313338' }}
    onMouseLeave={(e) => { e.currentTarget.style.background = '#1e1f22' }}>
      <span style={{ fontSize: 14, fontWeight: 500, flex: 1, textAlign: 'left', color: '#f2f3f5' }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: stColor }}>
        {st === 'waiting' && <span className="pulse-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: stColor }} />}
        {stText}
      </span>
    </button>
  )
}

function HealthCard({ label, cmd }: { label: string; cmd: string }) {
  const [st, setSt] = useState<'idle' | 'busy' | 'ok' | 'err'>('idle')
  const [detail, setDetail] = useState('')
  const check = async () => {
    setSt('busy')
    try { setDetail(await invoke<string>(cmd)); setSt('ok') }
    catch (e) { setDetail(String(e)); setSt('err') }
  }
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: 16,
      borderRadius: 8, marginBottom: 8, background: '#1e1f22', border: '1px solid #3f4147',
    }}>
      <span style={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
        background: st === 'ok' ? '#23a559' : st === 'err' ? '#ed4245' : '#5865f2' }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 16, color: '#f2f3f5' }}>{label}</span>
        {detail && <span style={{ fontSize: 12, marginLeft: 8, color: '#949ba4' }}>{detail}</span>}
      </div>
      <Btn small onClick={check} busy={st === 'busy'}>{st === 'busy' ? '...' : 'Test'}</Btn>
    </div>
  )
}

function WebhookCard() {
  const [st, setSt] = useState<'idle' | 'busy' | 'ok' | 'err'>('idle')
  const [detail, setDetail] = useState('')
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/unipile-webhook`
  const reg = async () => {
    setSt('busy')
    try { setDetail(await invoke<string>('register_unipile_webhook', { webhookUrl: url })); setSt('ok') }
    catch (e) { setDetail(String(e)); setSt('err') }
  }
  return (
    <div style={{ borderRadius: 8, marginBottom: 8, background: '#1e1f22', border: '1px solid #3f4147' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 16 }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
          background: st === 'ok' ? '#23a559' : st === 'err' ? '#ed4245' : '#5865f2' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 16, color: '#f2f3f5' }}>Webhook</p>
          <p style={{ fontSize: 12, wordBreak: 'break-all', marginTop: 2, color: '#949ba4' }}>{url}</p>
        </div>
        <Btn small onClick={reg} busy={st === 'busy'}>{st === 'ok' ? 'Done' : 'Register'}</Btn>
      </div>
      {detail && (
        <div style={{ padding: '0 16px 12px' }}>
          <p style={{ fontSize: 12, color: st === 'ok' ? '#23a559' : '#ed4245' }}>{detail}</p>
        </div>
      )}
    </div>
  )
}

function accountDetail(a: ConnectedAccount): string {
  if (_.isString(a.email) && a.email.length > 0) return a.email
  if (_.isString(a.phone) && a.phone.length > 0) {
    const p = a.phone
    return p.startsWith('+') ? p : `+${p}`
  }
  if (_.isString(a.username) && a.username.length > 0) return `@${a.username}`
  if (_.isString(a.display_name) && a.display_name.length > 0) return a.display_name
  return ''
}

function accountSubline(a: ConnectedAccount): string | null {
  const parts: string[] = []
  const primary = accountDetail(a)
  if (_.isString(a.display_name) && a.display_name.length > 0 && a.display_name !== primary) {
    parts.push(a.display_name)
  }
  if (_.isString(a.username) && a.username.length > 0 && !primary.includes(a.username)) {
    parts.push(`@${a.username}`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

function AccountCard({ account: a, disconnecting, onDisconnect }: {
  account: ConnectedAccount; disconnecting: string | null; onDisconnect: (id: string) => void
}) {
  const { user } = useAuth()
  const detail = accountDetail(a)
  const sub = accountSubline(a)
  const isDisconnecting = disconnecting === a.account_id
  const color = channelColor(a.channel)
  const synced = _.isString(a.last_synced_at) ? relativeTime(a.last_synced_at) : null
  const connected = _.isString(a.created_at) ? relativeTime(a.created_at) : null
  const needsReconnect = a.status === 'credentials' || a.status === 'error'
  const [reconnecting, setReconnecting] = useState(false)

  const handleReconnect = async () => {
    if (!user?.id || !a.account_id) return
    setReconnecting(true)
    try {
      const url = import.meta.env.VITE_SUPABASE_URL
      const link = await invoke<string>('create_connect_link', {
        userId: user.id,
        providers: [a.provider_type?.toUpperCase() ?? '*'],
        notifyUrl: `${url}/functions/v1/unipile-account-callback`,
        successRedirectUrl: null,
        reconnectAccountId: a.account_id,
      })
      if (link) await open(link)
    } catch (e) {
      if (import.meta.env.DEV) console.error('[reconnect]', e)
    } finally {
      setReconnecting(false)
    }
  }

  return (
    <div style={{
      borderRadius: 8, marginBottom: 8, background: '#1e1f22', border: '1px solid #3f4147',
      overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px' }}>
        <div style={{
          width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
          background: color, display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>
            {channelLabel(a.channel).slice(0, 2).toUpperCase()}
          </span>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: '#f2f3f5' }}>
              {channelLabel(a.channel)}
            </span>
            <span style={{
              fontSize: 11, fontWeight: 600, padding: '1px 6px', borderRadius: 3,
              background: a.status === 'active' ? 'rgba(35,165,89,.15)' : 'rgba(237,66,69,.15)',
              color: a.status === 'active' ? '#23a559' : '#ed4245',
              textTransform: 'capitalize',
            }}>
              {needsReconnect ? 'Reconnect required' : a.status}
            </span>
          </div>
          {detail && (
            <p style={{ fontSize: 13, color: '#dbdee1', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {detail}
            </p>
          )}
          {sub && (
            <p style={{ fontSize: 12, color: '#949ba4', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {sub}
            </p>
          )}
        </div>

        {needsReconnect && (
          <button
            onClick={handleReconnect}
            disabled={reconnecting}
            style={{
              fontSize: 12, fontWeight: 500, borderRadius: 3, height: 28, flexShrink: 0,
              padding: '2px 12px', background: '#f0b132', color: '#000',
              border: 'none', cursor: reconnecting ? 'not-allowed' : 'pointer',
              opacity: reconnecting ? 0.5 : 1, marginRight: 6,
            }}
          >
            {reconnecting ? 'Opening...' : 'Reconnect'}
          </button>
        )}
        <button
          onClick={() => a.account_id && onDisconnect(a.account_id)}
          disabled={isDisconnecting || _.isNil(a.account_id)}
          style={{
            fontSize: 12, fontWeight: 500, borderRadius: 3, height: 28, flexShrink: 0,
            padding: '2px 12px', background: 'transparent', color: '#ed4245',
            border: '1px solid rgba(237,66,69,.4)', cursor: isDisconnecting ? 'not-allowed' : 'pointer',
            opacity: isDisconnecting ? 0.5 : 1,
          }}
          onMouseEnter={(e) => { if (!isDisconnecting) { e.currentTarget.style.background = '#ed4245'; e.currentTarget.style.color = '#fff' } }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#ed4245' }}
        >
          {isDisconnecting ? 'Removing...' : 'Disconnect'}
        </button>
      </div>

      <div style={{
        display: 'flex', gap: 16, padding: '0 16px 10px 68px', fontSize: 11, color: '#6d6f78',
      }}>
        {connected && <span>Connected {connected}</span>}
        {synced && <span>Synced {synced}</span>}
      </div>
    </div>
  )
}
