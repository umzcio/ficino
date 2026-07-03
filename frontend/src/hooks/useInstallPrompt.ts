import { useState, useEffect, useCallback } from 'react'
import { safeLocal } from '../lib/safeLocal'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const DISMISSED_KEY = 'ficino_install_dismissed'

export function useInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [isDismissed, setIsDismissed] = useState(() =>
    safeLocal.get(DISMISSED_KEY) === 'true'
  )

  // Detect if already installed as PWA
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true

  // Lazy-initialize from isStandalone's mount-time value instead of always
  // starting `false` and flipping it synchronously inside the effect below
  // (which the set-state-in-effect lint rule flags). `prevIsStandalone`
  // handles the render-time sync for the (very rare — display-mode doesn't
  // normally change without an app relaunch) case where isStandalone itself
  // changes later, via the same pattern as MessagesView's consumedPaperId.
  const [isInstalled, setIsInstalled] = useState(isStandalone)
  const [prevIsStandalone, setPrevIsStandalone] = useState(isStandalone)
  if (isStandalone !== prevIsStandalone) {
    setPrevIsStandalone(isStandalone)
    if (isStandalone) setIsInstalled(true)
  }

  useEffect(() => {
    if (isStandalone) return

    const handler = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
    }

    const installedHandler = () => setIsInstalled(true)

    window.addEventListener('beforeinstallprompt', handler)
    window.addEventListener('appinstalled', installedHandler)
    return () => {
      window.removeEventListener('beforeinstallprompt', handler)
      window.removeEventListener('appinstalled', installedHandler)
    }
  }, [isStandalone])

  const install = useCallback(async () => {
    if (!deferredPrompt) return
    await deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice
    if (outcome === 'accepted') {
      setIsInstalled(true)
    }
    setDeferredPrompt(null)
  }, [deferredPrompt])

  const dismiss = useCallback(() => {
    setIsDismissed(true)
    safeLocal.set(DISMISSED_KEY, 'true')
  }, [])

  const isIOS = /iPhone|iPad/.test(navigator.userAgent) && !isStandalone
  const canPrompt = !!deferredPrompt
  const showPrompt = (canPrompt || isIOS) && !isInstalled && !isDismissed

  return { install, dismiss, showPrompt, canPrompt, isIOS, isInstalled }
}
