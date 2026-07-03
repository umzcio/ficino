import { useState, useEffect, useId, createContext, useContext } from 'react'
import { Check, ChevronDown, Pencil, Loader2 } from 'lucide-react'

// Context that carries the row's label element id to native inputs nested
// inside the row — lets Select / Slider / ApiKeyInput wire aria-labelledby
// without each call site threading the id by hand.
const SettingRowContext = createContext<string | null>(null)

export function Section({ icon: Icon, title, onReset, children }: {
  icon: React.ComponentType<{ size?: number; className?: string }>
  title: string
  onReset?: () => void
  children: React.ReactNode
}) {
  return (
    <div className="border border-border rounded-2xl overflow-hidden">
      <div className="px-4 py-3 bg-bg-hover flex items-center gap-2.5 border-b border-border">
        <Icon size={16} className="text-gold" />
        <span className="text-sm font-bold text-text flex-1">{title}</span>
        {onReset && (
          <button
            onClick={onReset}
            className="text-[11px] text-text-muted hover:text-gold bg-transparent border border-border hover:border-gold/30 rounded-lg px-2 py-0.5 cursor-pointer transition-colors"
          >
            Reset
          </button>
        )}
      </div>
      <div className="p-4 space-y-4">
        {children}
      </div>
    </div>
  )
}

export function SettingRow({ label, description, children }: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  const labelId = useId()
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1">
        <div id={labelId} className="text-[13px] text-text font-medium">{label}</div>
        {description && <div className="text-[11px] text-text-muted mt-0.5">{description}</div>}
      </div>
      <div className="shrink-0">
        <SettingRowContext.Provider value={labelId}>
          {children}
        </SettingRowContext.Provider>
      </div>
    </div>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="w-11 h-7 rounded-full border-none cursor-pointer transition-colors relative"
      style={{ backgroundColor: checked ? 'var(--color-gold)' : 'var(--color-toggle-off)' }}
    >
      <div
        className="rounded-full bg-white absolute top-[3px] transition-all"
        style={{ left: checked ? '22px' : '3px', width: 20, height: 20 }}
      />
    </button>
  )
}

export function Select({ value, options, onChange, ariaLabel }: {
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
  ariaLabel?: string
}) {
  const labelId = useContext(SettingRowContext)
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-labelledby={labelId || undefined}
        aria-label={!labelId ? ariaLabel : undefined}
        className="appearance-none bg-bg-hover border border-border rounded-lg px-3 py-1.5 text-[13px] text-text cursor-pointer outline-none focus:border-gold/40 pr-7 min-w-[140px]"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <ChevronDown size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
    </div>
  )
}

// Accent + thumb-size lookup tables for the "custom track" rendering
// path below. Kept as literal class strings (not template-interpolated)
// so Tailwind's JIT scanner can still find them in source.
const SLIDER_ACCENT_VAR: Record<'gold' | 'muted', string> = {
  gold: 'var(--color-gold)',
  muted: 'var(--color-text-mid)',
}
const SLIDER_THUMB_COLOR_CLASSES: Record<'gold' | 'muted', string> = {
  gold: '[&::-webkit-slider-thumb]:bg-gold [&::-moz-range-thumb]:bg-gold',
  muted: '[&::-webkit-slider-thumb]:bg-text-mid [&::-moz-range-thumb]:bg-text-mid',
}
const SLIDER_THUMB_SIZE_CLASSES: Record<'sm' | 'md', string> = {
  sm: '[&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5 [&::-moz-range-thumb]:w-2.5 [&::-moz-range-thumb]:h-2.5',
  md: '[&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3',
}

export function Slider({
  value, min, max, step, onChange, label,
  ariaLabel,
  disabled = false,
  accent = 'gold',
  thumbSize = 'md',
  thumbShadow = false,
  fillPercent,
  showValue = true,
  widthClassName = 'flex-1',
}: {
  value: number; min: number; max: number; step: number
  onChange: (v: number) => void; label?: string
  /** Falls back to aria-labelledby via SettingRowContext when unset. */
  ariaLabel?: string
  disabled?: boolean
  /** 'muted' is for lower-emphasis controls (e.g. paired with an icon
   *  button) that shouldn't compete visually with gold. */
  accent?: 'gold' | 'muted'
  thumbSize?: 'sm' | 'md'
  thumbShadow?: boolean
  /**
   * Explicit 0-100 fill percentage. When provided, renders a hand-drawn
   * gradient track + custom thumb (Listen's transport sliders — the
   * gradient makes the "played" portion visible even in browsers
   * without ::-moz-range-progress support). When omitted, keeps the
   * original native accent-color rendering (Settings' usage) so that
   * call site is visually unchanged.
   */
  fillPercent?: number
  /** Trailing `label`/value text — off for sliders that already show
   *  their value elsewhere (e.g. Listen's flanking time labels). */
  showValue?: boolean
  widthClassName?: string
}) {
  const labelId = useContext(SettingRowContext)
  const customTrack = fillPercent !== undefined
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        disabled={disabled}
        aria-labelledby={labelId || undefined}
        aria-label={!labelId ? ariaLabel : undefined}
        aria-valuetext={label || String(value)}
        className={
          customTrack
            ? `${widthClassName} h-1 appearance-none rounded-full cursor-pointer disabled:cursor-default disabled:opacity-50
                [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer${thumbShadow ? ' [&::-webkit-slider-thumb]:shadow-sm' : ''}
                [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-none [&::-moz-range-thumb]:cursor-pointer
                ${SLIDER_THUMB_SIZE_CLASSES[thumbSize]} ${SLIDER_THUMB_COLOR_CLASSES[accent]}`
            : `${widthClassName} accent-gold h-1`
        }
        style={customTrack ? {
          background: `linear-gradient(to right, ${SLIDER_ACCENT_VAR[accent]} 0%, ${SLIDER_ACCENT_VAR[accent]} ${fillPercent}%, var(--color-border) ${fillPercent}%, var(--color-border) 100%)`,
        } : undefined}
      />
      {showValue && (
        <span className="text-[13px] text-gold font-mono w-10 text-right">{label || value}</span>
      )}
    </div>
  )
}

