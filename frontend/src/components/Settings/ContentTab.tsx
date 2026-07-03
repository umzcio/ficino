import { useState } from 'react'
import { Zap, FileText, Keyboard } from 'lucide-react'
import { Section, SettingRow, Toggle, Select, Slider } from '../_shared/primitives'
import { areKeyboardShortcutsEnabled, setKeyboardShortcutsEnabled } from '../../lib/keyboardShortcutsPref'

interface Props {
  settings: Record<string, unknown>
  onUpdate: (partial: Record<string, unknown>) => void
}

export function ContentTab({ settings: s, onUpdate }: Props) {
  const postWeights = (s.post_type_weights || {}) as Record<string, number>

  // R10 FE-20: client-only a11y preference (safeLocal, not the server
  // `settings`/`onUpdate` object) — see keyboardShortcutsPref.ts for why.
  const [shortcutsEnabled, setShortcutsEnabledState] = useState(() => areKeyboardShortcutsEnabled())

  return (
    <div className="p-4 space-y-4">
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
            label="Auto-generate on Upload"
            checked={s.auto_generate_on_upload as boolean}
            onChange={(v) => onUpdate({ auto_generate_on_upload: v })}
          />
        </SettingRow>
      </Section>

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
            label="Show Extraction Badge"
            checked={s.show_extraction_badge as boolean}
            onChange={(v) => onUpdate({ show_extraction_badge: v })}
          />
        </SettingRow>
      </Section>

      <Section icon={Keyboard} title="Accessibility">
        <SettingRow
          label="Keyboard Shortcuts"
          description="Single-letter navigation shortcuts (h/e/m/b/n/.) — WCAG 2.1.4. Saved on this device only."
        >
          <Toggle
            label="Keyboard Shortcuts"
            checked={shortcutsEnabled}
            onChange={(v) => {
              setShortcutsEnabledState(v)
              setKeyboardShortcutsEnabled(v)
            }}
          />
        </SettingRow>
      </Section>
    </div>
  )
}
