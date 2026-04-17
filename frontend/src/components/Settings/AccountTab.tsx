import { Palette, User } from 'lucide-react'
import { Section, SettingRow, Select, EditableField } from './primitives'

interface Props {
  settings: Record<string, unknown>
  onUpdate: (partial: Record<string, unknown>) => void
}

export function AccountTab({ settings: s, onUpdate }: Props) {
  const displayName = (s.user_display_name as string) || ''
  const handle = (s.user_handle as string) || ''
  const initials = displayName
    ? displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
    : 'Y'

  return (
    <div className="p-4 space-y-4">
      <Section icon={User} title="Profile">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-full bg-gold/15 flex items-center justify-center text-[16px] font-bold text-gold shrink-0">
            {initials}
          </div>
          <div className="flex-1 min-w-0 space-y-1">
            <div>
              <div className="text-[11px] text-text-muted mb-0.5">Display Name</div>
              <EditableField
                label="Display Name"
                value={displayName || 'You'}
                onSave={(v) => onUpdate({ user_display_name: v })}
              />
            </div>
            <div>
              <div className="text-[11px] text-text-muted mb-0.5">Handle</div>
              <EditableField
                label="Handle"
                value={handle || '@you'}
                prefix="@"
                onSave={(v) => onUpdate({ user_handle: v })}
              />
            </div>
          </div>
        </div>
      </Section>

      <Section icon={Palette} title="Display">
        <SettingRow label="Theme">
          <Select
            value={s.theme as string}
            options={[
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
            ]}
            onChange={(v) => onUpdate({ theme: v })}
          />
        </SettingRow>

        <SettingRow label="Font Size">
          <Select
            value={s.font_size as string}
            options={[
              { value: 'small', label: 'Small' },
              { value: 'normal', label: 'Normal' },
              { value: 'large', label: 'Large' },
            ]}
            onChange={(v) => onUpdate({ font_size: v })}
          />
        </SettingRow>

        <SettingRow label="Post Spacing">
          <Select
            value={s.post_spacing as string}
            options={[
              { value: 'compact', label: 'Compact' },
              { value: 'comfortable', label: 'Comfortable' },
            ]}
            onChange={(v) => onUpdate({ post_spacing: v })}
          />
        </SettingRow>
      </Section>
    </div>
  )
}