export function ApiKeyInput({ value, placeholder, onSave }: {
  value: string
  placeholder: string
  onSave: (v: string) => void
}) {
  // R10 wave-2 final review Minor 2: the API never round-trips a configured
  // secret's real value — GET /settings redacts it to the literal string
  // "set" (api/routers/settings.py `_redact`) precisely so the real key
  // never leaves the server. Treat "set" purely as a configured-marker:
  // never prefill the input with the 3-char string, show a masked
  // placeholder instead, and let typing/saving/clearing behave exactly as
  // if the field started blank.
  const isConfigured = value === 'set'
  const effectiveValue = isConfigured ? '' : (value || '')
  const [local, setLocal] = useState(effectiveValue)
  const [saved, setSaved] = useState(false)

  useEffect(() => { setLocal(effectiveValue) }, [effectiveValue])

  const doSave = () => {
    if (local !== effectiveValue) {
      onSave(local)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    }
  }

  const labelId = useContext(SettingRowContext)
  return (
    <div className="flex items-center gap-2">
      <input
        type="password"
        value={local}
        placeholder={isConfigured ? '••••••••  (configured — enter a new key to replace)' : placeholder}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={doSave}
        onKeyDown={(e) => { if (e.key === 'Enter') doSave() }}
        aria-labelledby={labelId || undefined}
        className="bg-bg border border-border rounded-lg px-3 py-1.5 text-[13px] text-text w-48 focus:border-gold outline-none"
      />
      {saved && <Check size={14} className="text-persona-gradstudent" />}
    </div>
  )
}

export function DangerButton({ label, onConfirm }: { label: string; onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [done, setDone] = useState(false)

  if (done) {
    return (
      <span className="text-[13px] text-persona-gradstudent flex items-center gap-1">
        <Check size={14} /> Done
      </span>
    )
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={async () => { await onConfirm(); setDone(true); setConfirming(false) }}
          className="px-3 py-1 rounded-lg text-xs font-semibold text-white bg-persona-skeptic border-none cursor-pointer"
        >
          Confirm
        </button>
        <button
          onClick={() => setConfirming(false)}
          className="px-3 py-1 rounded-lg text-xs text-text-muted bg-transparent border border-border cursor-pointer"
        >
          Cancel
        </button>
      </div>
    )
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      className="px-3 py-1.5 rounded-lg text-xs text-persona-skeptic bg-transparent border border-persona-skeptic/30 cursor-pointer hover:bg-persona-skeptic/10 transition-colors"
    >
      {label}
    </button>
  )
}

export function EditableField({ label, value, prefix, onSave }: {
  label: string
  value: string
  prefix?: string
  onSave: (v: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [local, setLocal] = useState(value)
  const [saved, setSaved] = useState(false)

  useEffect(() => { setLocal(value) }, [value])

  const doSave = () => {
    setEditing(false)
    let cleaned = local.trim()
    if (prefix && cleaned.startsWith(prefix)) cleaned = cleaned.slice(prefix.length)
    if (prefix === '@') cleaned = cleaned.replace(/[^a-zA-Z0-9_]/g, '')
    const final = prefix ? `${prefix}${cleaned}` : cleaned
    if (final !== value && cleaned) {
      onSave(final)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    }
  }

  if (editing) {
    return (
      <input
        type="text"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={doSave}
        onKeyDown={(e) => { if (e.key === 'Enter') doSave(); if (e.key === 'Escape') setEditing(false) }}
        autoFocus
        className="bg-bg border border-border rounded-lg px-3 py-1.5 text-[13px] text-text w-full focus:border-gold outline-none"
      />
    )
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className="flex items-center gap-1.5 bg-transparent border-none cursor-pointer p-0 group text-left"
    >
      <span className="text-[13px] text-text">{value || `Set ${label.toLowerCase()}...`}</span>
      {saved ? (
        <Check size={12} className="text-persona-gradstudent" />
      ) : (
        <Pencil size={11} className="text-text-muted opacity-0 group-hover:opacity-100 transition-opacity" />
      )}
    </button>
  )
}

export { Loader2 }
