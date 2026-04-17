import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useAuth } from './AuthContext'

export function LoginPage() {
  const { signIn, signUp, error, provider } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email || !password) return
    setLoading(true)
    try {
      if (mode === 'login') {
        await signIn(email, password)
      } else {
        await signUp(email, password)
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4">
      <div className="w-full max-w-[380px]">
        <div className="text-center mb-8">
          <h1 className="font-display text-[32px] font-semibold text-text tracking-tight">ficino</h1>
          <p className="text-[14px] text-text-muted mt-1">
            {mode === 'login' ? 'Sign in to your account' : 'Create your account'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              className="w-full bg-bg-hover border border-border rounded-lg px-4 py-3 text-[15px] text-text placeholder:text-text-muted outline-none focus:border-gold/40 transition-colors"
              autoComplete="email"
            />
          </div>
          <div>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="w-full bg-bg-hover border border-border rounded-lg px-4 py-3 text-[15px] text-text placeholder:text-text-muted outline-none focus:border-gold/40 transition-colors"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </div>

          {error && (
            <div className="text-[13px] text-persona-skeptic bg-persona-skeptic/10 border border-persona-skeptic/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !email || !password}
            className="w-full flex items-center justify-center gap-2 bg-gold text-bg text-[15px] font-semibold py-3 rounded-lg border-none cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            {loading && <Loader2 size={16} className="animate-spin" />}
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <div className="text-center mt-6">
          <button
            onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); }}
            className="text-[13px] text-gold bg-transparent border-none cursor-pointer hover:underline"
          >
            {mode === 'login' ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
          </button>
        </div>

        {provider === 'supabase' && (
          <div className="text-center mt-4 text-[11px] text-text-muted">
            Powered by Supabase Auth
          </div>
        )}
      </div>
    </div>
  )
}
