import { useState, useEffect, useCallback, useRef } from 'react'
import { Lock, Plus, Trash2, Undo2, Link2, Check, X, AlertTriangle, RefreshCw, HardDrive } from 'lucide-react'
import { useAuth } from '../../lib/auth'
import { supabase } from '../../lib/supabase'
import { invoke } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
import { open } from '@tauri-apps/plugin-shell'
import { useUpdater } from '../../hooks/useUpdater'
import { useAccountsStore } from '../../stores/accountsStore'
import { queryClient } from '../../lib/queryClient'
import { useCircles, useCreateCircle, useUpdateCircle, useDeleteCircle } from '../../hooks/useCircles'
import { useDismissMerge, useMergeLog, useUndoMerge, useMergeClusters, useMergeCluster, useFuzzyMergeSuggestions } from '../../hooks/useMergeSuggestions'
import { usePreferencesStore } from '../../stores/preferencesStore'
import { channelLabel, channelColor, relativeTime, initials, avatarCls, CIRCLE_COLORS } from '../../utils'
import { ChannelLogo } from '../icons/ChannelLogo'
import { AvatarImage } from '../AvatarImage'
import type { ConnectedAccount, MergeCluster } from '../../types'
import _ from 'lodash'

type ProviderFlow = 'unipile' | 'x_oauth' | 'imessage' | 'on_device'

interface ProviderDef {
  providers: string[]
  label: string
  desc: string
  channel: string
  logo: string
  flow: ProviderFlow
}

const PROVIDERS: ProviderDef[] = [
  { providers: ['WHATSAPP'],            label: 'WhatsApp',              desc: 'QR code',  channel: 'whatsapp',  logo: 'whatsapp',  flow: 'unipile' },
  { providers: ['GOOGLE'],              label: 'Gmail',                 desc: 'OAuth',    channel: 'email',     logo: 'email',     flow: 'unipile' },
  { providers: ['LINKEDIN'],            label: 'LinkedIn',              desc: 'Sign in',  channel: 'linkedin',  logo: 'linkedin',  flow: 'unipile' },
  { providers: ['INSTAGRAM'],           label: 'Instagram',             desc: 'Sign in',  channel: 'instagram', logo: 'instagram', flow: 'unipile' },
  { providers: ['ON_DEVICE_INSTAGRAM'], label: 'Instagram (on device)', desc: 'Local',    channel: 'instagram', logo: 'instagram', flow: 'on_device' },
  { providers: ['ON_DEVICE_MESSENGER'], label: 'Messenger (on device)', desc: 'Local',    channel: 'messenger', logo: 'messenger', flow: 'on_device' },
  { providers: ['TELEGRAM'],            label: 'Telegram',              desc: 'QR code',  channel: 'telegram',  logo: 'telegram',  flow: 'unipile' },
  { providers: ['MICROSOFT'],           label: 'Outlook',               desc: 'OAuth',    channel: 'email',     logo: 'outlook',   flow: 'unipile' },
  { providers: ['X'],                   label: 'X',                     desc: 'OAuth',    channel: 'x',         logo: 'x',         flow: 'x_oauth' },
  { providers: ['IMESSAGE'],            label: 'iMessage',              desc: 'Local',    channel: 'imessage',  logo: 'imessage',  flow: 'imessage' },
]

