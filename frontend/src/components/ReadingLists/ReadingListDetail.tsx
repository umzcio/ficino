import { useState, useEffect, useCallback } from 'react'
import {
  ArrowLeft, Lock, Unlock, CheckCircle2,
  Loader2, Play, GripVertical, FileText,
} from 'lucide-react'
import {
  getReadingList, getFeed, generateChapter, reorderReadingList, getFeedStatus,
  type ReadingListDetail as ReadingListDetailType,
} from '../../lib/api'
import type { Feed, FeedPost } from '../../types'
import { PostCard } from '../Feed/PostCard'
import { SwipeBackEdge } from '../_shared/SwipeBackEdge'
import { Spinner } from '../_shared/AsyncState'

interface Props {
  listId: string
  onBack: () => void
}

type ViewMode = 'overview' | 'chapter'

export function ReadingListDetail({ listId, onBack }: Props) {
  const [list, setList] = useState<ReadingListDetailType | null>(null)
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<ViewMode>('overview')
  const [activeChapterIndex, setActiveChapterIndex] = useState<number | null>(null)
  const [chapterFeed, setChapterFeed] = useState<Feed | null>(null)
  const [generating, setGenerating] = useState(false)
  const [orderingReady, setOrderingReady] = useState(false)

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

  // Poll for AI ordering if not ready
  useEffect(() => {
    if (orderingReady || !list) return
    const interval = setInterval(async () => {
      const data = await getReadingList(listId)
      if (data.papers.some(p => p.rationale)) {
        setList(data)
        setOrderingReady(true)
        clearInterval(interval)
      }
    }, 3000)
    return () => clearInterval(interval)
  }, [orderingReady, listId, list])

  const handleGenerateChapter = async (chapterIndex: number) => {
    if (!list) return
    setGenerating(true)
    try {
      const { task_id } = await generateChapter(listId, chapterIndex)
      // Poll for completion
      const poll = async () => {
        const status = await getFeedStatus(task_id)
        if (status.status === 'complete') {
          await refresh()
          // Load the chapter's feed
          const updated = await getReadingList(listId)
          const ch = updated.chapters.find(c => c.chapter_index === chapterIndex)
          if (ch?.feed_id) {
            const feed = await getFeed(ch.feed_id)
            setChapterFeed(feed)
            setActiveChapterIndex(chapterIndex)
            setViewMode('chapter')
          }
          setGenerating(false)
        } else if (status.status === 'error') {
          setGenerating(false)
        } else {
          setTimeout(poll, 2000)
        }
      }
      poll()
    } catch {
      setGenerating(false)
    }
  }

  const handleViewChapter = async (chapterIndex: number) => {
    if (!list) return
    const ch = list.chapters.find(c => c.chapter_index === chapterIndex)
    if (ch?.feed_id) {
      const feed = await getFeed(ch.feed_id)
      setChapterFeed(feed)
      setActiveChapterIndex(chapterIndex)
      setViewMode('chapter')
    }
  }

  const handleMoveUp = async (index: number) => {
    if (!list || index <= 0) return
    const newSequence = list.papers.map(p => p.id)
    ;[newSequence[index - 1], newSequence[index]] = [newSequence[index], newSequence[index - 1]]
    await reorderReadingList(listId, newSequence)
    refresh()
  }

  const handleMoveDown = async (index: number) => {
    if (!list || index >= list.papers.length - 1) return
    const newSequence = list.papers.map(p => p.id)
    ;[newSequence[index], newSequence[index + 1]] = [newSequence[index + 1], newSequence[index]]
    await reorderReadingList(listId, newSequence)
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
            {chapterPaper.rationale && (
              <p className="text-[12px] text-text-mid mt-1 italic">{chapterPaper.rationale}</p>
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
    )
  }

  // Overview: paper order + chapters
  return (
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
      {!orderingReady && (
        <div className="px-4 py-3 border-b border-border bg-gold/5 flex items-center gap-2">
          <Loader2 size={14} className="text-gold animate-spin" />
          <span className="text-[13px] text-text-mid">The Archivist is analyzing your papers to propose a reading order...</span>
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
                {paper.rationale && (
                  <p className="text-[12px] text-text-mid mt-1 italic leading-relaxed">{paper.rationale}</p>
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
  )
}
