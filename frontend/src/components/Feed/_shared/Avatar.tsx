import { usePersonas } from '../../../hooks/usePersonas'

// size defaults to 42 (the feed card avatar). DUP-10: UserPostCard's two
// hand-rolled archivist avatars drifted to 40px/1.5px border; visual check
// in the browser (both sit in the same "px-4 py-3.5 flex gap-3" row shape
// as PostCard's 42px avatar, so there's no layout reason for the 2px
// difference) showed no reason to keep 40 as its own size, so both callers
// now take the 42 default. The size prop (and the border-width step below
// 42) stays for any future caller that does need a smaller avatar.
export function Avatar({ persona, size = 42 }: { persona: string; size?: number }) {
  const personas = usePersonas()
  const p = personas[persona]
  if (!p) return null
  const dimension = `${size}px`
  const borderWidth = size >= 42 ? 2 : 1.5
  if (p.avatar_url) {
    return (
      <img
        src={p.avatar_url}
        alt={p.name}
        className="rounded-full shrink-0 object-cover"
        style={{ width: dimension, height: dimension, border: `${borderWidth}px solid ${p.color}50` }}
      />
    )
  }
  return (
    <div
      className="rounded-full shrink-0 flex items-center justify-center text-[13px] font-bold tracking-tight"
      style={{
        width: dimension,
        height: dimension,
        backgroundColor: p.color + '28',
        border: `${borderWidth}px solid ${p.color}50`,
        color: p.color,
      }}
    >
      {p.initials}
    </div>
  )
}
