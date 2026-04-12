import { createClient } from '@supabase/supabase-js'
import _ from 'lodash'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env.local')
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  realtime: {
    heartbeatIntervalMs: 15_000,
    worker: !_.isNil(globalThis.window) && !!window.Worker,
    heartbeatCallback: (status) => {
      if (import.meta.env.DEV) console.debug('[supabase] heartbeat', status)
      if (status === 'disconnected') {
        supabase.realtime.connect()
      }
    },
  },
})
