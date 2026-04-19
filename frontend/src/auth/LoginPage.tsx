import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useAuth } from './AuthContext'

type Mode = 'login' | 'register' | 'forgot' | 'reset'

export function LoginPage() {
  const {
    signIn, signUp, sendPasswordReset, updatePassword,
    error, info, publicDeployment, passwordRecovery,
  } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [mode, setMode] = useState<Mode>('login')
  const [loading, setLoading] = useState(false)

  // Self-serve sign-up is hidden on hosted deployments where signups are
  // invite-only. Self-host installs keep the toggle.
  const showSignUp = !publicDeployment

  // When the user clicks a password-recovery email, they land on
  // /auth/reset (enforced by sendPasswordReset's redirectTo). Force the
  // reset-form mode either on that path OR when Supabase does surface
  // the PASSWORD_RECOVERY event — either signal is sufficient.
  useEffect(() => {
    const onResetPath = typeof window !== 'undefined' && window.location.pathname === '/auth/reset'
    if (passwordRecovery || onResetPath) setMode('reset')
  }, [passwordRecovery])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      if (mode === 'login') {
        if (!email || !password) return
        await signIn(email, password)
      } else if (mode === 'register') {
        if (!email || !password) return
        await signUp(email, password)
      } else if (mode === 'forgot') {
        if (!email) return
        await sendPasswordReset(email)
      } else if (mode === 'reset') {
        if (!password || password !== confirmPassword) return
        await updatePassword(password)
        // After the password is set, bounce off the /auth/reset URL so
        // a page reload doesn't re-trigger the reset form.
        if (typeof window !== 'undefined' && window.location.pathname === '/auth/reset') {
          window.history.replaceState(null, '', '/')
        }
      }
    } finally {
      setLoading(false)
    }
  }

  const subtitle = {
    login: 'Sign in to your account',
    register: 'Create your account',
    forgot: 'Reset your password',
    reset: 'Set a new password',
  }[mode]

  const buttonLabel = {
    login: 'Sign in',
    register: 'Create account',
    forgot: 'Send reset link',
    reset: 'Update password',
  }[mode]

  const submitDisabled =
    loading ||
    (mode === 'login' && (!email || !password)) ||
    (mode === 'register' && (!email || !password)) ||
    (mode === 'forgot' && !email) ||
    (mode === 'reset' && (!password || password !== confirmPassword))

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4">
      <div className="w-full max-w-[380px]">
        <div className="text-center mb-8">
          <img
            src="/ficino-logo-dark.png"
            alt="Ficino"
            className="h-12 mx-auto mb-3"
          />
          <p className="text-[14px] text-text-muted">{subtitle}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {(mode === 'login' || mode === 'register' || mode === 'forgot') && (
            <div>
              <label htmlFor="login-email" className="sr-only">Email</label>
              <input
                id="login-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email"
                aria-label="Email"
                className="w-full bg-bg-hover border border-border rounded-lg px-4 py-3 text-[15px] text-text placeholder:text-text-muted outline-none focus:border-gold/40 transition-colors"
                autoComplete="email"
              />
            </div>
          )}
          {(mode === 'login' || mode === 'register' || mode === 'reset') && (
            <div>
              <label htmlFor="login-password" className="sr-only">
                {mode === 'reset' ? 'New password' : 'Password'}
              </label>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'reset' ? 'New password' : 'Password'}
                aria-label={mode === 'reset' ? 'New password' : 'Password'}
                className="w-full bg-bg-hover border border-border rounded-lg px-4 py-3 text-[15px] text-text placeholder:text-text-muted outline-none focus:border-gold/40 transition-colors"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              />
            </div>
          )}
          {mode === 'reset' && (
            <div>
              <label htmlFor="login-password-confirm" className="sr-only">Confirm new password</label>
              <input
                id="login-password-confirm"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm new password"
                aria-label="Confirm new password"
                className="w-full bg-bg-hover border border-border rounded-lg px-4 py-3 text-[15px] text-text placeholder:text-text-muted outline-none focus:border-gold/40 transition-colors"
                autoComplete="new-password"
              />
            </div>
          )}

          {error && (
            <div
              role="alert"
              aria-atomic="true"
              className="text-[13px] text-persona-skeptic bg-persona-skeptic/10 border border-persona-skeptic/20 rounded-lg px-3 py-2"
            >
              {error}
            </div>
          )}
          {info && !error && (
            <div
              role="status"
              aria-atomic="true"
              className="text-[13px] text-gold bg-gold/10 border border-gold/20 rounded-lg px-3 py-2"
            >
              {info}
            </div>
          )}

          <button
            type="submit"
            disabled={submitDisabled}
            className="w-full flex items-center justify-center gap-2 bg-gold text-bg text-[15px] font-semibold py-3 rounded-lg border-none cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            {loading && <Loader2 size={16} className="animate-spin" />}
            {buttonLabel}
          </button>
        </form>

        {/* Bottom navigation between modes. Sign-up toggle hidden on
            invite-only hosted deploys; reset mode hides all nav (the user
            only escapes it by completing the update or closing the tab). */}
        <div className="text-center mt-6 space-y-2">
          {mode === 'login' && (
            <>
              <button
                onClick={() => setMode('forgot')}
                className="text-[13px] text-gold bg-transparent border-none cursor-pointer hover:underline block mx-auto"
              >
                Forgot your password?
              </button>
              {showSignUp && (
                <button
                  onClick={() => setMode('register')}
                  className="text-[13px] text-gold bg-transparent border-none cursor-pointer hover:underline block mx-auto"
                >
                  Don't have an account? Sign up
                </button>
              )}
            </>
          )}
          {mode === 'register' && showSignUp && (
            <button
              onClick={() => setMode('login')}
              className="text-[13px] text-gold bg-transparent border-none cursor-pointer hover:underline block mx-auto"
            >
              Already have an account? Sign in
            </button>
          )}
          {mode === 'forgot' && (
            <button
              onClick={() => setMode('login')}
              className="text-[13px] text-gold bg-transparent border-none cursor-pointer hover:underline block mx-auto"
            >
              Back to sign in
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
