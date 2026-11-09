// Contains a render error to the subtree it wraps. Without a boundary, React unmounts the whole app on any render
// error, so one malformed post or view field (model output, or an old offline-cached copy) blanked the page and took
// the controls needed to recover (nav, delete, regenerate) with it. The placeholder replaces only the failing part;
// it comes back on "Try again" or as soon as `resetKey` changes (a new post object, a different view).
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'

export interface ErrorBoundaryFallbackProps {
  error: Error
  reset: () => void
}

interface ErrorBoundaryProps {
  children: ReactNode
  /** What the boundary wraps ("post", "view", ...): used in the console log and the default message. */
  label: string
  /** Any change (compared with Object.is) clears a caught error and renders the children again. */
  resetKey?: unknown
  /** 'inline' (default) is a compact card; 'page' fills the screen and also offers a reload. */
  variant?: 'inline' | 'page'
  fallback?: (props: ErrorBoundaryFallbackProps) => ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

const BUTTON =
  'bg-transparent border border-border rounded-[20px] text-gold px-4 py-1.5 cursor-pointer text-sm font-semibold hover:bg-gold/5 transition-colors'

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`Render error in ${this.props.label}:`, error, info.componentStack ?? '')
  }

  componentDidUpdate(prev: ErrorBoundaryProps) {
    if (this.state.error && !Object.is(prev.resetKey, this.props.resetKey)) this.reset()
  }

  reset = () => {
    this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const { fallback, label, variant = 'inline' } = this.props
    if (fallback) return fallback({ error, reset: this.reset })

    if (variant === 'page') {
      return (
        <div role="alert" className="min-h-screen bg-bg text-text flex flex-col items-center justify-center gap-3 px-6 text-center">
          <AlertCircle size={32} className="text-persona-skeptic" aria-hidden="true" />
          <p className="text-lg font-semibold">Something went wrong</p>
          <p className="text-sm text-text-muted max-w-[360px]">
            Part of the page failed to render. Try again, or reload the app.
          </p>
          <div className="flex gap-2 mt-2">
            <button type="button" onClick={this.reset} className={BUTTON}>Try again</button>
            <button type="button" onClick={() => window.location.reload()} className={BUTTON}>Reload</button>
          </div>
        </div>
      )
    }

    return (
      <div role="alert" className="flex items-center gap-3 px-4 py-3 border-b border-border text-text-muted">
        <AlertCircle size={18} className="shrink-0 text-persona-skeptic" aria-hidden="true" />
        <p className="text-sm flex-1">This {label} couldn&rsquo;t be displayed.</p>
        <button type="button" onClick={this.reset} className={BUTTON}>Try again</button>
      </div>
    )
  }
}
