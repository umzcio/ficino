import { FileText } from 'lucide-react'

// Shape matches FeedPost['sources'] / UserPost['sources'] (both declared
// inline in types/index.ts and lib/api.ts) — kept structural rather than
// imported so this component makes no assumption about which post type
// it's rendering for.
export interface SourceItem {
  chunk_id?: string
  paper_id?: string
  paper_title: string
  section: string
  content: string
  score: number
}

interface SourcesListProps {
  sources: SourceItem[]
  open: boolean
  onToggle: () => void
  // PostCard's toggle sits inside a clickable card row and must stop the
  // click from bubbling to the row's own onClick; UserPostCard's thread
  // turns aren't clickable rows, so their toggle passes this as false/undefined.
  stopPropagation?: boolean
  // Outer wrapper margin varies by call site (PostCard needs bottom margin
  // before the content that follows; UserPostCard's thread turn needs top
  // margin after the Md content it follows) — not part of the verbatim block.
  className?: string
}

export function SourcesList({ sources, open, onToggle, stopPropagation, className = 'mb-1' }: SourcesListProps) {
  return (
    <div className={className}>
      <button
        onClick={(e) => { if (stopPropagation) e.stopPropagation(); onToggle() }}
        className="text-[11px] text-text-muted hover:text-gold bg-transparent border-none cursor-pointer transition-colors flex items-center gap-1 px-0"
      >
        <FileText size={10} />
        {open ? 'Hide sources' : `${sources.length} sources`}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {sources.map((src, i) => (
            <div key={i} className="border border-border rounded-lg p-2.5 bg-bg text-[12px]">
              <div className="flex items-center gap-2 mb-1">
                <span className="font-semibold text-text-mid truncate">{src.paper_title}</span>
                <span className="text-text-muted shrink-0">· {src.section}</span>
                <span className="text-text-subtle shrink-0 text-[10px] ml-auto">{(src.score * 100).toFixed(0)}%</span>
              </div>
              <p className="text-text-muted leading-relaxed line-clamp-3">
                {src.content}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
