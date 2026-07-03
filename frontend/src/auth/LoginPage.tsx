import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Turnstile, type TurnstileInstance } from '@marsidev/react-turnstile'
import { useAuth } from './AuthContext'
import { useKeyboardAwarePage } from '../hooks/useKeyboardAwareInput'

// Supabase → Auth → Attack Protection → Captcha, when enabled, requires
// every sign-in / sign-up / reset / verifyOtp call to include a
// captchaToken. The site key is public (safe to bake into the frontend
// bundle); the secret lives on Supabase. If unset, the widget silently
// no-ops so self-host installs without Turnstile still work.
const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined

// `verify-code` is the UM-friendly recovery path: the email contains a
// 6-digit token (template shows {{ .Token }}), and the user types it in
// alongside a new password. This sidesteps corporate link scanners
// (Microsoft ATP Safe Links, Google pre-fetch) that burn single-use
// reset tokens before the recipient clicks.
// `verify-signup` and `invite` are the same pattern for the Confirm
// Signup and Invite User email templates — same Safe-Links-survives
// motivation, different Supabase verifyOtp type.
type Mode = 'login' | 'register' | 'forgot' | 'verify-code' | 'verify-signup' | 'invite' | 'reset'

export function LoginPage() {
  const {
    signIn, signUp, sendPasswordReset, updatePassword,
    verifyRecoveryCode, verifySignupCode, verifyInviteCode,
    error, info, publicDeployment, passwordRecovery,
  } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [code, setCode] = useState('')
  const [mode, setMode] = useState<Mode>('login')
  const [loading, setLoading] = useState(false)
  // Set only when a call below throws instead of resolving — i.e. the
  // failure happened before any HTTP response existed (offline, DNS
  // failure, CORS misconfig). AuthContext's methods already setError(...)
  // internally for anything that got a real HTTP response (bad credentials,
  // 500, etc), so this is strictly the "never reached the server" case.
  const [networkError, setNetworkError] = useState<string | null>(null)
  const [captchaToken, setCaptchaToken] = useState('')
  const turnstileRef = useRef<TurnstileInstance>(null)

  const showSignUp = !publicDeployment
  // Scrolls whichever input is focused into view when the mobile
  // keyboard opens. Document-level variant because this form swaps
  // inputs based on mode and managing per-input refs would be awkward.
  useKeyboardAwarePage()
  const captchaEnabled = Boolean(TURNSTILE_SITE_KEY)
  // Modes that hit Supabase's captcha-protected endpoints. The final
  // updatePassword call in 'reset' mode uses an already-elevated session,
  // so it doesn't need a fresh Turnstile token.
  const modeNeedsCaptcha = mode === 'login' || mode === 'register' || mode === 'forgot' || mode === 'verify-code' || mode === 'verify-signup' || mode === 'invite'
  const haveCaptcha = !captchaEnabled || !modeNeedsCaptcha || captchaToken.length > 0

  // Reset the Turnstile widget after a token is consumed so the next
  // submission gets a fresh one (tokens are single-use).
  const resetCaptcha = () => {
    try { turnstileRef.current?.reset() } catch { /* widget not yet mounted */ }
    setCaptchaToken('')
  }

  // If the user DID successfully click a link (non-corporate inbox), they
  // land on /auth/reset and we show the simpler set-new-password form.
  useEffect(() => {
    const onResetPath = typeof window !== 'undefined' && window.location.pathname === '/auth/reset'
    if (passwordRecovery || onResetPath) setMode('reset')
  }, [passwordRecovery])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setNetworkError(null)
    try {
      if (mode === 'login') {
        if (!email || !password) return
        await signIn(email, password, captchaToken || undefined)
        resetCaptcha()
      } else if (mode === 'register') {
        if (!email || !password) return
        const { needsConfirmation } = await signUp(email, password, captchaToken || undefined)
        resetCaptcha()
        // Supabase returned a user but no session → email confirmation is
        // required. Advance to the OTP-code screen so the user can type
        // the code from the confirmation email. If session came back,
        // onAuthStateChange has already logged the user in.
        if (needsConfirmation) {
          setMode('verify-signup')
          setPassword('')
          setConfirmPassword('')
        }
      } else if (mode === 'verify-signup') {
        if (!email || !code) return
        const ok = await verifySignupCode(email, code, captchaToken || undefined)
        resetCaptcha()
        if (ok) {
          setCode('')
        }
      } else if (mode === 'invite') {
        if (!email || !code || !password || password !== confirmPassword) return
        const ok = await verifyInviteCode(email, code, password, captchaToken || undefined)
        resetCaptcha()
        if (ok) {
          setCode('')
          setPassword('')
          setConfirmPassword('')
        }
      } else if (mode === 'forgot') {
        if (!email) return
        await sendPasswordReset(email, captchaToken || undefined)
        resetCaptcha()
        // Advance to the code-entry step regardless of link vs OTP — the
        // email carries both; whichever the user actually uses works.
        setMode('verify-code')
      } else if (mode === 'verify-code') {
        if (!email || !code || !password || password !== confirmPassword) return
        const ok = await verifyRecoveryCode(email, code, password, captchaToken || undefined)
        resetCaptcha()
        if (ok) {
          // Session is now live, clear the path if we somehow have one,
          // and drop the form locals so a refresh starts clean.
          if (typeof window !== 'undefined' && window.location.pathname === '/auth/reset') {
            window.history.replaceState(null, '', '/')
          }
          setCode('')
          setPassword('')
          setConfirmPassword('')
        }
      } else if (mode === 'reset') {
        if (!password || password !== confirmPassword) return
        await updatePassword(password)
        if (typeof window !== 'undefined' && window.location.pathname === '/auth/reset') {
          window.history.replaceState(null, '', '/')
        }
      }
    } catch (err) {
      // FE-19: a network-level failure (fetch() rejecting before any HTTP
      // response — offline, DNS failure, CORS misconfig) propagates out of
      // signIn/signUp rather than being swallowed like an HTTP error
      // response is. Route it to the same error-banner slot.
      console.error('Auth request failed:', err)
      setNetworkError('Network error — check your connection.')
    } finally {
      setLoading(false)
    }
  }

  const subtitle = {
    login: 'Sign in to your account',
    register: 'Create your account',
    forgot: 'Reset your password',
    'verify-code': 'Enter the code from your email',
    'verify-signup': 'Confirm your email',
    invite: 'Accept your invite',
    reset: 'Set a new password',
  }[mode]

  const buttonLabel = {
    login: 'Sign in',
    register: 'Create account',
    forgot: 'Send reset code',
    'verify-code': 'Update password',
    'verify-signup': 'Confirm email',
    invite: 'Accept invite',
    reset: 'Update password',
  }[mode]

  const submitDisabled =
    loading ||
    !haveCaptcha ||
    (mode === 'login' && (!email || !password)) ||
    (mode === 'register' && (!email || !password)) ||
    (mode === 'forgot' && !email) ||
    (mode === 'verify-code' && (!code || !password || password !== confirmPassword)) ||
    (mode === 'verify-signup' && (!email || !code)) ||
    (mode === 'invite' && (!email || !code || !password || password !== confirmPassword)) ||
    (mode === 'reset' && (!password || password !== confirmPassword))

  const showEmailField = mode === 'login' || mode === 'register' || mode === 'forgot' || mode === 'invite'
  const showEmailReadonly = mode === 'verify-code' || mode === 'verify-signup'
  const showCodeField = mode === 'verify-code' || mode === 'verify-signup' || mode === 'invite'
  const showPasswordField = mode === 'login' || mode === 'register' || mode === 'verify-code' || mode === 'invite' || mode === 'reset'
  const showConfirmField = mode === 'verify-code' || mode === 'invite' || mode === 'reset'

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4">
      <div className="w-full max-w-[380px]">
        <div className="text-center mb-8">
          <img
            src={`${import.meta.env.BASE_URL}ficino-logo-dark.png`}
            alt="Ficino"
            className="h-12 mx-auto mb-3"
          />
          <p className="text-[14px] text-text-muted">{subtitle}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {showEmailField && (
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
          {showEmailReadonly && (
            <div className="text-[13px] text-text-muted px-1">
              Code sent to <span className="text-text">{email}</span>
            </div>
          )}
          {showCodeField && (
            <div>
              <label htmlFor="login-code" className="sr-only">Code from email</label>
              <input
                id="login-code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="Code from email"
                aria-label="Code from email"
                // No maxLength: Supabase's recovery OTP length is project-
                // configurable (6, 8, 10). Capping at 6 silently truncates
                // longer tokens and the verifyOtp call 403s as expired.
                className="w-full bg-bg-hover border border-border rounded-lg px-4 py-3 text-[18px] tracking-[0.4em] text-center text-text placeholder:text-text-muted placeholder:tracking-normal placeholder:text-[15px] outline-none focus:border-gold/40 transition-colors"
                autoComplete="one-time-code"
              />
            </div>
          )}
          {showPasswordField && (() => {
            const isNewPwMode = mode === 'verify-code' || mode === 'invite' || mode === 'reset'
            const label = isNewPwMode ? 'New password' : 'Password'
            return (
              <div>
                <label htmlFor="login-password" className="sr-only">{label}</label>
                <input
                  id="login-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={label}
                  aria-label={label}
                  className="w-full bg-bg-hover border border-border rounded-lg px-4 py-3 text-[15px] text-text placeholder:text-text-muted outline-none focus:border-gold/40 transition-colors"
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                />
              </div>
            )
          })()}
          {showConfirmField && (
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

          {captchaEnabled && modeNeedsCaptcha && (
            <div className="flex justify-center">
              <Turnstile
                ref={turnstileRef}
                siteKey={TURNSTILE_SITE_KEY!}
                onSuccess={(token: string) => setCaptchaToken(token)}
                onError={() => setCaptchaToken('')}
                onExpire={() => setCaptchaToken('')}
                options={{ theme: 'dark' }}
              />
            </div>
          )}

          {(error || networkError) && (
            <div
              role="alert"
              aria-atomic="true"
              className="text-[13px] text-persona-skeptic bg-persona-skeptic/10 border border-persona-skeptic/20 rounded-lg px-3 py-2"
            >
              {error || networkError}
            </div>
          )}
          {info && !error && !networkError && (
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
              <button
                onClick={() => { setMode('invite'); setCode(''); setPassword(''); setConfirmPassword(''); }}
                className="text-[13px] text-gold bg-transparent border-none cursor-pointer hover:underline block mx-auto"
              >
                Have an invite code?
              </button>
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
          {mode === 'verify-code' && (
            <button
              onClick={() => { setMode('forgot'); setCode(''); }}
              className="text-[13px] text-gold bg-transparent border-none cursor-pointer hover:underline block mx-auto"
            >
              Didn't get a code? Send another
            </button>
          )}
          {mode === 'verify-signup' && (
            <button
              onClick={() => { setMode('register'); setCode(''); }}
              className="text-[13px] text-gold bg-transparent border-none cursor-pointer hover:underline block mx-auto"
            >
              Didn't get a code? Sign up again
            </button>
          )}
          {mode === 'invite' && (
            <button
              onClick={() => { setMode('login'); setCode(''); setPassword(''); setConfirmPassword(''); }}
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
