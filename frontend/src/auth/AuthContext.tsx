import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { clearOfflineData } from '../lib/workspace-download'

export interface AuthUser {
  id: string
  email: string
  display_name: string | null
}

interface AuthContextValue {
  user: AuthUser | null
  loading: boolean
  provider: 'none' | 'basic' | 'supabase'
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  error: string | null
}

const AuthCtx = createContext<AuthContextValue>({
  user: null,
  loading: true,
  provider: 'none',
  signIn: async () => {},
  signUp: async () => {},
  signOut: async () => {},
  error: null,
})

export function useAuth() {
  return useContext(AuthCtx)
}

const API_BASE = import.meta.env.VITE_API_BASE || '/ficino/api'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _supabaseClient: any = null

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [provider, setProvider] = useState<'none' | 'basic' | 'supabase'>('none')
  const [error, setError] = useState<string | null>(null)

  // Discover provider and initialize auth state
  useEffect(() => {
    async function init() {
      try {
        // Discover provider
        const res = await fetch(`${API_BASE}/auth/provider`)
        const data = await res.json()
        const p = data.provider as 'none' | 'basic' | 'supabase'
        setProvider(p)

        if (p === 'none') {
          // No auth — stub user, always authenticated
          setUser({ id: '00000000-0000-0000-0000-000000000000', email: 'stub@ficino.dev', display_name: 'You' })
          setLoading(false)
          return
        }

        if (p === 'basic') {
          // Check if we have a valid session
          const meRes = await fetch(`${API_BASE}/auth/me`, { credentials: 'include' })
          if (meRes.ok) {
            const me = await meRes.json()
            setUser(me)
          }
          setLoading(false)
          return
        }

        if (p === 'supabase') {
          // Initialize Supabase client
          const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
          const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY
          if (!supabaseUrl || !supabaseKey) {
            setError('Supabase config missing (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)')
            setLoading(false)
            return
          }
          const { createClient } = await import('@supabase/supabase-js')
          const supabase = createClient(supabaseUrl, supabaseKey)
          ;_supabaseClient = supabase

          const { data: { session } } = await supabase.auth.getSession()
          if (session) {
            setUser({ id: session.user.id, email: session.user.email || '', display_name: null })
          }

          supabase.auth.onAuthStateChange((_event: string, session: { user: { id: string; email?: string } } | null) => {
            if (session) {
              setUser({ id: session.user.id, email: session.user.email || '', display_name: null })
            } else {
              setUser(null)
            }
          })

          setLoading(false)
          return
        }
      } catch {
        // If provider endpoint fails, fall back to none
        setProvider('none')
        setUser({ id: '00000000-0000-0000-0000-000000000000', email: 'stub@ficino.dev', display_name: 'You' })
      }
      setLoading(false)
    }
    init()
  }, [])

  const signIn = useCallback(async (email: string, password: string) => {
    setError(null)
    if (provider === 'basic') {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        credentials: 'include',
      })
      if (!res.ok) {
        const data = await res.json()
        setError(data.detail || 'Login failed')
        return
      }
      // Fetch user profile
      const meRes = await fetch(`${API_BASE}/auth/me`, { credentials: 'include' })
      if (meRes.ok) setUser(await meRes.json())
    } else if (provider === 'supabase') {
      const supabase = _supabaseClient as any
      const { error: err } = await supabase.auth.signInWithPassword({ email, password })
      if (err) setError(err.message)
    }
  }, [provider])

  const signUp = useCallback(async (email: string, password: string) => {
    setError(null)
    if (provider === 'basic') {
      const res = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        credentials: 'include',
      })
      if (!res.ok) {
        const data = await res.json()
        setError(data.detail || 'Registration failed')
        return
      }
      // Fetch user profile
      const meRes = await fetch(`${API_BASE}/auth/me`, { credentials: 'include' })
      if (meRes.ok) setUser(await meRes.json())
    } else if (provider === 'supabase') {
      const supabase = _supabaseClient as any
      const { error: err } = await supabase.auth.signUp({ email, password })
      if (err) setError(err.message)
    }
  }, [provider])

  const signOut = useCallback(async () => {
    // Wipe per-user IndexedDB before dropping auth state. None of the offline
    // stores carry a userId key, so leaving them in place means the next user
    // on this browser sees the prior user's bookmarks / annotations / etc.
    // during the fetch-in-flight window. Swallow errors — they shouldn't block
    // sign-out, but a failure here means some stale data may linger.
    try {
      await clearOfflineData()
    } catch { /* ignore */ }
    if (provider === 'basic') {
      await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' })
      setUser(null)
    } else if (provider === 'supabase') {
      const supabase = _supabaseClient as any
      await supabase.auth.signOut()
      setUser(null)
    }
  }, [provider])

  return (
    <AuthCtx.Provider value={{ user, loading, provider, signIn, signUp, signOut, error }}>
      {children}
    </AuthCtx.Provider>
  )
}
