import { useRef, useEffect } from 'react'
import { Search, X } from 'lucide-react'
import type { SettingsTab } from './SettingsTabs'

interface SettingEntry {
  tab: SettingsTab
  label: string
  terms: string
}

const REGISTRY: SettingEntry[] = [
  { tab: 'account', label: 'Display Name', terms: 'display name profile username identity' },
  { tab: 'account', label: 'Handle', terms: 'handle username @ mention profile' },
  { tab: 'account', label: 'Theme', terms: 'theme dark light mode appearance' },
  { tab: 'account', label: 'Font Size', terms: 'font size text small normal large' },
  { tab: 'account', label: 'Post Spacing', terms: 'post spacing compact comfortable density' },
  { tab: 'ai', label: 'LLM Provider', terms: 'llm provider ollama claude api model' },
  { tab: 'ai', label: 'Vision Provider', terms: 'vision provider ollama claude pdf extraction' },
  { tab: 'ai', label: 'Embedding Provider', terms: 'embedding provider ollama voyage openai' },
  { tab: 'ai', label: 'Claude Model', terms: 'claude model sonnet haiku anthropic' },
  { tab: 'ai', label: 'Anthropic API Key', terms: 'anthropic api key claude secret' },
  { tab: 'ai', label: 'Voyage API Key', terms: 'voyage api key embedding' },
  { tab: 'ai', label: 'OpenAI API Key', terms: 'openai api key embedding' },
  { tab: 'ai', label: 'Ollama Models', terms: 'ollama model llm embedding vision local' },
  { tab: 'ai', label: 'Persona Temperature', terms: 'persona temperature creative provocative' },
  { tab: 'ai', label: 'Enable/Disable Personas', terms: 'persona enable disable toggle skeptic hype practitioner stats grad archivist' },
  { tab: 'content', label: 'Posts per Generation', terms: 'posts per generation count number' },
  { tab: 'content', label: 'Post Type Weights', terms: 'post type weights thread quote reply figure mix' },
  { tab: 'content', label: 'Auto-generate on Upload', terms: 'auto generate upload automatic' },
  { tab: 'content', label: 'Extraction Mode', terms: 'extraction mode pymupdf vision auto pdf' },
  { tab: 'content', label: 'Chunk Size', terms: 'chunk size tokens retrieval granularity' },
  { tab: 'content', label: 'Extraction Badge', terms: 'extraction badge display show' },
  { tab: 'storage', label: 'Cache Size', terms: 'cache size storage offline' },
  { tab: 'storage', label: 'Download Workspace', terms: 'download workspace offline sync' },
  { tab: 'storage', label: 'Clear Offline Data', terms: 'clear offline data cache indexeddb' },
  { tab: 'storage', label: 'Clear All Feeds', terms: 'clear feeds delete danger' },
  { tab: 'storage', label: 'Clear All Summaries', terms: 'clear summaries delete danger' },
  { tab: 'storage', label: 'Clear All Conversations', terms: 'clear conversations user posts archivist messages delete danger' },
  { tab: 'storage', label: 'Delete All Papers', terms: 'delete papers corpus reset wipe start over chunks figures danger destructive' },
  { tab: 'storage', label: 'Delete Everything', terms: 'delete everything reset factory clean nuke notifications alerts danger destructive start over' },
]

const TAB_LABELS: Record<SettingsTab, string> = {
  account: 'Account',
  ai: 'AI',
  content: 'Content',
  storage: 'Storage',
}

export function SettingsSearchToggle({ query, onQueryChange, open, onToggle }: {
  query: string
  onQueryChange: (q: string) => void
  open: boolean
  onToggle: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  if (!open) {
    return (
      <button
        onClick={onToggle}
        aria-label="Search settings"
        className="w-8 h-8 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer text-text-muted hover:text-gold transition-colors"
      >
        <Search size={16} />
      </button>
    )
  }

  return (
    <div className="flex items-center gap-2 flex-1 ml-3">
      <Search size={14} className="text-text-muted shrink-0" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search settings..."
        className="flex-1 bg-transparent border-none text-[13px] text-text outline-none placeholder:text-text-muted"
      />
      <button
        onClick={() => { onQueryChange(''); onToggle() }}
        aria-label="Close search"
        className="w-6 h-6 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer text-text-muted hover:text-text transition-colors"
      >
        <X size={14} />
      </button>
    </div>
  )
}

export function SettingsSearchResults({ query, onNavigate }: {
  query: string
  onNavigate: (tab: SettingsTab) => void
}) {
  const q = query.toLowerCase().trim()
  if (!q) return null

  const matches = REGISTRY.filter(e => e.terms.includes(q) || e.label.toLowerCase().includes(q))

  if (matches.length === 0) {
    return (
      <div className="p-4 text-center text-sm text-text-muted py-12">
        No settings match "{query}"
      </div>
    )
  }

  const grouped = new Map<SettingsTab, SettingEntry[]>()
  for (const m of matches) {
    if (!grouped.has(m.tab)) grouped.set(m.tab, [])
    grouped.get(m.tab)!.push(m)
  }

  return (
    <div className="p-4 space-y-4">
      {[...grouped.entries()].map(([tab, entries]) => (
        <div key={tab}>
          <div className="text-[11px] text-text-muted font-semibold tracking-wider uppercase mb-2">
            {TAB_LABELS[tab]}
          </div>
          <div className="space-y-1">
            {entries.map((entry) => (
              <button
                key={entry.label}
                onClick={() => onNavigate(tab)}
                className="w-full text-left px-3 py-2.5 rounded-xl bg-transparent border border-border hover:border-gold/30 hover:bg-gold/5 cursor-pointer transition-colors flex items-center justify-between"
              >
                <span className="text-[13px] text-text">{entry.label}</span>
                <span className="text-[11px] text-text-muted">Go to {TAB_LABELS[tab]} &rarr;</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
