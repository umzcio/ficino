import { useState, useEffect, useCallback, useRef } from 'react'
import { listAlerts, getUnreadCount, markAlertRead, markAllAlertsRead, dismissAlert, type AlertItem } from '../lib/api'
import { cacheAlerts, getCachedAlerts } from '../lib/offline-cache'

export function useAlerts() {
  const [alerts, setAlerts] = useState<AlertItem[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [alertsData, countData] = await Promise.all([listAlerts(), getUnreadCount()])
      cacheAlerts(alertsData).catch(() => {})
      setAlerts(alertsData)
      setUnreadCount(countData.count)
    } catch {
      try {
        const cached = await getCachedAlerts()
        if (cached.length > 0) {
          setAlerts(cached)
          setUnreadCount(cached.filter(a => !a.read).length)
        }
      } catch { /* ignore */ }
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load + poll every 30s for new alerts
  useEffect(() => {
    refresh()
    pollRef.current = setInterval(refresh, 30000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [refresh])

  // "Delete Everything" wipes alerts on the server (the granular clears
  // never did). Reset local state the moment the bulk delete completes
  // instead of waiting for the 30s poll to catch up.
  useEffect(() => {
    const onCleared = () => {
      setAlerts([])
      setUnreadCount(0)
    }
    window.addEventListener('ficino:everything-cleared', onCleared)
    return () => window.removeEventListener('ficino:everything-cleared', onCleared)
  }, [])

  const markRead = useCallback(async (id: string) => {
    await markAlertRead(id)
    await refresh()
  }, [refresh])

  const markAllRead = useCallback(async () => {
    await markAllAlertsRead()
    await refresh()
  }, [refresh])

  const dismiss = useCallback(async (id: string) => {
    // R10 wave-3 final review Minor 4: refresh unconditionally, even if the
    // dismiss request itself failed, so the alert list resyncs with server
    // state instead of staying stuck on a stale optimistic view. The error
    // still propagates to the caller after refresh runs.
    try {
      await dismissAlert(id)
    } finally {
      await refresh()
    }
  }, [refresh])

  return { alerts, unreadCount, loading, markRead, markAllRead, dismiss, refresh }
}
