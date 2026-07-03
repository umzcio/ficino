import { createContext, useContext } from 'react'
import { useOnlineStatus } from '../hooks/useOnlineStatus'

const OnlineContext = createContext(true)

export function OnlineProvider({ children }: { children: React.ReactNode }) {
  const isOnline = useOnlineStatus()
  return <OnlineContext.Provider value={isOnline}>{children}</OnlineContext.Provider>
}

// Standard Context provider + consumer-hook pairing (OnlineProvider/
// useIsOnline); splitting the hook into its own file would only serve Fast
// Refresh granularity, at the cost of the usual
// "import { OnlineProvider, useIsOnline } from './online-context'" call
// sites. Same pattern as AuthContext's useAuth / arePostsEqual in
// PostCard.tsx.
// eslint-disable-next-line react-refresh/only-export-components
export function useIsOnline() {
  return useContext(OnlineContext)
}
