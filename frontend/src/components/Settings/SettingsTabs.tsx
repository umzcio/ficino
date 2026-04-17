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
  return (
    <div className="flex border-b border-border" role="tablist">
      {TABS.map(({ key, label }) => (
        <button
          key={key}
          role="tab"
          aria-selected={active === key}
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
