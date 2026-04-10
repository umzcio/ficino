import { useState, useEffect, useCallback } from 'react'
import { getSettings, updateSettings } from '../lib/api'

export function useSettings() {
  const [settings, setSettings] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const data = await getSettings()
      setSettings(data)
    } catch {
      // ignore
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
