import { useState, useEffect, useCallback, useRef } from 'react'
import {
  ArrowLeft, Lock, Unlock, CheckCircle2,
  Loader2, Play, GripVertical, FileText,
} from 'lucide-react'
import {
  getReadingList, getFeed, generateChapter, reorderReadingList, getFeedStatus,
  type ReadingListDetail as ReadingListDetailType, type FeedStatus,
} from '../../lib/api'
import type { Feed, FeedPost } from '../../types'
import { PostCard } from '../Feed/PostCard'
import { SwipeBackEdge } from '../_shared/SwipeBackEdge'
import { Spinner } from '../_shared/AsyncState'
import { FadeIn } from '../_shared/FadeIn'
import { usePollTask, type PollController } from '../../hooks/usePollTask'
// The rationale is model output; a list stored before the server kept it as text can hold any JSON type.
import { asText } from '../../lib/postFields'

interface Props {
  listId: string
  onBack: () => void
}

type ViewMode = 'overview' | 'chapter'

const ORDERING_POLL_MAX_TICKS = 40 // 40 × 3s = 2 min — mirrors GroupChatView's bounded window

// Exported for unit testing (this repo has no @testing-library/react — see
// usePollTask.ts — so component logic worth unit-testing gets pulled out as
// a plain function, same pattern as GroupChatView's isGroupChatDone).
// eslint-disable-next-line react-refresh/only-export-components -- exported for unit testing; not a component
export function hasOrderingRationale(data: ReadingListDetailType): boolean {
  return data.papers.some(p => p.rationale)
}

// usePollTask's maxAttempts only bounds consecutive REJECTIONS — a healthy
// 200 without rationale resets its attempt counter, so an ordering task
// that faults server-side before writing rationale (worker OOM, LLM
// failure) would poll forever. Count the consecutive no-rationale streak
// (reset on any response that HAS rationale) and give up at a bounded
// window. Pure and exported for unit testing, same rationale as
// hasOrderingRationale above.
// eslint-disable-next-line react-refresh/only-export-components -- exported for unit testing; not a component
export function nextOrderingStreak(prevStreak: number, data: ReadingListDetailType): number {
  return hasOrderingRationale(data) ? 0 : prevStreak + 1
}

// eslint-disable-next-line react-refresh/only-export-components -- exported for unit testing; not a component
export function isOrderingStreakExhausted(streak: number): boolean {
  return streak >= ORDERING_POLL_MAX_TICKS
}

