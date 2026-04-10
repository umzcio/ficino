import { useState, useEffect, useCallback } from 'react'
import type { Workspace } from '../types'
import { listWorkspaces, createWorkspace, deleteWorkspace } from '../lib/api'

const ACTIVE_WORKSPACE_KEY = 'ficino_active_workspace'
const DEFAULT_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'

export function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeId, setActiveId] = useState<string>(() => {
    return localStorage.getItem(ACTIVE_WORKSPACE_KEY) || DEFAULT_WORKSPACE_ID
  })
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const data = await listWorkspaces()
      setWorkspaces(data)
      // If active workspace was deleted, fall back to first available
      if (data.length > 0 && !data.find((w) => w.id === activeId)) {
        setActiveId(data[0].id)
        localStorage.setItem(ACTIVE_WORKSPACE_KEY, data[0].id)
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [activeId])

  useEffect(() => {
    refresh()
  }, [refresh])

  const switchTo = useCallback((id: string) => {
    setActiveId(id)
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, id)
  }, [])

  const create = useCallback(async (name: string) => {
    const result = await createWorkspace(name)
    await refresh()
    switchTo(result.id)
    return result
  }, [refresh, switchTo])

  const remove = useCallback(async (id: string) => {
    await deleteWorkspace(id)
    await refresh()
  }, [refresh])

  const active = workspaces.find((w) => w.id === activeId) || workspaces[0] || null

  // Only show workspace UI when there are 2+ workspaces
  const showWorkspaceUI = workspaces.length > 1

  return { workspaces, active, activeId, loading, showWorkspaceUI, switchTo, create, remove, refresh }
}
