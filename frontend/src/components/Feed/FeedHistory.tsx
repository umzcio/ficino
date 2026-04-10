import { useState, useEffect } from 'react'
import { Clock, ChevronDown, ChevronUp } from 'lucide-react'
import { listFeeds } from '../../lib/api'
import type { Feed } from '../../types'

interface FeedHistoryProps {
  currentFeedId: string | null
  onLoadFeed: (feed: Feed) => void
  workspaceId?: string
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export function FeedHistory({ currentFeedId, onLoadFeed, workspaceId }: FeedHistoryProps) {
  const [feeds, setFeeds] = useState<Feed[]>([])
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    listFeeds(workspaceId).then(setFeeds).catch(() => {})
  }, [currentFeedId, workspaceId]) // refresh when a new feed is generated or workspace changes

  const pastFeeds = feeds.filter((f) => f.posts.length > 0)

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

      {expanded && (
        <div className="px-4 pb-3 space-y-1">
          {pastFeeds.map((feed) => (
            <button
              key={feed.id}
              onClick={() => { onLoadFeed(feed); setExpanded(false) }}
              className="w-full text-left px-3 py-2 rounded-lg flex items-center justify-between bg-transparent border-none cursor-pointer hover:bg-bg-hover transition-colors"
              style={{
                backgroundColor: feed.id === currentFeedId ? 'rgba(200, 169, 110, 0.08)' : undefined,
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
      )}
    </div>
  )
}
