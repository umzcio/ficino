import { usePersonas } from '../../hooks/usePersonas'

interface PersonaPanelProps {
  enabledPersonas: Record<string, boolean>
}

export function PersonaPanel({ enabledPersonas }: PersonaPanelProps) {
  const personas = usePersonas()
  const entries = Object.entries(personas)
    .filter(([key]) => enabledPersonas[key] !== false)

  return (
    <div className="bg-bg-hover border border-border rounded-2xl p-4">
      <div className="text-[13px] font-bold text-gold tracking-widest uppercase mb-3">
        Personas ({entries.length})
      </div>
      {entries.map(([key, p]) => (
        <div key={key} className="flex items-center gap-2.5 py-1.5">
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0"
            style={{
              backgroundColor: p.color + '22',
              border: `1.5px solid ${p.color}50`,
              color: p.color,
            }}
          >
            {p.initials}
          </div>
          <div>
            <div className="text-[13px] text-text font-semibold">{p.name}</div>
            <div className="text-xs text-text-muted">{p.handle}</div>
          </div>
        </div>
      ))}
      {entries.length === 0 && (
        <p className="text-xs text-text-muted py-2 text-center">All personas disabled</p>
      )}
    </div>
  )
}
