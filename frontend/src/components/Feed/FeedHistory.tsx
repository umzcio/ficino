import { useState, useEffect } from 'react'
import { Clock, ChevronDown, ChevronUp } from 'lucide-react'
import { listFeedSummaries, getFeed } from '../../lib/api'
import type { Feed } from '../../types'
import { timeAgo } from '../../lib/timeAgo'

interface FeedHistoryProps {
  currentFeedId: string | null
  onLoadFeed: (feed: Feed) => void
  workspaceId?: string
}

export function FeedHistory({ currentFeedId, onLoadFeed, workspaceId }: FeedHistoryProps) {
  const [feeds, setFeeds] = useState<Feed[]>([])
  const [expanded, setExpanded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    // Metadata-only listing — full posts are fetched via getFeed() when
    // the user actually clicks a past feed below.
    listFeedSummaries(workspaceId).then(setFeeds).catch(() => {})
  }, [currentFeedId, workspaceId]) // refresh when a new feed is generated or workspace changes

  const pastFeeds = feeds.filter((f) => (f.post_count ?? 0) > 0)

  if (pastFeeds.length <= 1) return null

  return (
    <div className="border-b border-border">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-2 flex items-center justify-between bg-transparent border-none cursor-pointer text-text-muted hover:text-gold transition-colors"
      >
        <div className="flex items-center gap-2 text-[13px]">
          <Clock size={13} />
          <span>{pastFeeds.length} past feed{pastFeeds.length !== 1 ? 's' : ''}</span>
        </div>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {/* Rendered outside the collapsible below — the finally above
          collapses the panel on failure too, and the error must stay
          visible. */}
      {loadError && (
        <p className="px-4 pb-2 text-[12px] text-persona-skeptic">{loadError}</p>
      )}

      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none ${
          expanded ? '[grid-template-rows:1fr]' : '[grid-template-rows:0fr]'
        }`}
      >
        <div className="overflow-hidden min-h-0">
          <div className="px-4 pb-3 space-y-1">
            {pastFeeds.map((feed) => (
            <button
              key={feed.id}
              onClick={async () => {
                // Hydrate full posts only when the user picks this feed,
                // rather than front-loading 20 × feed body on every
                // history open.
                setLoadError(null)
                try {
                  const full = await getFeed(feed.id)
                  onLoadFeed(full)
                } catch {
                  // The user clicked to load a feed — surface the failure
                  // instead of silently collapsing the panel.
                  setLoadError('Could not load this feed — check your connection and try again.')
                } finally {
                  setExpanded(false)
                }
              }}
              className="w-full text-left px-3 py-2 rounded-lg flex items-center justify-between bg-transparent border-none cursor-pointer hover:bg-bg-hover transition-colors"
              style={{
                backgroundColor: feed.id === currentFeedId ? 'color-mix(in srgb, var(--color-gold) 8%, transparent)' : undefined,
              }}
            >
              <div>
                <div className="text-[13px] text-text font-medium">
                  {feed.post_count} posts · {feed.paper_count} paper{feed.paper_count !== 1 ? 's' : ''}
                </div>
                <div className="text-[11px] text-text-muted">
                  {feed.generated_at ? timeAgo(feed.generated_at) : 'Unknown'}
                  {feed.id === currentFeedId && <span className="text-gold ml-2">current</span>}
                </div>
              </div>
            </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
