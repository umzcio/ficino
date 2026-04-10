import { useState, useEffect } from 'react'
import {
  Cpu, Users, Zap, FileText, Palette, AlertTriangle,
  Loader2, Check, ChevronDown
} from 'lucide-react'
import { PERSONAS, type PersonaKey } from '../../types'
import { getOllamaModels, clearAllFeeds, clearAllSummaries } from '../../lib/api'

interface SettingsViewProps {
  settings: Record<string, unknown>
  loading: boolean
  onUpdate: (partial: Record<string, unknown>) => void
}

function Section({ icon: Icon, title, onReset, children }: {
  icon: typeof Cpu
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

function SettingRow({ label, description, children }: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1">
        <div className="text-[13px] text-text font-medium">{label}</div>
        {description && <div className="text-[11px] text-text-muted mt-0.5">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className="w-10 h-6 rounded-full border-none cursor-pointer transition-colors relative"
      style={{ backgroundColor: checked ? '#c8a96e' : '#1e2028' }}
    >
      <div
        className="w-4.5 h-4.5 rounded-full bg-white absolute top-[3px] transition-all"
        style={{ left: checked ? '20px' : '3px', width: 18, height: 18 }}
      />
    </button>
  )
}

function Select({ value, options, onChange }: {
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
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

function Slider({ value, min, max, step, onChange, label }: {
  value: number; min: number; max: number; step: number
  onChange: (v: number) => void; label?: string
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1 accent-gold h-1"
      />
      <span className="text-[13px] text-gold font-mono w-10 text-right">{label || value}</span>
    </div>
  )
}

function DangerButton({ label, onConfirm }: { label: string; onConfirm: () => void }) {
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

export function SettingsView({ settings, loading, onUpdate }: SettingsViewProps) {
  const [ollamaModels, setOllamaModels] = useState<{
    llm: { name: string; size: string; family: string }[]
    embed: { name: string; size: string }[]
    vision: { name: string; size: string }[]
  }>({ llm: [], embed: [], vision: [] })
  const [loadingModels, setLoadingModels] = useState(false)

  useEffect(() => {
    setLoadingModels(true)
    getOllamaModels()
      .then(setOllamaModels)
      .catch(() => {})
      .finally(() => setLoadingModels(false))
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={24} className="text-gold animate-spin" />
      </div>
    )
  }

  const s = settings
  const personasEnabled = (s.personas_enabled || {}) as Record<string, boolean>
  const postWeights = (s.post_type_weights || {}) as Record<string, number>

  return (
    <div>
      <div className="sticky top-0 z-10 bg-bg/90 backdrop-blur-[12px] border-b border-border px-4 py-3.5">
        <h1 className="text-xl font-bold text-text">Settings</h1>
        <p className="text-xs text-text-muted mt-0.5">Configure Ficino's behavior</p>
      </div>

      <div className="p-4 space-y-4 pb-20">

        {/* LLM Provider */}
        <Section icon={Cpu} title="LLM Provider">
          <SettingRow label="LLM Provider" description="Which AI powers persona generation">
            <Select
              value={s.llm_provider as string}
              options={[
                { value: 'ollama', label: 'Ollama (local)' },
                { value: 'api', label: 'Claude API' },
              ]}
              onChange={(v) => onUpdate({ llm_provider: v })}
            />
          </SettingRow>

          <SettingRow label="Embedding Provider" description="Which AI generates chunk embeddings">
            <Select
              value={s.embed_provider as string}
              options={[
                { value: 'ollama', label: 'Ollama (local)' },
                { value: 'api', label: 'OpenAI API' },
              ]}
              onChange={(v) => onUpdate({ embed_provider: v })}
            />
          </SettingRow>

          {s.llm_provider === 'ollama' && (
            <>
              <SettingRow
                label="LLM Model"
                description={loadingModels ? 'Loading models...' : `${ollamaModels.llm.length} models available`}
              >
                <Select
                  value={s.ollama_llm_model as string}
                  options={ollamaModels.llm.map((m) => ({
                    value: m.name,
                    label: `${m.name} (${m.size})`,
                  }))}
                  onChange={(v) => onUpdate({ ollama_llm_model: v })}
                />
              </SettingRow>

              <SettingRow label="Embedding Model">
                <Select
                  value={s.ollama_embed_model as string}
                  options={ollamaModels.embed.map((m) => ({
                    value: m.name,
                    label: `${m.name} (${m.size})`,
                  }))}
                  onChange={(v) => onUpdate({ ollama_embed_model: v })}
                />
              </SettingRow>

              <SettingRow label="Vision Model" description="Used for PDF fallback extraction and figure descriptions">
                <Select
                  value={s.ollama_vision_model as string}
                  options={[
                    { value: '', label: 'None' },
                    ...ollamaModels.vision.map((m) => ({
                      value: m.name,
                      label: `${m.name} (${m.size})`,
                    })),
                  ]}
                  onChange={(v) => onUpdate({ ollama_vision_model: v })}
                />
              </SettingRow>
            </>
          )}

          <div className="text-[11px] text-persona-gradstudent bg-persona-gradstudent/8 border border-persona-gradstudent/20 rounded-lg px-3 py-2">
            {s.llm_provider === 'ollama'
              ? 'Using local Ollama — no API credits consumed'
              : 'Using API providers — credits will be consumed per generation'}
          </div>
        </Section>

        {/* Persona Controls */}
        <Section icon={Users} title="Personas">
          {(Object.entries(PERSONAS) as [PersonaKey, typeof PERSONAS[PersonaKey]][]).map(([key, p]) => (
            <SettingRow key={key} label={p.name} description={p.handle}>
              <Toggle
                checked={personasEnabled[key] !== false}
                onChange={(v) => onUpdate({
                  personas_enabled: { ...personasEnabled, [key]: v },
                })}
              />
            </SettingRow>
          ))}

          <SettingRow label="Persona Temperature" description="Higher = more creative/provocative">
            <Slider
              value={s.persona_temperature as number}
              min={0.1}
              max={1.5}
              step={0.1}
              onChange={(v) => onUpdate({ persona_temperature: v })}
            />
          </SettingRow>
        </Section>

        {/* Feed Preferences */}
        <Section icon={Zap} title="Feed Generation" onReset={() => onUpdate({
          posts_per_generation: 12,
          post_type_weights: { post: 0.35, thread: 0.10, quote: 0.20, reply: 0.25, figure: 0.10 },
          auto_generate_on_upload: false,
        })}>
          <SettingRow label="Posts per Generation" description="How many posts to generate each time">
            <Slider
              value={s.posts_per_generation as number}
              min={4}
              max={24}
              step={2}
              onChange={(v) => onUpdate({ posts_per_generation: v })}
            />
          </SettingRow>

          <div className="text-[12px] text-text-muted font-medium mb-1">Post Type Weights</div>
          {[
            { key: 'post', label: 'Posts' },
            { key: 'thread', label: 'Threads' },
            { key: 'quote', label: 'Quotes' },
            { key: 'reply', label: 'Replies' },
            { key: 'figure', label: 'Figures' },
          ].map(({ key, label }) => (
            <SettingRow key={key} label={label}>
              <Slider
                value={postWeights[key] ?? 0.2}
                min={0}
                max={1}
                step={0.05}
                onChange={(v) => onUpdate({
                  post_type_weights: { ...postWeights, [key]: v },
                })}
                label={`${Math.round((postWeights[key] ?? 0.2) * 100)}%`}
              />
            </SettingRow>
          ))}

          <SettingRow label="Auto-generate on Upload" description="Generate feed when a new paper finishes processing">
            <Toggle
              checked={s.auto_generate_on_upload as boolean}
              onChange={(v) => onUpdate({ auto_generate_on_upload: v })}
            />
          </SettingRow>
        </Section>

        {/* Paper Processing */}
        <Section icon={FileText} title="Paper Processing" onReset={() => onUpdate({
          extraction_mode: 'auto',
          chunk_max_tokens: 800,
          show_extraction_badge: true,
        })}>
          <SettingRow label="Extraction Mode" description="How PDFs are converted to text">
            <Select
              value={s.extraction_mode as string}
              options={[
                { value: 'auto', label: 'Auto (smart fallback)' },
                { value: 'pymupdf', label: 'PyMuPDF only' },
                { value: 'vision', label: 'Vision only' },
              ]}
              onChange={(v) => onUpdate({ extraction_mode: v })}
            />
          </SettingRow>

          <SettingRow label="Chunk Size" description="Max tokens per chunk (affects retrieval granularity)">
            <Slider
              value={s.chunk_max_tokens as number}
              min={200}
              max={1600}
              step={100}
              onChange={(v) => onUpdate({ chunk_max_tokens: v })}
            />
          </SettingRow>

          <SettingRow label="Show Extraction Badge" description="Display extraction path (pymupdf/vision) in corpus panel">
            <Toggle
              checked={s.show_extraction_badge as boolean}
              onChange={(v) => onUpdate({ show_extraction_badge: v })}
            />
          </SettingRow>
        </Section>

        {/* Display */}
        <Section icon={Palette} title="Display">
          <SettingRow label="Theme">
            <Select
              value={s.theme as string}
              options={[
                { value: 'dark', label: 'Dark' },
                { value: 'light', label: 'Light (coming soon)' },
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

        {/* Danger Zone */}
        <Section icon={AlertTriangle} title="Danger Zone">
          <SettingRow label="Clear All Feeds" description="Delete all generated feeds. Bookmarks are preserved.">
            <DangerButton label="Clear Feeds" onConfirm={clearAllFeeds} />
          </SettingRow>

          <SettingRow label="Clear All Summaries" description="Delete all paper summaries. They will regenerate on next view.">
            <DangerButton label="Clear Summaries" onConfirm={clearAllSummaries} />
          </SettingRow>
        </Section>

      </div>
    </div>
  )
}