export function Settings() {
  const { user } = useAuth()
  const accounts = useAccountsStore((s) => s.accounts)
  const loading = useAccountsStore((s) => s.loading)
  const fetchAccounts = useAccountsStore((s) => s.fetchAccounts)
  const removeAccount = useAccountsStore((s) => s.removeAccount)
  const lastSyncedAt = accounts
    .map((a) => a.last_synced_at)
    .filter((v): v is string => _.isString(v) && v.length > 0)
    .sort()
    .at(-1) ?? null
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const [pulling, setPulling] = useState(false)
  const [pullMsg, setPullMsg] = useState('')
  const [resettingEmail, setResettingEmail] = useState(false)
  const [resetEmailMsg, setResetEmailMsg] = useState('')
  const [disconnecting, setDisconnecting] = useState<string | null>(null)
  const [disconnectErr, setDisconnectErr] = useState('')
  const [activeTab, setActiveTab] = useState<'connections' | 'circles' | 'suggestions' | 'merges' | 'preferences' | 'about'>('connections')

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
    try {
      const result = await invoke<string>('startup_sync', {
        userId: user.id,
        mode: 'full',
        openChatId: null,
      })
      setSyncMsg(result)
      refresh()
      queryClient.invalidateQueries({ queryKey: ['conversations', user.id] })
    }
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

  const resetEmail = async () => {
    if (!user?.id) return
    const ok = window.confirm(
      'Delete all email data stored in Convolios and re-import from the provider?\n\n' +
      'Your mailbox is not deleted — only history in this app is cleared. ' +
      'Use this if two email contacts were wrongly merged into one person.'
    )
    if (!ok) return
    setResettingEmail(true); setResetEmailMsg('')
    try {
      const { data, error } = await supabase.rpc('reset_email_ingestion', { p_user_id: user.id })
      if (error) throw error
      const counts = data as { messages_deleted: number; identities_deleted: number; persons_deleted: number } | null
      const cleared = counts
        ? `Cleared ${counts.messages_deleted} messages, ${counts.identities_deleted} identities, ${counts.persons_deleted} persons. Re-pulling…`
        : 'Cleared. Re-pulling…'
      setResetEmailMsg(cleared)
      const result = await invoke<string>('backfill_messages', { userId: user.id })
      setResetEmailMsg(result)
      queryClient.invalidateQueries({ queryKey: ['conversations', user.id] })
    }
    catch (e) { setResetEmailMsg(String(e)) }
    finally { setResettingEmail(false) }
  }

  const disconnect = async (accountId: string) => {
    if (!user?.id || _.isNil(accountId)) return
    setDisconnecting(accountId)
    setDisconnectErr('')
    try {
      const account = accounts.find((a) => a.account_id === accountId)
      const cmd = account?.provider === 'on_device'
        ? 'on_device_disconnect'
        : 'disconnect_account'
      await invoke<string>(cmd, { accountId, userId: user.id })
      removeAccount(accountId)
      queryClient.invalidateQueries({ queryKey: ['conversations', user.id] })
    } catch (e) {
      setDisconnectErr(String(e))
    } finally {
      setDisconnecting(null)
    }
  }

  return (
    <div className="settings-shell">
      <aside className="settings-side">
        <div className="nav-section-header"><span>User Settings</span></div>
        <NavItem active={activeTab === 'connections'} onClick={() => setActiveTab('connections')}>Connections</NavItem>
        <NavItem active={activeTab === 'circles'} onClick={() => setActiveTab('circles')}>Circles</NavItem>
        <NavItem active={activeTab === 'suggestions'} onClick={() => setActiveTab('suggestions')}>Merge Suggestions</NavItem>
        <NavItem active={activeTab === 'merges'} onClick={() => setActiveTab('merges')}>Merge History</NavItem>
        <NavItem active={activeTab === 'preferences'} onClick={() => setActiveTab('preferences')}>Preferences</NavItem>
        <NavItem active={activeTab === 'about'} onClick={() => setActiveTab('about')}>About</NavItem>
      </aside>

      <div className="settings-page thin-scroll">

        {activeTab === 'connections' && (
          <>
            <h2 className="settings-h2">Connections</h2>
            <p className="text-base mb-5 text-text-secondary">
              Connect your accounts to bring messages into Convolios
            </p>

            <div className="flex flex-wrap gap-2 mb-10">
              {PROVIDERS.map((p) => (
                <ProviderCard key={p.label} {...p} userId={user?.id} />
              ))}
            </div>

            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold uppercase tracking-wide text-text-secondary">
                  Connected Accounts
                </h2>
                {lastSyncedAt && (
                  <span className="text-xs text-text-pending">Last synced {relativeTime(lastSyncedAt)}</span>
                )}
              </div>
              <Btn small onClick={sync} busy={syncing}>{syncing ? 'Syncing...' : 'Sync All'}</Btn>
            </div>
            {syncMsg && <Hint>{syncMsg}</Hint>}
            {disconnectErr && <Hint>{disconnectErr}</Hint>}
            {loading && accounts.length === 0 && <SettingsSkeleton />}
            {!loading && accounts.length === 0 && <Hint>No accounts connected yet</Hint>}

            {accounts.map((a) => (
              <AccountCard key={a.id} account={a} disconnecting={disconnecting} onDisconnect={disconnect} />
            ))}

            <div className="h-px bg-border my-10" />

            <h2 className="settings-h2">Data & Privacy</h2>

            <div className="settings-card">
              <div className="settings-card-body">
                <p className="settings-card-name">Message History</p>
                <p className="settings-card-desc">
                  Pull recent chats from all your connected accounts
                </p>
              </div>
              <Btn onClick={pull} busy={pulling}>{pulling ? 'Pulling...' : 'Pull History'}</Btn>
            </div>
            {pullMsg && <Hint>{pullMsg}</Hint>}

            <div className="settings-card">
              <div className="settings-card-body">
                <p className="settings-card-name">Reset Email Sync</p>
                <p className="settings-card-desc">
                  Removes email messages and email identities from Convolios and
                  re-imports from the provider. Does not delete your mailbox.
                </p>
              </div>
              <Btn onClick={resetEmail} busy={resettingEmail}>
                {resettingEmail ? 'Resetting...' : 'Reset Email'}
              </Btn>
            </div>
            {resetEmailMsg && <Hint>{resetEmailMsg}</Hint>}

            <div className="h-px bg-border my-10" />

            <h2 className="settings-h2">System Health</h2>

            <HealthCard label="Unipile API" cmd="check_unipile_connection" />
            <HealthCard label="Gemini AI" cmd="check_gemini_connection" />
            <WebhookCard />
          </>
        )}

        {activeTab === 'circles' && <CircleManagement userId={user?.id} />}
        {activeTab === 'suggestions' && <MergeSuggestionsView userId={user?.id} />}
        {activeTab === 'merges' && <MergeHistory userId={user?.id} />}
        {activeTab === 'preferences' && <PreferencesSection />}

        {activeTab === 'about' && <AboutSection />}
      </div>
    </div>
  )
}

function NavItem({ children, active, onClick }: { children: string; active?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="nav-item"
      data-active={active ? 'true' : 'false'}
    >
      <span className="nav-item-label">{children}</span>
    </button>
  )
}

function Btn({ onClick, busy, small, children }: {
  onClick: () => void; busy?: boolean; small?: boolean; children: React.ReactNode
}) {
  return (
    <button
      className={`btn-primary text-base h-8 py-0.5 px-4 ${small ? 'min-w-[60px]' : 'min-w-[96px]'}`}
      onClick={onClick}
      disabled={busy}
    >
      {children}
    </button>
  )
}

function Hint({ children }: { children: string }) {
  return <p className="text-base mt-1 mb-2 text-text-muted">{children}</p>
}

function SettingsSkeleton() {
  return (
    <>
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="settings-skeleton-card">
          <div className="skeleton w-10 h-10 rounded-full shrink-0" />
          <div className="flex-1">
            <div className="skeleton w-[30%] h-3.5 rounded-sm mb-1.5" />
            <div className="skeleton w-1/2 h-[11px] rounded-sm" />
          </div>
        </div>
      ))}
    </>
  )
}

type ProviderState = 'idle' | 'loading' | 'waiting' | 'syncing' | 'done' | 'err' | 'permission'

const PROVIDER_WAITING_TIMEOUT_MS = 120_000
const PROVIDER_DONE_DISMISS_MS = 3_000
const PROVIDER_ERR_DISMISS_MS = 6_000

