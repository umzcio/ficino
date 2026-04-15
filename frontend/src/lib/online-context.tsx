import { createContext, useContext } from 'react'
import { useOnlineStatus } from '../hooks/useOnlineStatus'

const OnlineContext = createContext(true)

export function OnlineProvider({ children }: { children: React.ReactNode }) {
  const isOnline = useOnlineStatus()
  return <OnlineContext.Provider value={isOnline}>{children}</OnlineContext.Provider>
}

export function useIsOnline() {
  return useContext(OnlineContext)
}
