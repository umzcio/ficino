// Block-level markdown: paragraphs, headings (#..####), horizontal rules,
// unordered/ordered lists. Inline emphasis (**bold**, *italic*, `code`,
// [text](url)) is delegated to InlineMd. Hand-rolled because the project
// has no markdown dep and our inputs are LLM output with a narrow, known
// marker set — a 60-line parser beats pulling in remark.
import type React from 'react'
import { InlineMd } from './InlineMd'

interface MdProps {
  text: string
  /** Applied to the outer wrapper <div>. Typography (font size, line-
      height, color) should live here so it cascades to paragraphs, list
      items, and headings uniformly. */
  className?: string
}

function headingLevel(line: string): number {
  const m = line.match(/^(#{1,4})\s+/)
  return m ? m[1].length : 0
}

function isHr(line: string): boolean {
  return /^(---|\*\*\*|___)\s*$/.test(line)
}

function bulletItem(line: string): string | null {
  const m = line.match(/^\s*[-*]\s+(.*)$/)
  return m ? m[1] : null
}

function orderedItem(line: string): string | null {
  const m = line.match(/^\s*\d+\.\s+(.*)$/)
  return m ? m[1] : null
}

// Split into blocks. LLM output often omits blank lines between a
// paragraph and the next `## heading` or `---` rule — relying only on
// blank-line boundaries would collapse everything into one paragraph
// block and leave block markers as literal text. Instead, recognize
// hard boundaries (blank line, heading, hr, list/non-list transition)
// inline.
function splitBlocks(text: string): string[] {
  const lines = text.split('\n')
  const blocks: string[] = []
  let current: string[] = []
  const flush = () => {
    if (current.length > 0) {
      blocks.push(current.join('\n'))
      current = []
    }
  }
  const isBlank = (l: string) => l.trim() === ''
  const isHeading = (l: string) => /^#{1,4}\s+/.test(l)
  const isHrLine = (l: string) => isHr(l.trim())
  const isListLine = (l: string) => bulletItem(l) !== null || orderedItem(l) !== null

  for (const line of lines) {
    if (isBlank(line)) { flush(); continue }
    // Headings and hrs are always standalone blocks.
    if (isHeading(line) || isHrLine(line)) {
      flush()
      blocks.push(line.trim())
      continue
    }
    // Transitioning in or out of a list also starts a new block so
    // list items don't get glued to surrounding prose.
    if (current.length > 0) {
      const prevIsList = current.every(isListLine)
      const thisIsList = isListLine(line)
      if (prevIsList !== thisIsList) flush()
    }
    current.push(line)
  }
  flush()
  return blocks.filter(b => b.trim().length > 0)
}

export function Md({ text, className }: MdProps) {
  if (!text) return null
  const normalized = text.replace(/\r\n/g, '\n').trim()
  const blocks = splitBlocks(normalized)
  const nodes: React.ReactNode[] = []

  blocks.forEach((block, bi) => {
    const lines = block.split('\n')

    // Single-line HR block.
    if (lines.length === 1 && isHr(lines[0])) {
      nodes.push(<hr key={bi} className="my-3 border-border" />)
      return
    }

    // Single-line heading block. Markdown heading levels compress into
    // h3/h4 in rendered DOM — we're inside chat bubbles and post cards,
    // not a document, so h1/h2 would be wildly out of scale.
    if (lines.length === 1) {
      const lvl = headingLevel(lines[0])
      if (lvl > 0) {
        const inner = lines[0].replace(/^#{1,4}\s+/, '')
        const cls =
          lvl <= 2
            ? 'text-[17px] font-bold mt-3 mb-1.5 first:mt-0'
            : lvl === 3
              ? 'text-[16px] font-semibold mt-2.5 mb-1 first:mt-0'
              : 'text-[15px] font-semibold mt-2 mb-1 first:mt-0'
        const Tag = lvl <= 2 ? 'h3' : lvl === 3 ? 'h4' : 'h5'
        nodes.push(
          <Tag key={bi} className={cls}>
            <InlineMd text={inner} />
          </Tag>,
        )
        return
      }
    }

    // Unordered list: every line is a bullet.
    const bulletItems = lines.map(bulletItem)
    if (bulletItems.every(x => x !== null)) {
      nodes.push(
        <ul key={bi} className="list-disc pl-5 my-1.5 first:mt-0 last:mb-0 space-y-0.5">
          {bulletItems.map((item, i) => (
            <li key={i}><InlineMd text={item!} /></li>
          ))}
        </ul>,
      )
      return
    }

    // Ordered list: every line is numbered.
    const orderedItems = lines.map(orderedItem)
    if (orderedItems.every(x => x !== null)) {
      nodes.push(
        <ol key={bi} className="list-decimal pl-5 my-1.5 first:mt-0 last:mb-0 space-y-0.5">
          {orderedItems.map((item, i) => (
            <li key={i}><InlineMd text={item!} /></li>
          ))}
        </ol>,
      )
      return
    }

    // Paragraph. Single newlines inside a block become <br>, matching
    // CommonMark "hard break on explicit line break" behavior rather
    // than the stricter "two trailing spaces" rule — LLMs don't emit
    // trailing-space breaks.
    const paraNodes: React.ReactNode[] = []
    lines.forEach((line, li) => {
      if (li > 0) paraNodes.push(<br key={`br-${li}`} />)
      paraNodes.push(<InlineMd key={`t-${li}`} text={line} />)
    })
    nodes.push(
      <p key={bi} className="my-1.5 first:mt-0 last:mb-0 break-words">
        {paraNodes}
      </p>,
    )
  })

  return <div className={className}>{nodes}</div>
}