function ProviderCard({ providers, label, desc, channel, logo, flow, userId }: ProviderDef & { userId?: string }) {
  const [st, setSt] = useState<ProviderState>('idle')
  const [errMsg, setErrMsg] = useState('')
  const [onDeviceOpen, setOnDeviceOpen] = useState(false)
  const accounts = useAccountsStore((s) => s.accounts)
  const fetchAccounts = useAccountsStore((s) => s.fetchAccounts)
  const countBefore = useRef(0)

  const runImessageFlow = useCallback((uid: string) => {
    setSt('syncing')
    return invoke<string>('backfill_messages', { userId: uid })
      .then(() => {
        queryClient.invalidateQueries({ queryKey: ['conversations', uid] })
        setSt('done')
      })
      .catch((e) => {
        setErrMsg(String(e))
        setSt('err')
      })
  }, [])

  useEffect(() => {
    if (st !== 'done' && st !== 'err') return
    const ms = st === 'done' ? PROVIDER_DONE_DISMISS_MS : PROVIDER_ERR_DISMISS_MS
    const timer = setTimeout(() => setSt('idle'), ms)
    return () => clearTimeout(timer)
  }, [st])

  useEffect(() => {
    if (st !== 'waiting') return
    const timer = setTimeout(() => {
      setErrMsg('Connection timed out. Please try again.')
      setSt('err')
    }, PROVIDER_WAITING_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [st])

  useEffect(() => {
    if (st !== 'waiting') return
    const current = accounts.filter((a) => a.channel === channel && a.status === 'active').length
    if (current <= countBefore.current) return
    if (_.isString(userId)) {
      runImessageFlow(userId)
    } else {
      setSt('done')
    }
  }, [st, accounts, channel, userId, runImessageFlow])

  useEffect(() => {
    if (st !== 'permission') return
    const onFocus = () => {
      if (!_.isString(userId)) return
      setSt('loading')
      invoke<string>('connect_imessage', { userId })
        .then(() => runImessageFlow(userId))
        .catch((e) => {
          const msg = String(e)
          if (msg.includes('Full Disk Access') || msg.includes('Cannot access')) {
            setSt('permission')
          } else {
            setErrMsg(msg)
            setSt('err')
          }
        })
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [st, userId, runImessageFlow])

  const go = async () => {
    if (!_.isString(userId)) return

    if (flow === 'on_device') {
      setOnDeviceOpen(true)
      return
    }

    setSt('loading')
    setErrMsg('')
    countBefore.current = accounts.filter((a) => a.channel === channel && a.status === 'active').length
    try {
      if (flow === 'imessage') {
        await invoke<string>('connect_imessage', { userId })
        await runImessageFlow(userId)
        return
      }
      let link: string
      if (flow === 'x_oauth') {
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
    } catch (e) {
      const msg = String(e)
      if (flow === 'imessage' && (msg.includes('Full Disk Access') || msg.includes('Cannot access'))) {
        setSt('permission')
        return
      }
      setErrMsg(msg)
      setSt('err')
    }
  }

  const openFdaSettings = async () => {
    try {
      await open('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles')
    } catch {
      await open('x-apple.systempreferences:com.apple.preference.security').catch(() => {})
    }
  }

  if (st === 'permission') {
    return (
      <div className="provider-permission-card">
        <div className="flex items-center gap-2">
          <span className="flex items-center"><Lock size={18} /></span>
          <span className="text-base font-semibold text-text-primary">Full Disk Access Required</span>
        </div>
        <p className="text-md text-text-secondary leading-normal">
          Convolios needs permission to read your Messages database. Open System Settings, find Convolios in the list and toggle it on.
        </p>
        <div className="flex gap-2">
          <button className="btn-primary flex-1 h-8 text-base" onClick={openFdaSettings}>
            Open Settings
          </button>
          <button onClick={() => setSt('idle')} className="btn-outline">
            Cancel
          </button>
        </div>
        <p className="text-xs text-text-pending">
          When you come back, we'll retry automatically.
        </p>
      </div>
    )
  }

  const stColor = st === 'done' ? 'var(--color-success)' : st === 'err' ? 'var(--color-danger)' : st === 'waiting' || st === 'syncing' ? 'var(--color-warning)' : 'var(--color-text-muted)'
  const stText = st === 'loading' ? 'Opening...'
    : st === 'waiting' ? 'Waiting...'
    : st === 'syncing' ? 'Syncing messages...'
    : st === 'done' ? 'Connected!'
    : st === 'err' ? (errMsg || 'Error') : desc

  return (
    <div className="relative">
      <button
        onClick={go}
        disabled={st === 'loading' || st === 'waiting'}
        title={st === 'err' ? errMsg : undefined}
        className="provider-btn"
        data-state={st}
      >
        <ChannelLogo channel={logo} size={16} color="var(--color-text-primary)" className="shrink-0" />
        <span className="text-base font-medium flex-1 text-left text-text-primary">{label}</span>
        {flow === 'on_device' && (
          <HardDrive size={11} className="text-text-muted shrink-0" aria-label="On device" />
        )}
        <span className="flex items-center gap-1 text-xs truncate max-w-[80px]" style={{ color: stColor }}>
          {st === 'waiting' && <span className="pulse-dot w-1.5 h-1.5 rounded-full shrink-0" style={{ background: stColor }} />}
          {st === 'err' ? 'Failed' : stText}
        </span>
      </button>
      {st === 'err' && errMsg && (
        <div className="provider-btn-error-tip">{errMsg}</div>
      )}
      {onDeviceOpen && _.isString(userId) && (
        <OnDeviceLoginModal
          userId={userId}
          channel={channel}
          label={label}
          onClose={() => setOnDeviceOpen(false)}
          onSuccess={() => {
            setOnDeviceOpen(false)
            setSt('done')
            fetchAccounts(userId)
            queryClient.invalidateQueries({ queryKey: ['conversations', userId] })
          }}
        />
      )}
    </div>
  )
}

type OnDeviceStep = 'idle' | 'busy' | 'done' | 'action_required' | 'err'

type LoginStatus =
  | 'success'
  | 'challenge_required'
  | 'consent_required'
  | 'checkpoint_required'
  | 'token_invalidated'
  | 'cancelled'

interface LoginOutcome {
  status: LoginStatus
  account_id?: string
  username?: string
  display_name?: string | null
  avatar_url?: string | null
  channel: string
}

const ACTION_COPY: Record<Exclude<LoginStatus, 'success' | 'cancelled'>, (label: string) => string> = {
  challenge_required: (label) =>
    `${label} asked for a verification step. Complete it in a regular ${label} browser tab, then click Connect again.`,
  consent_required: (label) =>
    `${label} is showing a consent screen. Accept it in a regular browser, then click Connect again.`,
  checkpoint_required: (label) =>
    `${label} opened a security checkpoint. Resolve it at ${label.toLowerCase()}.com in a regular browser, then click Connect again.`,
  token_invalidated: (label) =>
    `Your ${label} session is no longer valid. Click Connect to sign in again.`,
}

function OnDeviceLoginModal({ userId, channel, label, onClose, onSuccess }: {
  userId: string
  channel: string
  label: string
  onClose: () => void
  onSuccess: () => void
}) {
  const [step, setStep] = useState<OnDeviceStep>('idle')
  const [message, setMessage] = useState('')

  const connect = async () => {
    setStep('busy')
    setMessage('')
    try {
      const outcome = await invoke<LoginOutcome>('on_device_start_login', { userId, channel })
      if (outcome.status === 'success') {
        setStep('done')
        setTimeout(onSuccess, 600)
        return
      }
      if (outcome.status === 'cancelled') {
        onClose()
        return
      }
      setMessage(ACTION_COPY[outcome.status](label))
      setStep('action_required')
    } catch (e) {
      const raw = String(e).toLowerCase()
      if (raw.includes('password') || raw.includes('credential') || raw.includes('unauthorized') || raw.includes('login')) {
        setMessage(`Your ${label} session appears invalid. Click Connect to sign in again.`)
      } else {
        setMessage(String(e))
      }
      setStep('err')
    }
  }

  return (
    <div className="modal-backdrop" onClick={step === 'busy' ? undefined : onClose}>
      <div className="modal-panel on-device-modal" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-4">
          <HardDrive size={16} className="text-text-muted" />
          <h3 className="text-base font-semibold text-text-primary">Connect {label}</h3>
        </div>
        <p className="text-sm text-text-secondary mb-4 leading-normal">
          A {label} login window opens on your Mac. Your session cookies stay on this device (stored in macOS Keychain). Convolios servers never see them.
        </p>

        {step === 'idle' && (
          <div className="flex gap-2 mt-4">
            <button type="button" onClick={onClose} className="btn-outline flex-1">Cancel</button>
            <button type="button" onClick={connect} className="btn-primary flex-1">Connect</button>
          </div>
        )}

        {step === 'busy' && (
          <p className="text-sm text-text-muted">Opening {label} login window…</p>
        )}

        {step === 'done' && (
          <div className="flex items-center gap-2 text-success">
            <Check size={16} /><span>Connected</span>
          </div>
        )}

        {step === 'action_required' && (
          <div>
            <p className="auth-error">{message}</p>
            <div className="flex gap-2 mt-4">
              <button type="button" onClick={onClose} className="btn-outline flex-1">Close</button>
              <button type="button" onClick={connect} className="btn-primary flex-1">Connect</button>
            </div>
          </div>
        )}

        {step === 'err' && (
          <div>
            <p className="auth-error">{message}</p>
            <div className="flex gap-2 mt-4">
              <button type="button" onClick={onClose} className="btn-outline flex-1">Close</button>
              <button type="button" onClick={connect} className="btn-primary flex-1">Try again</button>
            </div>
          </div>
        )}
      </div>
    </div>
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
    <div className="settings-card">
      <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${st === 'ok' ? 'bg-success' : st === 'err' ? 'bg-danger' : 'bg-accent'}`} />
      <div className="settings-card-body">
        <span className="settings-card-name">{label}</span>
        {detail && <span className="text-sm ml-2 text-text-muted">{detail}</span>}
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
    <div className="rounded-card mb-2 bg-[var(--color-sidebar-rail)] border border-border overflow-hidden">
      <div className="flex items-center gap-3 p-4">
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${st === 'ok' ? 'bg-success' : st === 'err' ? 'bg-danger' : 'bg-accent'}`} />
        <div className="flex-1 min-w-0">
          <p className="text-body text-text-primary">Webhook</p>
          <p className="text-sm break-all mt-0.5 text-text-muted">{url}</p>
        </div>
        <Btn small onClick={reg} busy={st === 'busy'}>{st === 'ok' ? 'Done' : 'Register'}</Btn>
      </div>
      {detail && (
        <div className="px-4 pb-3">
          <p className={`text-sm ${st === 'ok' ? 'text-success' : 'text-danger'}`}>{detail}</p>
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
  const messengerInboxNotReady =
    a.provider === 'on_device' &&
    a.channel === 'messenger' &&
    a.status === 'active' &&
    _.get(a.connection_params, 'receive_inbox_ready') !== true
  const synced = _.isString(a.last_synced_at) ? relativeTime(a.last_synced_at) : null
  const connected = _.isString(a.created_at) ? relativeTime(a.created_at) : null
  const accountLogo = (a.channel === 'email' && _.isString(a.provider_type) && a.provider_type.toUpperCase() === 'MICROSOFT')
    ? 'outlook'
    : a.channel
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
      console.error('[reconnect]', e)
    } finally {
      setReconnecting(false)
    }
  }

  return (
    <div className="rounded-card mb-2 bg-surface-deep border border-border overflow-hidden">
      <div className="flex items-center gap-3 py-3.5 px-4">
        <div
          className="w-10 h-10 rounded-full shrink-0 flex items-center justify-center"
          style={{ background: color }}
        >
          <ChannelLogo channel={accountLogo} size={20} color="var(--color-white)" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold text-text-primary">
              {channelLabel(a.channel)}
            </span>
            <span
              className={`text-xs font-semibold py-px px-1.5 rounded-chip capitalize ${
                needsReconnect
                  ? 'bg-[var(--hover-danger-strong)] text-danger'
                  : messengerInboxNotReady
                    ? 'bg-[var(--hover-warning-subtle)] text-warning'
                    : a.status === 'active'
                      ? 'bg-[var(--hover-success-subtle)] text-success'
                      : 'bg-[var(--hover-danger-strong)] text-danger'
              }`}
            >
              {needsReconnect
                ? 'Reconnect required'
                : messengerInboxNotReady
                  ? 'Setting up'
                  : a.status}
            </span>
          </div>
          {detail && (
            <p className="text-md text-text-body mt-0.5 truncate">
              {detail}
            </p>
          )}
          {sub && (
            <p className="text-sm text-text-muted mt-px truncate">
              {sub}
            </p>
          )}
        </div>

        {needsReconnect && (
          <button onClick={handleReconnect} disabled={reconnecting} className="btn-warning-sm mr-1.5">
            {reconnecting ? 'Opening...' : 'Reconnect'}
          </button>
        )}
        <button
          onClick={() => a.account_id && onDisconnect(a.account_id)}
          disabled={isDisconnecting || _.isNil(a.account_id)}
          className="btn-danger-outline-sm"
        >
          {isDisconnecting ? 'Removing...' : 'Disconnect'}
        </button>
      </div>

      <div className="flex gap-4 pr-4 pb-2.5 pl-[68px] text-xs text-text-pending">
        {connected && <span>Connected {connected}</span>}
        {messengerInboxNotReady && (
          <span>Still setting up — incoming messages are not available in this app yet</span>
        )}
        {!messengerInboxNotReady && synced && <span>Synced {synced}</span>}
      </div>

      {a.channel === 'imessage' && a.status === 'active' && user?.id && (
        <IMessageStats userId={user.id} />
      )}
    </div>
  )
}

// Low-threshold. If fewer than this many messages are sitting in this Mac's
// local chat.db, we surface the multi-device nudge prominently. Anything above
// and we still show stats, just without the warning styling.
const IMESSAGE_LOW_COUNT = 500

function IMessageStats({ userId }: { userId: string }) {
  const [stats, setStats] = useState<{
    handle_count: number
    message_count: number
    oldest_message_at: string | null
    newest_message_at: string | null
    accessible: boolean
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [resyncing, setResyncing] = useState(false)
  const [resyncMsg, setResyncMsg] = useState('')

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<typeof stats & object>('imessage_status')
      setStats(s as NonNullable<typeof stats>)
    } catch (e) {
      console.error('[imessage_status] failed', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const resync = useCallback(async () => {
    setResyncing(true); setResyncMsg('')
    try {
      await invoke<string>('connect_imessage', { userId })
      await invoke<string>('backfill_messages', { userId })
      queryClient.invalidateQueries({ queryKey: ['conversations', userId] })
      await refresh()
      setResyncMsg('Re-sync complete')
      setTimeout(() => setResyncMsg(''), 3_000)
    } catch (e) {
      console.error('[imessage resync] failed', e)
      setResyncMsg(String(e))
    } finally {
      setResyncing(false)
    }
  }, [userId, refresh])

  const openReleases = () => open('https://github.com/plutioandco/convolios/releases/latest').catch(() => {})
  const openMessages = () =>
    open('x-apple.systempreferences:com.apple.preference.icloud').catch(() => {})

  if (loading) return null
  if (!stats?.accessible) return null

  const isLow = stats.message_count < IMESSAGE_LOW_COUNT
  const oldest = _.isString(stats.oldest_message_at) ? new Date(stats.oldest_message_at) : null
  const oldestLabel = oldest && !isNaN(oldest.getTime())
    ? oldest.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
    : null

  return (
    <div className="mx-4 mb-3 rounded-card border border-border bg-surface-deep overflow-hidden">
      <div className="flex items-center justify-between py-2.5 px-3 text-sm">
        <div className="text-text-secondary">
          <span className="text-text-primary font-medium">{stats.message_count.toLocaleString()}</span> messages
          {' · '}
          <span className="text-text-primary font-medium">{stats.handle_count.toLocaleString()}</span> contacts
          {oldestLabel && <span className="text-text-muted"> · oldest from {oldestLabel}</span>}
          <span className="text-text-muted"> · this Mac</span>
        </div>
        <button
          onClick={resync}
          disabled={resyncing}
          className="inline-flex items-center gap-1 text-sm py-1 px-2.5 rounded-sm bg-[var(--hover-accent-strong)] text-text-primary border-none cursor-pointer disabled:opacity-50"
          title="Re-read chat.db and push any new messages to Supabase"
        >
          <RefreshCw size={12} className={resyncing ? 'animate-spin' : ''} />
          {resyncing ? 'Re-syncing…' : 'Re-sync'}
        </button>
      </div>
      {resyncMsg && <p className="px-3 pb-2 text-xs text-text-muted">{resyncMsg}</p>}

      {isLow ? (
        <div className="border-t border-warning/30 bg-[var(--hover-warning-subtle)] py-2.5 px-3 flex items-start gap-2">
          <AlertTriangle size={14} className="text-warning mt-0.5 shrink-0" />
          <div className="flex-1 text-sm text-text-secondary leading-normal">
            <p className="text-text-primary font-medium mb-0.5">iMessage history on this Mac is sparse.</p>
            <p className="mb-2">
              iMessage stores messages per-Mac. If you use iMessage on another device,
              install Convolios there (your inbox will merge automatically) or enable
              Messages in iCloud so this Mac downloads full history.
            </p>
            <div className="flex gap-2">
              <button
                onClick={openReleases}
                className="text-sm font-medium py-1 px-2.5 rounded-sm bg-[var(--hover-accent-strong)] text-text-primary border-none cursor-pointer"
              >
                Install on another Mac
              </button>
              <button
                onClick={openMessages}
                className="text-sm font-medium py-1 px-2.5 rounded-sm bg-transparent text-text-secondary border border-border cursor-pointer"
              >
                Enable Messages in iCloud
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="border-t border-border py-2 px-3 text-xs text-text-muted">
          Using iMessage on multiple devices? Install Convolios on each Mac — history merges automatically via shared sync.
        </div>
      )}
    </div>
  )
}

function CircleManagement({ userId }: { userId?: string }) {
  const { data: circles = [] } = useCircles(userId)
  const create = useCreateCircle(userId)
  const update = useUpdateCircle(userId)
  const remove = useDeleteCircle(userId)
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('')
  const [editEmoji, setEditEmoji] = useState('')
  const [editNotify, setEditNotify] = useState<'all' | 'muted'>('all')

  const handleCreate = () => {
    if (!newName.trim()) return
    create.mutate({ name: newName.trim() })
    setNewName('')
  }

  const startEdit = (c: { id: string; name: string; color: string; emoji: string | null; notify: string }) => {
    setEditingId(c.id)
    setEditName(c.name)
    setEditColor(c.color)
    setEditEmoji(c.emoji ?? '')
    setEditNotify(c.notify as 'all' | 'muted')
  }

  const saveEdit = () => {
    if (!editingId) return
    update.mutate({ id: editingId, name: editName.trim() || undefined, color: editColor, emoji: editEmoji || null, notify: editNotify })
    setEditingId(null)
  }

  return (
    <>
      <h2 className="settings-h2">Circles</h2>
      <p className="text-base mb-5 text-text-secondary">
        Organize your contacts into custom groups
      </p>

      <div className="flex gap-2 mb-6">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleCreate() }}
          placeholder="New circle name..."
          className="flex-1 h-9 rounded-sm px-3 bg-surface-deep text-text-primary text-base border border-border outline-none"
        />
        <button className="btn-primary h-9 px-4 text-base flex items-center gap-1" onClick={handleCreate}>
          <Plus size={16} /> Create
        </button>
      </div>

      {circles.length === 0 && <Hint>No circles yet</Hint>}

      {circles.map((c) => (
        <div key={c.id} className={`rounded-card mb-2 bg-surface-deep p-4 border ${editingId === c.id ? 'border-accent' : 'border-border'}`}>
          {editingId === c.id ? (
            <div className="flex flex-col gap-3">
              <div className="flex gap-2">
                <input
                  value={editEmoji}
                  onChange={(e) => setEditEmoji(e.target.value)}
                  placeholder="Emoji"
                  className="w-[50px] h-9 rounded-sm px-2 text-center bg-surface text-text-primary text-xl border border-border outline-none"
                />
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="flex-1 h-9 rounded-sm px-3 bg-surface text-text-primary text-base border border-border outline-none"
                />
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {CIRCLE_COLORS.map((clr) => (
                  <button
                    key={clr}
                    onClick={() => setEditColor(clr)}
                    className={`w-6 h-6 rounded-full cursor-pointer border-2 ${editColor === clr ? 'border-white' : 'border-transparent'}`}
                    style={{ background: clr }}
                  />
                ))}
              </div>
              <div className="flex gap-2 items-center">
                <span className="text-md text-text-secondary">Notifications:</span>
                <button onClick={() => setEditNotify('all')} className="settings-pill" data-active={editNotify === 'all'}>All</button>
                <button onClick={() => setEditNotify('muted')} className="settings-pill" data-active={editNotify === 'muted'}>Muted</button>
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setEditingId(null)}
                  className="text-md py-1 px-3 rounded-sm border-none bg-transparent text-text-secondary cursor-pointer"
                >Cancel</button>
                <button className="btn-primary text-md py-1 px-4" onClick={saveEdit}>Save</button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <span
                className="w-8 h-8 rounded-full flex items-center justify-center text-body shrink-0"
                style={{ background: c.color }}
              >
                {c.emoji ?? c.name.charAt(0).toUpperCase()}
              </span>
              <div className="flex-1 min-w-0">
                <span className="text-lg font-semibold text-text-primary">{c.name}</span>
                {c.notify === 'muted' && (
                  <span className="text-xs text-text-pending ml-2">muted</span>
                )}
              </div>
              <button
                onClick={() => startEdit(c)}
                className="text-sm py-1 px-2.5 rounded-sm border border-border bg-transparent text-text-secondary cursor-pointer"
              >Edit</button>
              <button
                onClick={() => remove.mutate(c.id)}
                className="py-1 px-2 rounded-sm border-none bg-transparent text-danger cursor-pointer"
              ><Trash2 size={14} /></button>
            </div>
          )}
        </div>
      ))}
    </>
  )
}

function confidenceTier(score: number): { label: string; cls: string } {
  if (score >= 0.95) return { label: 'Exact match', cls: 'bg-[var(--hover-success-subtle)] text-success' }
  if (score >= 0.85) return { label: 'Strong match', cls: 'bg-[var(--hover-accent-subtle)] text-accent' }
  return { label: 'Likely match', cls: 'bg-[var(--hover-warning-subtle)] text-warning' }
}

function mergeSuggestionSources(
  deterministic: MergeCluster[],
  fuzzy: MergeCluster[],
): MergeCluster[] {
  const seen = new Set<string>()
  const result: MergeCluster[] = []

  for (const c of deterministic) {
    const ids = (_.isArray(c.members) ? c.members : []).map((m) => m.id).sort()
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        seen.add(`${ids[i]}|${ids[j]}`)
      }
    }
    result.push(c)
  }

  for (const c of fuzzy) {
    const ids = (_.isArray(c.members) ? c.members : []).map((m) => m.id).sort()
    const isDuplicate = ids.some((a, i) =>
      ids.slice(i + 1).some((b) => seen.has(`${a}|${b}`))
    )
    if (isDuplicate) continue
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        seen.add(`${ids[i]}|${ids[j]}`)
      }
    }
    result.push(c)
  }

  return result.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
}

