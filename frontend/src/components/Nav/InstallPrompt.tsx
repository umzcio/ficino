import { Download, X, Share } from 'lucide-react'
import { useInstallPrompt } from '../../hooks/useInstallPrompt'

export function InstallButton() {
  const { install, showPrompt, canPrompt } = useInstallPrompt()

  if (!showPrompt || !canPrompt) return null

  return (
    <button
      onClick={install}
      aria-label="Install Ficino"
      className="w-[46px] h-[46px] rounded-full border-none bg-transparent cursor-pointer flex items-center justify-center transition-all duration-100 hover:bg-gold/10 hover:text-gold"
      style={{ color: 'var(--color-nav-inactive)' }}
    >
      <Download size={20} strokeWidth={1.75} />
    </button>
  )
}

export function MobileInstallBanner() {
  const { install, dismiss, showPrompt, canPrompt, isIOS } = useInstallPrompt()

  if (!showPrompt) return null

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border bg-gold/5">
      <Download size={18} className="text-gold shrink-0" />
      <div className="flex-1 min-w-0">
        {canPrompt ? (
          <button
            onClick={install}
            className="text-sm text-text-primary font-medium bg-transparent border-none cursor-pointer p-0 text-left"
          >
            Install Ficino for offline access
          </button>
        ) : isIOS ? (
          <p className="text-sm text-text-primary m-0">
            Tap <Share size={14} className="inline -mt-0.5 text-gold" /> then <span className="font-medium">Add to Home Screen</span>
          </p>
        ) : null}
      </div>
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="text-text-secondary hover:text-text-primary bg-transparent border-none cursor-pointer p-1"
      >
        <X size={16} />
      </button>
    </div>
  )
}
