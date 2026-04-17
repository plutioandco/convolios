import { create } from 'zustand'
import { createTauriStore } from '@tauri-store/zustand'

interface PreferencesState {
  syncReadStatus: boolean
  setSyncReadStatus: (enabled: boolean) => void
  autoSnoozeOnSend: boolean
  setAutoSnoozeOnSend: (enabled: boolean) => void
}

export const usePreferencesStore = create<PreferencesState>((set) => ({
  syncReadStatus: true,
  setSyncReadStatus: (syncReadStatus) => set({ syncReadStatus }),
  autoSnoozeOnSend: false,
  setAutoSnoozeOnSend: (autoSnoozeOnSend) => set({ autoSnoozeOnSend }),
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const preferencesTauriStore = createTauriStore('preferences', usePreferencesStore as any)

preferencesTauriStore.start().catch(() => {
  if (import.meta.env.DEV) console.warn('Tauri store not available (non-Tauri env)')
})
