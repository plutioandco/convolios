import { useState, useEffect } from 'react'
import { useUser } from '@clerk/clerk-react'
import { invoke } from '@tauri-apps/api/core'
import _ from 'lodash'
import { useAccountsStore } from '../../stores/accountsStore'
import { CHANNEL_META } from '../../utils'
import type { Channel } from '../../types'

export function Settings() {
  const { user } = useUser()
  const accounts = useAccountsStore((s) => s.accounts)
  const loading = useAccountsStore((s) => s.loading)
  const fetchAccounts = useAccountsStore((s) => s.fetchAccounts)

  useEffect(() => {
    if (user?.id) {
      fetchAccounts(user.id)
    }
  }, [user?.id, fetchAccounts])

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h1 className="text-xl font-bold mb-6" style={{ color: 'var(--text-primary)' }}>
        Settings
      </h1>

      <section className="mb-8">
        <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-secondary)' }}>
          Connected Accounts
        </h2>

        {loading && (
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Loading...</p>
        )}

        {!loading && accounts.length === 0 && (
          <div className="rounded-lg p-4" style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}>
            <p className="text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>
              No accounts connected yet.
            </p>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Connect your messaging accounts through the Unipile dashboard, then register them here.
            </p>
          </div>
        )}

        <div className="space-y-2">
          {accounts.map((acc) => {
            const meta = CHANNEL_META[acc.channel as Channel]
            return (
              <div
                key={acc.id}
                className="flex items-center gap-3 rounded-lg px-4 py-3"
                style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}
              >
                <span className="text-lg">{meta?.icon ?? '💬'}</span>
                <div className="flex-1">
                  <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                    {meta?.label ?? acc.channel}
                  </div>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {acc.provider} &middot; {acc.account_id}
                  </div>
                </div>
                <span
                  className="text-xs px-2 py-0.5 rounded-full font-medium"
                  style={{
                    color: acc.status === 'active' ? 'var(--success)' : 'var(--danger)',
                    border: `1px solid ${acc.status === 'active' ? 'var(--success)' : 'var(--danger)'}`,
                  }}
                >
                  {acc.status}
                </span>
              </div>
            )
          })}
        </div>
      </section>

      <section className="mb-8">
        <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-secondary)' }}>
          Infrastructure Health
        </h2>
        <div className="space-y-2">
          <HealthCheck label="Unipile API" command="check_unipile_connection" />
          <HealthCheck label="Gemini AI" command="check_gemini_connection" />
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-secondary)' }}>
          Setup Instructions
        </h2>
        <div className="rounded-lg p-4 text-xs space-y-2" style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
          <p>1. Go to unipile.com dashboard and connect your WhatsApp (QR scan) and/or Gmail (OAuth).</p>
          <p>2. Note the account_id Unipile assigns to each connected account.</p>
          <p>3. Deploy the webhook Edge Function to Supabase and register the URL in Unipile.</p>
          <p>4. Messages will automatically flow into your inbox in real-time.</p>
        </div>
      </section>
    </div>
  )
}

function HealthCheck({ label, command }: { label: string; command: string }) {
  const [status, setStatus] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle')
  const [detail, setDetail] = useState('')

  const check = async () => {
    setStatus('checking')
    try {
      const result = await invoke<string>(command)
      setStatus('ok')
      setDetail(result)
    } catch (err) {
      setStatus('error')
      setDetail(String(err))
    }
  }

  return (
    <div
      className="flex items-center gap-3 rounded-lg px-4 py-3"
      style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}
    >
      <div className="flex-1">
        <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          {label}
        </div>
        {detail && (
          <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {detail}
          </div>
        )}
      </div>
      <button
        onClick={check}
        disabled={status === 'checking'}
        className="text-xs px-3 py-1 rounded cursor-pointer"
        style={{
          backgroundColor: status === 'ok' ? 'var(--success)' : status === 'error' ? 'var(--danger)' : 'var(--accent)',
          color: '#fff',
          opacity: status === 'checking' ? 0.5 : 1,
        }}
      >
        {status === 'checking' ? '...' : status === 'ok' ? 'OK' : status === 'error' ? 'Retry' : 'Test'}
      </button>
    </div>
  )
}
