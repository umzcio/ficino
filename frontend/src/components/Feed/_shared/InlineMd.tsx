/** Lightweight inline markdown: **bold**, *italic*, `code`, [text](url). No block elements. */
export function InlineMd({ text }: { text: string }) {
  if (!text) return null
  const parts: React.ReactNode[] = []
  // Order matters: match bold before italic so ** doesn't get parsed as
  // two adjacent *. Links are last so they don't swallow earlier inline
  // tokens inside the link label.
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|\[([^\]]+)\]\(([^)]+)\))/g
  let last = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    if (match[2]) parts.push(<strong key={key++}>{match[2]}</strong>)
    else if (match[3]) parts.push(<em key={key++}>{match[3]}</em>)
    else if (match[4]) parts.push(<code key={key++} className="text-[13px] bg-bg-hover px-1 py-px rounded">{match[4]}</code>)
    else if (match[5] && match[6]) {
      // Allowlist URL schemes. Unknown schemes (javascript:, data:) fall
      // back to rendering as plain text so a hostile link can't execute.
      const href = match[6]
      const safe = /^(https?:|mailto:|\/|#)/i.test(href)
      if (safe) {
        parts.push(
          <a key={key++} href={href} target="_blank" rel="noopener noreferrer" className="text-gold hover:underline">
            {match[5]}
          </a>,
        )
      } else {
        parts.push(match[0])
      }
    }
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}