export function ReadingListDetail({ listId, onBack }: Props) {
  const [list, setList] = useState<ReadingListDetailType | null>(null)
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<ViewMode>('overview')
  const [activeChapterIndex, setActiveChapterIndex] = useState<number | null>(null)
  const [chapterFeed, setChapterFeed] = useState<Feed | null>(null)
  const [generating, setGenerating] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [orderingReady, setOrderingReady] = useState(false)
  const [orderingFailed, setOrderingFailed] = useState(false)
  const orderingStreakRef = useRef(0)
  const poll = usePollTask()
  const chapterPollRef = useRef<PollController | null>(null)
  // R10 FE-6 fix: the chapter poll below does nested async work
  // (refresh/getReadingList/getFeed) inside onDone after the terminal
  // status arrives. usePollTask's own mount-tracking prevents onDone from
  // firing at all once unmounted, but if it was already in flight when
  // unmount happens, these later awaits still need a guard before calling
  // setState — same pattern useFeed/PaperChat use for their nested awaits.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      chapterPollRef.current?.stop()
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const data = await getReadingList(listId)
      setList(data)
      // Check if AI ordering has been applied (rationale exists on papers)
      const hasRationale = data.papers.some(p => p.rationale)
      setOrderingReady(hasRationale)
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [listId])

  useEffect(() => { refresh() }, [refresh])

  // Poll for AI ordering if not ready. R10 DUP-11/FE-6: converted from a
  // bare setInterval with no error handling (an offline `getReadingList`
  // rejection was an unhandled promise rejection every 3s) to
  // usePollTask, which retries transient errors by default instead of
  // dying.
  useEffect(() => {
    if (orderingReady || orderingFailed || !list) return
    const controller = poll<ReadingListDetailType>({
      fn: async () => {
        const data = await getReadingList(listId)
        // Bound the wait (mirrors GroupChatView's generating-streak bound):
        // usePollTask's maxAttempts only counts consecutive REJECTIONS — a
        // healthy 200 without rationale resets it, so a server-side-faulted
        // ordering task would poll forever. Count the no-rationale streak
        // and give up into a Retry state at ORDERING_POLL_MAX_TICKS.
        orderingStreakRef.current = nextOrderingStreak(orderingStreakRef.current, data)
        if (isOrderingStreakExhausted(orderingStreakRef.current)) {
          controller.stop()
          setOrderingFailed(true)
        }
        return data
      },
      isDone: hasOrderingRationale,
      onDone: (data) => {
        setList(data)
        setOrderingReady(true)
      },
      intervalMs: 3000,
    })
    return () => controller.stop()
  }, [orderingReady, orderingFailed, listId, list, poll])

  // Re-arm the bounded ordering poll: resetting the streak and flipping
  // orderingFailed false re-runs the effect above (it's in its deps). A
  // second click while already false is a setState no-op, so rapid clicks
  // can't start a duplicate poll.
  const handleRetryOrdering = () => {
    orderingStreakRef.current = 0
    setOrderingFailed(false)
  }

  const handleGenerateChapter = async (chapterIndex: number) => {
    if (!list) return
    setGenerating(true)
    try {
      const { task_id } = await generateChapter(listId, chapterIndex)
      // R10 FE-6 fix: this poll used to have no stored timeout (leaving
      // the view didn't stop it — setState-after-unmount) and no
      // try/catch (one failed status/feed fetch mid-generation left
      // `generating` stuck true forever, permanently disabling the
      // "Generate Chapter" button). usePollTask fixes both: the timeout
      // chain is cancelled on unmount (see the mount effect above) and a
      // rejected fn() re-schedules instead of dying.
      chapterPollRef.current = poll<FeedStatus>({
        fn: () => getFeedStatus(task_id),
        isDone: (status) => status.status === 'complete' || status.status === 'error',
        onDone: async (status) => {
          // R10 wave-4 final-review: this body used to have no try/finally
          // around its awaits (refresh/getReadingList/getFeed) — a
          // transient failure among them was an unhandled promise
          // rejection AND skipped setGenerating(false), permanently
          // disabling the "Generate Chapter" button. finally guarantees the
          // button re-enables regardless of how this resolves.
          try {
            if (status.status === 'complete') {
              await refresh()
              // Load the chapter's feed
              const updated = await getReadingList(listId)
              if (!mountedRef.current) return
              const ch = updated.chapters.find(c => c.chapter_index === chapterIndex)
              if (ch?.feed_id) {
                const feed = await getFeed(ch.feed_id)
                if (!mountedRef.current) return
                setChapterFeed(feed)
                setActiveChapterIndex(chapterIndex)
                setViewMode('chapter')
              }
            }
          } finally {
            if (mountedRef.current) setGenerating(false)
          }
        },
        // Original poll() was called directly (no initial setTimeout) —
        // the first status check fires immediately.
        initialDelayMs: 0,
        intervalMs: 2000,
      })
    } catch {
      setGenerating(false)
    }
  }

  const handleViewChapter = async (chapterIndex: number) => {
    if (!list) return
    const ch = list.chapters.find(c => c.chapter_index === chapterIndex)
    if (ch?.feed_id) {
      setActionError(null)
      try {
        const feed = await getFeed(ch.feed_id)
        setChapterFeed(feed)
        setActiveChapterIndex(chapterIndex)
        setViewMode('chapter')
      } catch {
        // Navigational action — surface the failure instead of the click
        // silently doing nothing (App.tsx fire-and-forget convention).
        setActionError('Could not load this chapter — check your connection and try again.')
      }
    }
  }

  const handleMoveUp = async (index: number) => {
    if (!list || index <= 0) return
    const newSequence = list.papers.map(p => p.id)
    ;[newSequence[index - 1], newSequence[index]] = [newSequence[index], newSequence[index - 1]]
    // Best-effort: a failed reorder is self-evident (order unchanged) and
    // refresh() resyncs from server state — swallow per App.tsx convention.
    await reorderReadingList(listId, newSequence).catch(() => {})
    refresh()
  }

  const handleMoveDown = async (index: number) => {
    if (!list || index >= list.papers.length - 1) return
    const newSequence = list.papers.map(p => p.id)
    ;[newSequence[index], newSequence[index + 1]] = [newSequence[index + 1], newSequence[index]]
    // Best-effort: a failed reorder is self-evident (order unchanged) and
    // refresh() resyncs from server state — swallow per App.tsx convention.
    await reorderReadingList(listId, newSequence).catch(() => {})
    refresh()
  }

  if (loading || !list) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size={24} />
      </div>
    )
  }

  // Chapter feed view
  if (viewMode === 'chapter' && activeChapterIndex !== null && chapterFeed) {
    const chapterPaper = list.papers[activeChapterIndex]

    return (
      <FadeIn key={`chapter-${activeChapterIndex}`}>
        <div>
          <SwipeBackEdge onBack={() => setViewMode('overview')} />
          <div className="sticky top-0 z-10 bg-bg/90 backdrop-blur-[12px] border-b border-border px-4 py-3">
            <div className="flex items-center gap-3">
              <button onClick={() => setViewMode('overview')} aria-label="Back to overview" className="bg-transparent border-none cursor-pointer text-text p-2 hover:bg-bg-hover rounded-full">
                <ArrowLeft size={20} />
              </button>
              <div>
                <div className="text-[15px] font-bold text-text">Chapter {activeChapterIndex + 1}: {chapterPaper?.title}</div>
                <div className="text-[12px] text-text-muted">{list.name}</div>
              </div>
            </div>
          </div>

          {/* Chapter intro */}
          {chapterPaper && (
            <div className="px-4 py-3 border-b border-border bg-gold/3">
              <div className="flex items-center gap-2 mb-1">
                <FileText size={12} className="text-gold" />
                <span className="text-[13px] font-semibold text-text">{chapterPaper.title}</span>
              </div>
              {chapterPaper.authors?.length > 0 && (
                <div className="text-[12px] text-text-muted">{chapterPaper.authors.join(', ')} {chapterPaper.year && `(${chapterPaper.year})`}</div>
              )}
              {asText(chapterPaper.rationale) && (
                <p className="text-[12px] text-text-mid mt-1 italic">{asText(chapterPaper.rationale)}</p>
              )}
            </div>
          )}

          {/* Feed posts */}
          {chapterFeed.posts.map((post: FeedPost, i: number) => (
            <PostCard key={post.id ?? i} post={post} postIndex={i} />
          ))}

          {/* Next chapter button */}
          {activeChapterIndex < list.chapters.length - 1 && (
            <div className="py-6 text-center border-t border-border">
              {list.chapters[activeChapterIndex + 1]?.status === 'unlocked' ? (
                <button
                  onClick={() => handleGenerateChapter(activeChapterIndex + 1)}
                  disabled={generating}
                  className="inline-flex items-center gap-2 bg-gold text-bg text-[14px] font-semibold px-6 py-2.5 rounded-full border-none cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-40"
                >
                  {generating ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                  Generate Chapter {activeChapterIndex + 2}
                </button>
              ) : list.chapters[activeChapterIndex + 1]?.status === 'complete' ? (
                <button
                  onClick={() => handleViewChapter(activeChapterIndex + 1)}
                  className="inline-flex items-center gap-2 bg-transparent border border-gold/30 text-gold text-[14px] font-semibold px-6 py-2.5 rounded-full cursor-pointer hover:bg-gold/5 transition-colors"
                >
                  Next: Chapter {activeChapterIndex + 2}
                </button>
              ) : (
                <div className="flex items-center justify-center gap-2 text-text-muted text-[13px]">
                  <Lock size={14} />
                  Chapter {activeChapterIndex + 2} locked
                </div>
              )}
            </div>
          )}
        </div>
      </FadeIn>
    )
  }

  // Overview: paper order + chapters
  return (
    <FadeIn key={list.id}>
      <div>
        <SwipeBackEdge onBack={onBack} />
        <div className="sticky top-0 z-10 bg-bg/90 backdrop-blur-[12px] border-b border-border px-4 py-3">
          <div className="flex items-center gap-3">
            <button onClick={onBack} aria-label="Back to reading lists" className="bg-transparent border-none cursor-pointer text-text p-2 hover:bg-bg-hover rounded-full">
              <ArrowLeft size={20} />
            </button>
            <div>
              <div className="text-[20px] font-bold text-text">{list.name}</div>
              <div className="text-[12px] text-text-muted">{list.papers.length} papers · {list.chapters.filter(c => c.status === 'complete').length}/{list.chapters.length} chapters</div>
            </div>
          </div>
        </div>

        {/* AI ordering status */}
        {actionError && (
          <p className="px-4 py-2 text-[12px] text-persona-skeptic border-b border-border">{actionError}</p>
        )}
        {!orderingReady && (
          <div className="px-4 py-3 border-b border-border bg-gold/5 flex items-center gap-2">
            {orderingFailed ? (
              <>
                <span className="text-[13px] text-text-mid">Ordering is taking longer than expected — the analysis may have failed.</span>
                <button
                  onClick={handleRetryOrdering}
                  className="shrink-0 text-[12px] text-gold bg-transparent border border-gold/20 rounded-full px-3 py-1 cursor-pointer hover:bg-gold/5 transition-colors"
                >
                  Retry
                </button>
              </>
            ) : (
              <>
                <Loader2 size={14} className="text-gold animate-spin" />
                <span className="text-[13px] text-text-mid">The Archivist is analyzing your papers to propose a reading order...</span>
              </>
            )}
          </div>
        )}

        {/* Paper sequence */}
        <div className="px-4 py-3 border-b border-border">
          <div className="text-[11px] text-gold font-semibold uppercase tracking-wider mb-3">Reading Order</div>
          {list.papers.map((paper, i) => {
            const chapter = list.chapters.find(c => c.chapter_index === i)
            const statusIcon = chapter?.status === 'complete'
              ? <CheckCircle2 size={16} className="text-green-400" />
              : chapter?.status === 'unlocked'
              ? <Unlock size={16} className="text-gold" />
              : <Lock size={16} className="text-text-muted/40" />

            return (
              <div key={paper.id} className="flex items-start gap-3 py-2.5 border-b border-border last:border-b-0">
                <div className="flex flex-col items-center gap-1 pt-0.5">
                  <span className="text-[12px] font-bold text-gold w-5 text-center">{i + 1}</span>
                  {statusIcon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] font-semibold text-text truncate">{paper.title}</div>
                  {paper.authors?.length > 0 && (
                    <div className="text-[12px] text-text-muted">{paper.authors.join(', ')} {paper.year && `(${paper.year})`}</div>
                  )}
                  {asText(paper.rationale) && (
                    <p className="text-[12px] text-text-mid mt-1 italic leading-relaxed">{asText(paper.rationale)}</p>
                  )}
                </div>
                <div className="flex flex-col gap-0.5 shrink-0">
                  <button
                    onClick={() => handleMoveUp(i)}
                    disabled={i === 0}
                    aria-label="Move up"
                    className="bg-transparent border-none cursor-pointer text-text-muted hover:text-text disabled:opacity-20 p-2.5 rounded-full"
                  >
                    <GripVertical size={14} className="rotate-180" />
                  </button>
                  <button
                    onClick={() => handleMoveDown(i)}
                    disabled={i === list.papers.length - 1}
                    aria-label="Move down"
                    className="bg-transparent border-none cursor-pointer text-text-muted hover:text-text disabled:opacity-20 p-2.5 rounded-full"
                  >
                    <GripVertical size={14} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        {/* Chapters */}
        <div className="px-4 py-3">
          <div className="text-[11px] text-gold font-semibold uppercase tracking-wider mb-3">Chapters</div>
          {list.chapters.map((ch) => {
            const paper = list.papers[ch.chapter_index]
            return (
              <div key={ch.id} className="flex items-center gap-3 py-2.5 border-b border-border last:border-b-0">
                <div className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold shrink-0"
                  style={{
                    backgroundColor: ch.status === 'complete' ? 'rgba(52,211,153,0.15)' : ch.status === 'unlocked' ? 'rgba(200,169,110,0.15)' : 'rgba(85,93,110,0.1)',
                    color: ch.status === 'complete' ? '#34d399' : ch.status === 'unlocked' ? '#c8a96e' : '#555d6e',
                  }}
                >
                  {ch.chapter_index + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] text-text truncate">{paper?.title || `Chapter ${ch.chapter_index + 1}`}</div>
                  <div className="text-[11px] text-text-muted">
                    {ch.status === 'complete' ? 'Complete' : ch.status === 'unlocked' ? 'Ready to generate' : 'Locked'}
                  </div>
                </div>
                {ch.status === 'complete' && ch.feed_id && (
                  <button
                    onClick={() => handleViewChapter(ch.chapter_index)}
                    className="text-[12px] text-gold bg-transparent border border-gold/20 rounded-full px-3 py-1 cursor-pointer hover:bg-gold/5 transition-colors"
                  >
                    Read
                  </button>
                )}
                {ch.status === 'unlocked' && !ch.feed_id && (
                  <button
                    onClick={() => handleGenerateChapter(ch.chapter_index)}
                    disabled={generating}
                    className="inline-flex items-center gap-1.5 text-[12px] text-bg bg-gold font-semibold rounded-full px-3 py-1 border-none cursor-pointer hover:opacity-90 disabled:opacity-40"
                  >
                    {generating ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                    Generate
                  </button>
                )}
                {ch.status === 'locked' && (
                  <Lock size={14} className="text-text-muted/30 shrink-0" />
                )}
              </div>
            )
          })}
        </div>
      </div>
    </FadeIn>
  )
}
