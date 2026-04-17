import { useState, useEffect } from 'react'
import { Cpu, Users } from 'lucide-react'
import { getOllamaModels } from '../../lib/api'
import { usePersonas } from '../../hooks/usePersonas'
import { Section, SettingRow, Toggle, Select, Slider, ApiKeyInput, Loader2 } from './primitives'

interface Props {
  settings: Record<string, unknown>
  onUpdate: (partial: Record<string, unknown>) => void
}

export function AITab({ settings: s, onUpdate }: Props) {
  const personas = usePersonas()
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

  const personasEnabled = (s.personas_enabled || {}) as Record<string, boolean>

  return (
    <div className="p-4 space-y-4">
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

        <SettingRow label="Vision Provider" description="Which AI handles PDF vision fallback and figure descriptions">
          <Select
            value={s.vision_provider as string}
            options={[
              { value: 'ollama', label: 'Ollama (local)' },
              { value: 'api', label: 'Claude API' },
            ]}
            onChange={(v) => onUpdate({ vision_provider: v })}
          />
        </SettingRow>

        <SettingRow label="Embedding Provider" description="Which AI generates chunk embeddings">
          <Select
            value={s.embed_provider as string}
            options={[
              { value: 'ollama', label: 'Ollama (local)' },
              { value: 'voyage', label: 'Voyage AI' },
              { value: 'openai', label: 'OpenAI' },
            ]}
            onChange={(v) => onUpdate({ embed_provider: v })}
          />
        </SettingRow>

        {(s.llm_provider === 'api' || s.vision_provider === 'api') && (
          <SettingRow label="Claude Model" description="Which Claude model to use for generation and vision">
            <Select
              value={(s.claude_model as string) || 'claude-sonnet-4-6'}
              options={[
                { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (best)' },
                { value: 'claude-haiku-4-5', label: 'Haiku 4.5 (fast/cheap)' },
              ]}
              onChange={(v) => onUpdate({ claude_model: v })}
            />
          </SettingRow>
        )}

        {(s.llm_provider === 'api' || s.vision_provider === 'api') && (
          <SettingRow label="Anthropic API Key" description="Required for Claude — saves on Enter or click away">
            <ApiKeyInput
              value={(s.anthropic_api_key as string) || ''}
              placeholder="sk-ant-..."
              onSave={(v) => onUpdate({ anthropic_api_key: v })}
            />
          </SettingRow>
        )}

        {s.embed_provider === 'voyage' && (
          <SettingRow label="Voyage API Key" description="Required for Voyage embeddings — saves on Enter or click away">
            <ApiKeyInput
              value={(s.voyage_api_key as string) || ''}
              placeholder="pa-..."
              onSave={(v) => onUpdate({ voyage_api_key: v })}
            />
          </SettingRow>
        )}

        {s.embed_provider === 'openai' && (
          <SettingRow label="OpenAI API Key" description="Required for OpenAI embeddings — saves on Enter or click away">
            <ApiKeyInput
              value={(s.openai_api_key as string) || ''}
              placeholder="sk-..."
              onSave={(v) => onUpdate({ openai_api_key: v })}
            />
          </SettingRow>
        )}

        {s.llm_provider === 'ollama' && (
          <SettingRow
            label="Ollama LLM Model"
            description={loadingModels ? 'Loading models...' : `${ollamaModels.llm.length} models available`}
          >
            {loadingModels ? (
              <Loader2 size={16} className="text-gold animate-spin" />
            ) : (
              <Select
                value={s.ollama_llm_model as string}
                options={ollamaModels.llm.map((m) => ({
                  value: m.name,
                  label: `${m.name} (${m.size})`,
                }))}
                onChange={(v) => onUpdate({ ollama_llm_model: v })}
              />
            )}
          </SettingRow>
        )}

        {s.embed_provider === 'ollama' && (
          <SettingRow label="Ollama Embedding Model">
            <Select
              value={s.ollama_embed_model as string}
              options={ollamaModels.embed.map((m) => ({
                value: m.name,
                label: `${m.name} (${m.size})`,
              }))}
              onChange={(v) => onUpdate({ ollama_embed_model: v })}
            />
          </SettingRow>
        )}

        {s.vision_provider === 'ollama' && (
          <SettingRow label="Ollama Vision Model" description="Used for PDF fallback extraction and figure descriptions">
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
        )}

        <div className="text-[11px] text-persona-gradstudent bg-persona-gradstudent/8 border border-persona-gradstudent/20 rounded-lg px-3 py-2">
          {s.llm_provider === 'ollama' && s.embed_provider === 'ollama' && s.vision_provider === 'ollama'
            ? 'Using local Ollama — no API credits consumed'
            : 'Using API providers — credits will be consumed per generation'}
        </div>
      </Section>

      <Section icon={Users} title="Personas">
        {Object.entries(personas).map(([key, p]) => (
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
    </div>
  )
}
