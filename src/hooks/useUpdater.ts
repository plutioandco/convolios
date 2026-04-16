import { useEffect, useState } from 'react'
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

export function useUpdater() {
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const checkForUpdate = async () => {
      try {
        const update = await check()
        if (!cancelled && update) {
          setUpdateAvailable(true)
          setVersion(update.version)
        }
      } catch {
        // silently ignore update check failures
      }
    }
    // Check after 5s delay to not block startup
    const timer = setTimeout(checkForUpdate, 5000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [])

  const installUpdate = async () => {
    try {
      setUpdating(true)
      const update = await check()
      if (update) {
        await update.downloadAndInstall()
        await relaunch()
      }
    } catch {
      setUpdating(false)
    }
  }

  return { updateAvailable, updating, version, installUpdate }
}
