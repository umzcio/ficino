import { usePersonas } from '../../../hooks/usePersonas'

export function Avatar({ persona }: { persona: string }) {
  const personas = usePersonas()
  const p = personas[persona]
  if (!p) return null
  if (p.avatar_url) {
    return (
      <img
        src={p.avatar_url}
        alt={p.name}
        className="w-[42px] h-[42px] rounded-full shrink-0 object-cover"
        style={{ border: `2px solid ${p.color}50` }}
      />
    )
  }
  return (
    <div
      className="w-[42px] h-[42px] rounded-full shrink-0 flex items-center justify-center text-[13px] font-bold tracking-tight"
      style={{
        backgroundColor: p.color + '28',
        border: `2px solid ${p.color}50`,
        color: p.color,
      }}
    >
      {p.initials}
    </div>
  )
}
