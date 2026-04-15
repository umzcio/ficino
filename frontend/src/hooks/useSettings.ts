import { useState, useEffect, useCallback } from 'react'
import { getSettings, updateSettings } from '../lib/api'
import { cacheSettings, getCachedSettings } from '../lib/offline-cache'

export function useSettings() {
  const [settings, setSettings] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const data = await getSettings()
      cacheSettings(data).catch(() => {})
      setSettings(data)
    } catch {
      try {
        const cached = await getCachedSettings()
        if (cached) setSettings(cached)
      } catch { /* ignore */ }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const update = useCallback(async (partial: Record<string, unknown>) => {
    try {
      const data = await updateSettings(partial)
      setSettings(data)
    } catch {
      // ignore
    }
  }, [])

  return { settings, loading, update, refresh }
}
