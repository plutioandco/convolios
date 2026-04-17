import { useCallback, useEffect, useRef, useState } from 'react'
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

// Updater status machine.
//   idle       — nothing has happened yet (or manual check hasn't been invoked)
//   checking   — a check() is in flight
//   available  — new version detected; user can install
//   upToDate   — check succeeded, no newer version
//   installing — downloadAndInstall in flight; relaunch imminent
//   error      — last operation threw (error message stored)
export type UpdaterStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'upToDate'
  | 'installing'
  | 'error'

export function useUpdater() {
  const [status, setStatus] = useState<UpdaterStatus>('idle')
  const [version, setVersion] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  const checkForUpdate = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setStatus('checking')
    setError(null)
    try {
      const update = await check()
      if (update) {
        setVersion(update.version)
        setStatus('available')
      } else {
        setVersion(null)
        setStatus('upToDate')
      }
    } catch (err) {
      // Log so a missing capability, signature mismatch, or network error
      // surfaces in DevTools instead of vanishing into a silent catch.
      console.error('[updater] check failed', err)
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    } finally {
      inFlight.current = false
    }
  }, [])

  const installUpdate = useCallback(async () => {
    setStatus('installing')
    setError(null)
    try {
      const update = await check()
      if (update) {
        await update.downloadAndInstall()
        await relaunch()
      } else {
        // Nothing to install — probably already updated in a different window.
        setStatus('upToDate')
      }
    } catch (err) {
      console.error('[updater] install failed', err)
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    // Delay so startup isn't blocked by a network request to GitHub.
    const timer = setTimeout(checkForUpdate, 5000)
    return () => clearTimeout(timer)
  }, [checkForUpdate])

  return { status, version, error, checkForUpdate, installUpdate }
}
