import { useRef } from 'react'

export type SettingsTab = 'account' | 'ai' | 'content' | 'storage'

const TABS: { key: SettingsTab; label: string }[] = [
  { key: 'account', label: 'Account' },
  { key: 'ai', label: 'AI' },
  { key: 'content', label: 'Content' },
  { key: 'storage', label: 'Storage' },
]

export function SettingsTabs({ active, onSelect, dimmed }: {
  active: SettingsTab
  onSelect: (tab: SettingsTab) => void
  dimmed?: boolean
}) {
  const tabRefs = useRef<Record<SettingsTab, HTMLButtonElement | null>>({
    account: null, ai: null, content: null, storage: null,
  })

  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const dir = e.key === 'ArrowRight' ? 1 : -1
    const nextIndex = (index + dir + TABS.length) % TABS.length
    const nextKey = TABS[nextIndex].key
    onSelect(nextKey)
    tabRefs.current[nextKey]?.focus()
  }

  return (
    <div className="flex border-b border-border" role="tablist" aria-label="Settings sections">
      {TABS.map(({ key, label }, i) => (
        <button
          key={key}
          ref={(el) => { tabRefs.current[key] = el }}
          role="tab"
          id={`settings-tab-${key}`}
          aria-selected={active === key}
          aria-controls={`settings-panel-${key}`}
          tabIndex={active === key ? 0 : -1}
          onKeyDown={(e) => handleKeyDown(e, i)}
          onClick={() => onSelect(key)}
          className="flex-1 py-3 border-none bg-transparent cursor-pointer text-[14px] transition-all duration-150"
          style={{
            color: dimmed
              ? 'var(--color-tab-inactive)'
              : active === key ? 'var(--color-tab-active)' : 'var(--color-tab-inactive)',
            fontWeight: !dimmed && active === key ? 700 : 400,
            borderBottom: !dimmed && active === key ? '2px solid var(--color-gold)' : '2px solid transparent',
            opacity: dimmed ? 0.5 : 1,
          }}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
