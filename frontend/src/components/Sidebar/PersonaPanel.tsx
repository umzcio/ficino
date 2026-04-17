import { usePersonas } from '../../hooks/usePersonas'

interface PersonaPanelProps {
  enabledPersonas: Record<string, boolean>
  onPersonaClick?: (key: string) => void
}

export function PersonaPanel({ enabledPersonas, onPersonaClick }: PersonaPanelProps) {
  const personas = usePersonas()
  const entries = Object.entries(personas)
    .filter(([key]) => key !== 'archivist' && enabledPersonas[key] !== false)

  return (
    <div className="bg-bg-hover border border-border rounded-2xl p-4">
      <div className="text-[13px] font-bold text-gold tracking-widest uppercase mb-3">
        Personas ({entries.length})
      </div>
      {entries.map(([key, p]) => (
        <button
          key={key}
          type="button"
          role="menuitem"
          aria-label={p.name}
          onClick={() => onPersonaClick?.(key)}
          className="w-full text-left flex items-center gap-2.5 py-1.5 cursor-pointer hover:bg-bg rounded-lg px-1 -mx-1 transition-colors border-none bg-transparent"
        >
          {p.avatar_url ? (
            <img src={p.avatar_url} alt={p.name} className="w-8 h-8 rounded-full shrink-0 object-cover" style={{ border: `1.5px solid ${p.color}50` }} />
          ) : (
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0"
              style={{ backgroundColor: p.color + '22', border: `1.5px solid ${p.color}50`, color: p.color }}
            >
              {p.initials}
            </div>
          )}
          <div>
            <div className="text-[13px] text-text font-semibold">{p.name}</div>
            <div className="text-xs text-text-muted">{p.handle}</div>
          </div>
        </button>
      ))}
      {entries.length === 0 && (
        <p className="text-xs text-text-muted py-2 text-center">All personas disabled</p>
      )}
    </div>
  )
}
