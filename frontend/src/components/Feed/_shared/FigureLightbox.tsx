import { useRef, useEffect } from 'react'
import { X } from 'lucide-react'
import { useFocusTrap } from '../../../hooks/useFocusTrap'

export function FigureLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(true, ref)

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  // Split backdrop from dialog: a click-to-dismiss handler on the dialog
  // element itself double-fires on Enter/Space for the close button and
  // muddles the ARIA semantics. The backdrop is a separate aria-hidden
  // element that only handles the dismissal; the dialog uses aria-labelledby
  // on the figure caption for a meaningful accessible name.
  return (
    <>
      <div
        aria-hidden="true"
        className="fixed inset-0 z-40 bg-black/85"
        onClick={onClose}
      />
      <div
        ref={ref}
        className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lightbox-caption"
      >
        <h2 id="lightbox-caption" className="sr-only">{alt || 'Extracted figure'}</h2>
        <button
          onClick={onClose}
          aria-label="Close lightbox"
          className="absolute top-4 right-4 w-10 h-10 rounded-full bg-bg/80 border border-border flex items-center justify-center cursor-pointer hover:bg-bg transition-colors pointer-events-auto"
        >
          <X size={20} className="text-text" />
        </button>
        <img
          src={src}
          alt={alt}
          className="max-w-full max-h-[90vh] object-contain rounded-lg pointer-events-auto"
        />
      </div>
    </>
  )
}
