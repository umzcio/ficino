import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './lib/pwa'
import App from './App.tsx'
import { ErrorBoundary } from './components/_shared/ErrorBoundary'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Last resort: a render error outside the per-view and per-post boundaries shows a recoverable screen
        instead of a blank page. */}
    <ErrorBoundary label="app" variant="page">
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