function MergeSuggestionsView({ userId }: { userId?: string }) {
  const { data: deterministicClusters = [], isLoading: detLoading, isError: detError, error: detFetchError } = useMergeClusters(userId)
  const { data: fuzzyClusters = [], isLoading: fuzzyLoading, isError: fuzzyError } = useFuzzyMergeSuggestions(userId)
  const mergeCluster = useMergeCluster(userId)
  const dismiss = useDismissMerge(userId)
  const [error, setError] = useState('')

  const isLoading = detLoading || fuzzyLoading
  const clusters = mergeSuggestionSources(deterministicClusters, fuzzyClusters)

  const handleMergeCluster = (keepId: string, mergeIds: string[]) => {
    setError('')
    mergeCluster.mutate({ keepId, mergeIds }, {
      onError: (e) => setError(_.isString(e?.message) ? e.message : 'Merge failed'),
    })
  }

  const handleDismissPair = (idA: string, idB: string) => {
    setError('')
    dismiss.mutate({ personA: idA, personB: idB }, {
      onError: (e) => setError(_.isString(e?.message) ? e.message : 'Dismiss failed'),
    })
  }

  const handleDismissAll = (members: { id: string }[]) => {
    const ids = members.map((m) => m.id).sort()
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        dismiss.mutate({ personA: ids[i], personB: ids[j] })
      }
    }
  }

  return (
    <>
      <h2 className="settings-h2">Merge Suggestions</h2>
      <p className="text-base mb-5 text-text-secondary">
        Contacts that appear to be the same person across channels. When you merge, all their conversations and identities are unified into one.
      </p>

      {error && (
        <div className="py-2 px-3 rounded-md mb-3 bg-[var(--hover-danger)] text-danger text-md">
          {error}
        </div>
      )}

      {isLoading && <SettingsSkeleton />}
      {(detError || fuzzyError) && (
        <div className="py-2 px-3 rounded-md mb-3 bg-[var(--hover-danger)] text-danger text-md">
          {_.isString((detFetchError as Error)?.message) ? (detFetchError as Error).message : 'Failed to load merge suggestions'}
        </div>
      )}
      {!isLoading && !detError && clusters.length === 0 && <Hint>No merge suggestions right now</Hint>}

      {clusters.map((cluster) => {
        const members = _.isArray(cluster.members) ? cluster.members : []
        const mergeIds = members.map((m) => m.id)
        const tier = confidenceTier(cluster.score ?? 0)

        return (
          <div key={cluster.cluster_id} className="rounded-card mb-3 p-4 bg-surface-deep border border-border">
            {/* Member list */}
            <div className="flex flex-wrap gap-3 mb-3">
              {members.map((m, i) => (
                <div key={m.id} className="flex items-center gap-2 min-w-0">
                  {i > 0 && <Link2 size={12} className="text-accent shrink-0" />}
                  <SuggestionAvatar name={m.name} avatar={m.avatar} id={m.id} />
                  <div className="min-w-0">
                    <span className="text-md font-semibold text-text-primary">{m.name}</span>
                    <div className="flex gap-[3px] mt-0.5 flex-wrap">
                      {_.isArray(m.channels) && m.channels.map((ch) => <ChannelPill key={ch} channel={ch} />)}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Match signal with confidence tier */}
            <div className="flex items-center gap-2 mb-3">
              <span className={`text-xs py-0.5 px-2 rounded-chip ${tier.cls}`}>
                {tier.label}
              </span>
              <span className="text-sm text-text-muted">{cluster.match_detail}</span>
              <span className="text-xs text-text-pending">{Math.round((cluster.score ?? 0) * 100)}%</span>
            </div>

            {/* Actions */}
            <div className="flex gap-2 flex-wrap">
              {members.map((m) => {
                const otherIds = mergeIds.filter((id) => id !== m.id)
                const namesMatch = members.every((mm) => mm.name.split(' ')[0] === m.name.split(' ')[0])
                const channelHint = namesMatch && _.isArray(m.channels) ? ` (${m.channels[0]})` : ''
                const label = members.length > 2
                  ? `Keep ${m.name.split(' ')[0]}${channelHint} (merge ${otherIds.length} others)`
                  : `Keep ${m.name.split(' ')[0]}${channelHint}`
                const isSuggested = m.id === cluster.keep_person_id
                return (
                  <button key={m.id}
                    onClick={() => handleMergeCluster(m.id, otherIds)}
                    disabled={mergeCluster.isPending}
                    className={`text-sm font-medium py-1.5 px-3.5 rounded-sm flex items-center gap-1 ${isSuggested ? 'border-none bg-accent text-white' : 'border border-border bg-transparent text-text-secondary'} ${mergeCluster.isPending ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                  >
                    <Check size={12} /> {label}
                  </button>
                )
              })}
              <button
                onClick={() => members.length === 2
                  ? handleDismissPair(members[0].id, members[1].id)
                  : handleDismissAll(members)
                }
                disabled={dismiss.isPending}
                className="text-sm font-medium py-1.5 px-3.5 rounded-sm border border-[var(--hover-accent-strong)] bg-transparent text-danger cursor-pointer flex items-center gap-1 ml-auto"
              >
                <X size={12} /> Not the same
              </button>
            </div>
          </div>
        )
      })}
    </>
  )
}

function SuggestionAvatar({ name, avatar, id }: { name: string; avatar: string | null; id?: string }) {
  return (
    <div className={`${id ? avatarCls(id) : 'bg-[var(--color-accent)]'} flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full`}>
      <AvatarImage
        src={avatar}
        className="h-full w-full object-cover"
        fallback={<span className="text-base font-semibold text-white">{initials(name)}</span>}
      />
    </div>
  )
}

function ChannelPill({ channel }: { channel: string }) {
  return (
    <span className="text-2xs py-px px-1.5 rounded-chip bg-surface text-text-muted flex items-center gap-[3px]">
      <ChannelLogo channel={channel} size={10} color="var(--color-text-muted)" />
      {channelLabel(channel as import('../../types').Channel)}
    </span>
  )
}

function MergeHistory({ userId }: { userId?: string }) {
  const { data: log = [], isLoading } = useMergeLog(userId)
  const undoMerge = useUndoMerge(userId)

  return (
    <>
      <h2 className="settings-h2">Merge History</h2>
      <p className="text-base mb-5 text-text-secondary">
        View and undo past person merges
      </p>

      {isLoading && <Hint>Loading merge history...</Hint>}

      {!isLoading && log.length === 0 && <Hint>No merges yet</Hint>}

      {log.map((entry) => (
        <div key={entry.id} className={`rounded-card mb-2 p-4 bg-surface-deep border border-border ${entry.undone_at ? 'opacity-50' : ''}`}>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-base font-semibold text-text-primary">
              {entry.merged_person_name}
            </span>
            <span className="text-sm text-text-pending">
              merged {relativeTime(entry.merged_at)}
            </span>
            {entry.undone_at && (
              <span className="text-xs py-px px-1.5 rounded-chip bg-[var(--hover-warning-subtle)] text-warning">undone</span>
            )}
          </div>
          <div className="text-sm text-text-muted mb-1">
            {entry.merged_message_count} messages reassigned
          </div>
          <div className="flex gap-1 flex-wrap mb-2">
            {_.isArray(entry.merged_identities) && entry.merged_identities.map((ident) => (
              <span key={ident.id} className="text-xs py-px px-1.5 rounded-chip bg-surface text-text-secondary">
                {ident.channel}: {ident.handle}
              </span>
            ))}
          </div>
          {!entry.undone_at && (
            <button
              onClick={() => undoMerge.mutate(entry.id)}
              disabled={undoMerge.isPending}
              className="text-sm font-medium py-1 px-3 rounded-sm border border-[var(--hover-warning-strong)] bg-transparent text-warning cursor-pointer flex items-center gap-1"
            >
              <Undo2 size={12} /> Undo merge
            </button>
          )}
        </div>
      ))}
    </>
  )
}

function PreferencesSection() {
  const syncReadStatus = usePreferencesStore((s) => s.syncReadStatus)
  const setSyncReadStatus = usePreferencesStore((s) => s.setSyncReadStatus)

  return (
    <>
      <h2 className="settings-h2">Preferences</h2>

      <div className="settings-card">
        <div className="settings-card-body">
          <p className="settings-card-name">Sync read status</p>
          <p className="settings-card-desc">
            When enabled, opening a conversation or sending a reply marks it as read on the original platform.
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <button onClick={() => setSyncReadStatus(true)} className="settings-pill" data-active={syncReadStatus}>On</button>
          <button onClick={() => setSyncReadStatus(false)} className="settings-pill" data-active={!syncReadStatus}>Off</button>
        </div>
      </div>

      <div className="h-px bg-border my-10" />

      <h2 className="settings-h2 settings-h2--tight">Read Status Sync by Channel</h2>
      <p className="text-sm text-text-muted mb-5">
        Not all messaging platforms expose read status control. Here&apos;s what happens on each channel when sync is enabled.
      </p>

      <div className="rounded-card border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-deep text-text-secondary text-left">
              <th className="py-2.5 px-4 font-semibold">Channel</th>
              <th className="py-2.5 px-4 font-semibold">Read Sync</th>
              <th className="py-2.5 px-4 font-semibold">Details</th>
            </tr>
          </thead>
          <tbody>
            {READ_SYNC_CHANNELS.map((row) => (
              <tr key={row.channel} className="border-t border-border">
                <td className="py-2.5 px-4">
                  <span className="inline-flex items-center gap-2">
                    <ChannelLogo channel={row.channel} size={16} />
                    <span className="text-text-primary font-medium">{channelLabel(row.channel)}</span>
                  </span>
                </td>
                <td className="py-2.5 px-4">
                  {row.supported
                    ? <span className="inline-flex items-center gap-1 text-success"><Check size={13} /> Supported</span>
                    : <span className="text-text-muted">Not available</span>}
                </td>
                <td className="py-2.5 px-4 text-text-muted">{row.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

const READ_SYNC_CHANNELS = [
  { channel: 'whatsapp', supported: true,  detail: 'Clears unread badge. Sends read receipts if enabled in your WhatsApp privacy settings.' },
  { channel: 'linkedin', supported: true,  detail: 'Marks messages as read on LinkedIn.' },
  { channel: 'instagram', supported: false, detail: 'Not supported by the messaging provider API.' },
  { channel: 'telegram', supported: false, detail: 'Not supported by the messaging provider API.' },
  { channel: 'email',    supported: false, detail: 'Email uses a different protocol (IMAP). Not applicable.' },
  { channel: 'x',        supported: false, detail: 'Not supported by the messaging provider API.' },
]

function AboutSection() {
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const { status, version, error, checkForUpdate, installUpdate } = useUpdater()

  useEffect(() => {
    getVersion().then(setAppVersion).catch((e) => {
      console.error('[about] getVersion failed', e)
    })
  }, [])

  const busy = status === 'checking' || status === 'installing'
  const buttonLabel =
    status === 'checking'   ? 'Checking…'
    : status === 'installing' ? 'Installing…'
    : status === 'available'  ? 'Restart & Update'
    :                           'Check for Updates'

  const onClick = status === 'available' ? installUpdate : checkForUpdate

  return (
    <>
      <h2 className="settings-h2">About</h2>

      <div className="settings-card">
        <div className="settings-card-body">
          <p className="settings-card-name">Convolios</p>
          <p className="settings-card-desc">
            {appVersion ? `Version ${appVersion}` : 'Loading version…'}
            {status === 'available' && _.isString(version) && (
              <> · <span className="text-accent font-medium">v{version} available</span></>
            )}
            {status === 'upToDate' && <> · <span className="text-success">Up to date</span></>}
            {status === 'error' && _.isString(error) && (
              <> · <span className="text-danger">{error}</span></>
            )}
          </p>
        </div>
        <button
          onClick={onClick}
          disabled={busy}
          className={
            status === 'available'
              ? 'btn-primary btn-primary-sm'
              : 'settings-card-btn bg-[var(--hover-accent-strong)] text-text-primary'
          }
        >
          {buttonLabel}
        </button>
      </div>
    </>
  )
}
