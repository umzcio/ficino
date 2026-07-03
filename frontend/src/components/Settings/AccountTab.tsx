import { useEffect, useState } from 'react'
import { LogOut, Palette, User, Activity } from 'lucide-react'
import { Section, SettingRow, Select, EditableField } from '../_shared/primitives'
import { Spinner, EmptyState } from '../_shared/AsyncState'
import { useAuth } from '../../auth/AuthContext'
import { getMe, listAuditLog, type UserProfile, type AuditLogEntry } from '../../lib/api'
import { timeAgo } from '../../lib/timeAgo'

interface Props {
  settings: Record<string, unknown>
  onUpdate: (partial: Record<string, unknown>) => void
}

// AccountTab's own "last ~20 rows" display size — independent of the
// server's separate [1, 500] clamp on the same query param.
const AUDIT_LOG_LIMIT = 20

export function AccountTab({ settings: s, onUpdate }: Props) {
  const { user, provider, signOut } = useAuth()
  const displayName = (s.user_display_name as string) || ''
  const handle = (s.user_handle as string) || ''
  const initials = displayName
    ? displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
    : 'Y'
  // Show the sign-out surface whenever there's a real auth provider. Under
  // AUTH_PROVIDER=none there's no session to end and the stub user has no
  // meaningful identity to log out from.
  const canSignOut = provider !== 'none'

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([])
  const [auditLoading, setAuditLoading] = useState(true)
  const [auditError, setAuditError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    async function load() {
      setAuditLoading(true)
      setAuditError(null)
      try {
        const [me, log] = await Promise.all([getMe(), listAuditLog(AUDIT_LOG_LIMIT)])
        if (!active) return
        setProfile(me)
        setAuditLog(log)
      } catch (err) {
        if (active) setAuditError(err instanceof Error ? err.message : 'Failed to load account activity')
      } finally {
        if (active) setAuditLoading(false)
      }
    }
    load()
    return () => { active = false }
  }, [])

  // /users/me's display_name is the server's own record; the settings-backed
  // field above is a separate client preference (Settings tab, not auth
  // profile). This is deliberately NOT a second editor — just a read-only
  // reconciliation hint, and only shown when the two have actually drifted.
  const serverNameDiffers = !!profile?.display_name && profile.display_name !== displayName

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
              {serverNameDiffers && (
                <div className="text-[11px] text-text-muted mt-1">
                  Server profile name on file: {profile!.display_name}
                </div>
              )}
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

      <Section icon={Activity} title="Recent Account Activity">
        {auditLoading ? (
          <div className="flex justify-center py-6">
            <Spinner size={20} />
          </div>
        ) : auditError ? (
          <div role="alert" className="text-[12px] text-persona-skeptic py-2">
            {auditError}
          </div>
        ) : auditLog.length === 0 ? (
          <EmptyState
            icon={Activity}
            title="No activity yet"
            hint={<p className="text-sm">Actions you take will show up here.</p>}
          />
        ) : (
          <ul className="space-y-1.5">
            {auditLog.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-3 text-[13px]">
                <span className="text-text truncate">
                  {entry.action} <span className="text-text-muted">· {entry.resource_type}</span>
                </span>
                <span className="text-[11px] text-text-muted shrink-0">{timeAgo(entry.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {canSignOut && (
        <Section icon={LogOut} title="Session">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-text truncate">
                {user?.email || 'Signed in'}
              </div>
              <div className="text-[11px] text-text-muted mt-0.5">
                Sign out of this device. You can sign back in with the same email.
              </div>
            </div>
            <button
              onClick={() => signOut()}
              className="shrink-0 px-3 py-1.5 rounded-md border border-border bg-bg-hover text-[13px] text-text hover:bg-persona-skeptic/10 hover:border-persona-skeptic/40 hover:text-persona-skeptic transition-colors cursor-pointer"
            >
              Sign out
            </button>
          </div>
        </Section>
      )}
    </div>
  )
}
