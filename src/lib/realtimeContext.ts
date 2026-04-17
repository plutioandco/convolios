import { createContext, useContext } from 'react'

export const RealtimeContext = createContext(true)
export const useRealtimeConnected = () => useContext(RealtimeContext)
