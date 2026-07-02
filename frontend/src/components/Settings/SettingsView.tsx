import { useState } from 'react'
import type { Workspace } from '../../types'
import { Spinner } from '../_shared/AsyncState'
import { SettingsTabs, type SettingsTab } from './SettingsTabs'
import { SettingsSearchToggle, SettingsSearchResults } from './SettingsSearch'
import { AccountTab } from './AccountTab'
import { AITab } from './AITab'
import { ContentTab } from './ContentTab'
import { StorageTab } from './StorageTab'

interface SettingsViewProps {
  settings: Record<string, unknown>
  loading: boolean
  onUpdate: (partial: Record<string, unknown>) => void
  workspaces?: Workspace[]
  onDownloadWorkspace?: (id: string) => void
}

export function SettingsView({ settings, loading, onUpdate, workspaces, onDownloadWorkspace }: SettingsViewProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('account')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)

  const isSearching = searchOpen && searchQuery.trim().length > 0

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner size={24} />
      </div>
    )
  }

  return (
    <div>
      <div className="sticky top-0 z-10 bg-bg/90 backdrop-blur-[12px]">
        <div className="px-4 py-3.5 flex items-center justify-between border-b border-border">
          {!searchOpen && (
            <div>
              <h2 className="text-xl font-bold text-text">Settings</h2>
              <p className="text-xs text-text-muted mt-0.5">Configure Ficino's behavior</p>
            </div>
          )}
          <SettingsSearchToggle
            query={searchQuery}
            onQueryChange={setSearchQuery}
            open={searchOpen}
            onToggle={() => { setSearchOpen(!searchOpen); setSearchQuery('') }}
          />
        </div>
        <SettingsTabs
          active={activeTab}
          onSelect={(tab) => { setActiveTab(tab); setSearchQuery(''); setSearchOpen(false) }}
          dimmed={isSearching}
        />
      </div>

      <div className="pb-20">
        {isSearching ? (
          <SettingsSearchResults
            query={searchQuery}
            onNavigate={(tab) => { setActiveTab(tab); setSearchQuery(''); setSearchOpen(false) }}
          />
        ) : (
          <div
            role="tabpanel"
            id={`settings-panel-${activeTab}`}
            aria-labelledby={`settings-tab-${activeTab}`}
            tabIndex={0}
          >
            {activeTab === 'account' && <AccountTab settings={settings} onUpdate={onUpdate} />}
            {activeTab === 'ai' && <AITab settings={settings} onUpdate={onUpdate} />}
            {activeTab === 'content' && <ContentTab settings={settings} onUpdate={onUpdate} />}
            {activeTab === 'storage' && <StorageTab settings={settings} onUpdate={onUpdate} workspaces={workspaces} onDownloadWorkspace={onDownloadWorkspace} />}
          </div>
        )}
      </div>
    </div>
  )
}
