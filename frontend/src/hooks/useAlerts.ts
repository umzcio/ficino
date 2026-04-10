import { useState, useEffect, useCallback, useRef } from 'react'
import { listAlerts, getUnreadCount, markAlertRead, markAllAlertsRead, dismissAlert, type AlertItem } from '../lib/api'

export function useAlerts() {
  const [alerts, setAlerts] = useState<AlertItem[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [alertsData, countData] = await Promise.all([listAlerts(), getUnreadCount()])
      setAlerts(alertsData)
      setUnreadCount(countData.count)
    } catch {
      // ignore
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

  const markRead = useCallback(async (id: string) => {
    await markAlertRead(id)
    await refresh()
  }, [refresh])

  const markAllRead = useCallback(async () => {
    await markAllAlertsRead()
    await refresh()
  }, [refresh])

  const dismiss = useCallback(async (id: string) => {
    await dismissAlert(id)
    await refresh()
  }, [refresh])

  return { alerts, unreadCount, loading, markRead, markAllRead, dismiss, refresh }
}
