import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { clearOfflineData } from '../lib/workspace-download'
import { setAuthTokenGetter } from '../lib/api'

// Holds the current Supabase access token so api.ts can attach it to the
// Authorization header synchronously on every request. Refreshed below by
// onAuthStateChange whenever Supabase rotates the token (every ~1 hour).
let _currentAccessToken: string | null = null

export interface AuthUser {
  id: string
  email: string
  display_name: string | null
}

interface AuthContextValue {
  user: AuthUser | null
  loading: boolean
  provider: 'none' | 'basic' | 'supabase'
  // True on the hosted/SaaS deployment. Signals to the UI that LLM
  // provider + API-key controls should be hidden — the operator's
  // env config is the source of truth on public installs.
  publicDeployment: boolean
  // True right after the user clicks a Supabase password-recovery email
  // link. While this is on the login page should show a "set new
  // password" form rather than logging the user into the app.
  passwordRecovery: boolean
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  sendPasswordReset: (email: string) => Promise<void>
  updatePassword: (newPassword: string) => Promise<void>
  // Verify the 6-digit recovery code from the reset email, then set a new
  // password in one shot. Use this on corporate inboxes (Microsoft ATP,
  // Google Safe Browsing) where link-scanning burns single-use tokens
  // before the user can click.
  verifyRecoveryCode: (email: string, code: string, newPassword: string) => Promise<boolean>
  error: string | null
  info: string | null
}

const AuthCtx = createContext<AuthContextValue>({
  user: null,
  loading: true,
  provider: 'none',
  publicDeployment: false,
  passwordRecovery: false,
  signIn: async () => {},
  signUp: async () => {},
  signOut: async () => {},
  sendPasswordReset: async () => {},
  updatePassword: async () => {},
  verifyRecoveryCode: async () => false,
  error: null,
  info: null,
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
  const [publicDeployment, setPublicDeployment] = useState(false)
  const [passwordRecovery, setPasswordRecovery] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  // Discover provider and initialize auth state
  useEffect(() => {
    async function init() {
      try {
        // Discover provider + deployment mode
        const res = await fetch(`${API_BASE}/auth/provider`)
        const data = await res.json()
        const p = data.provider as 'none' | 'basic' | 'supabase'
        setProvider(p)
        setPublicDeployment(Boolean(data.public_deployment))

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

          // Register the sync token getter before anything makes an API call.
          // api.ts reads _currentAccessToken on every request and attaches
          // "Authorization: Bearer <token>" when present.
          setAuthTokenGetter(() => _currentAccessToken)

          const { data: { session } } = await supabase.auth.getSession()
          if (session) {
            _currentAccessToken = session.access_token ?? null
            setUser({ id: session.user.id, email: session.user.email || '', display_name: null })
          }

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          supabase.auth.onAuthStateChange((event: string, session: any) => {
            _currentAccessToken = session?.access_token ?? null
            if (session) {
              setUser({ id: session.user.id, email: session.user.email || '', display_name: null })
            } else {
              setUser(null)
            }
            // PASSWORD_RECOVERY is fired when the user lands from a
            // "Reset your password" email. Supabase has already exchanged
            // the recovery token for a short-lived session — the only
            // valid action on it is updateUser({password}), after which
            // Supabase upgrades it to a normal session. We flip the flag
            // so the login surface renders a new-password form instead
            // of dropping the user straight into the app.
            if (event === 'PASSWORD_RECOVERY') {
              setPasswordRecovery(true)
            }
          })

          setLoading(false)
          return
        }
      } catch (err) {
        // Self-host default: if /auth/provider is unreachable AND the frontend
        // wasn't built against an explicit API origin, assume a single-user
        // local dev install and drop in as the stub user. On hosted deploys
        // VITE_API_BASE is always set — a failed fetch there is a real outage
        // and silently granting stub access would be an auth bypass.
        if (!import.meta.env.VITE_API_BASE) {
          setProvider('none')
          setUser({ id: '00000000-0000-0000-0000-000000000000', email: 'stub@ficino.dev', display_name: 'You' })
        } else {
          setError('Cannot reach API — please try again in a moment.')
        }
        console.error('auth/provider discovery failed:', err)
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

  const sendPasswordReset = useCallback(async (email: string) => {
    setError(null)
    setInfo(null)
    if (provider === 'supabase') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const supabase = _supabaseClient as any
      // redirectTo must be in Supabase Auth → URL Configuration → Redirect URLs.
      // Send recovery links to a dedicated /auth/reset path so the frontend
      // can force the reset-password form from the URL alone, regardless
      // of which event Supabase emits (PKCE flow often surfaces SIGNED_IN
      // rather than PASSWORD_RECOVERY).
      const redirectTo = typeof window !== 'undefined'
        ? `${window.location.origin}/auth/reset`
        : undefined
      const { error: err } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
      if (err) {
        setError(err.message)
        return
      }
      setInfo('Check your email for a reset link.')
    } else {
      setError('Password reset is only available with Supabase auth.')
    }
  }, [provider])

  const verifyRecoveryCode = useCallback(async (email: string, code: string, newPassword: string): Promise<boolean> => {
    setError(null)
    setInfo(null)
    if (provider !== 'supabase') {
      setError('Recovery code is only available with Supabase auth.')
      return false
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase = _supabaseClient as any
    // Trim because Outlook / Apple Mail sometimes pastes with trailing
    // whitespace; Supabase rejects "123456 " verbatim.
    const cleanCode = code.trim()
    const { data, error: vErr } = await supabase.auth.verifyOtp({
      email,
      token: cleanCode,
      type: 'recovery',
    })
    if (vErr || !data?.session) {
      setError(vErr?.message || 'Invalid or expired code.')
      return false
    }
    // verifyOtp established the session; updateUser now sets the password.
    const { error: uErr } = await supabase.auth.updateUser({ password: newPassword })
    if (uErr) {
      setError(uErr.message)
      return false
    }
    setPasswordRecovery(false)
    setInfo('Password updated — you are signed in.')
    return true
  }, [provider])

  const updatePassword = useCallback(async (newPassword: string) => {
    setError(null)
    setInfo(null)
    if (provider === 'supabase') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const supabase = _supabaseClient as any
      const { error: err } = await supabase.auth.updateUser({ password: newPassword })
      if (err) {
        setError(err.message)
        return
      }
      setPasswordRecovery(false)
      setInfo('Password updated — you are signed in.')
    } else {
      setError('Password update is only available with Supabase auth.')
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
    <AuthCtx.Provider value={{
      user, loading, provider, publicDeployment, passwordRecovery,
      signIn, signUp, signOut, sendPasswordReset, updatePassword,
      verifyRecoveryCode,
      error, info,
    }}>
      {children}
    </AuthCtx.Provider>
  )
}
