import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Play, Pause, SkipForward, SkipBack, Loader2, X, Volume2 } from 'lucide-react'
import type { FeedPost } from '../../types'
import { getFeed, requestFeedAudio } from '../../lib/api'

type Status = 'idle' | 'requesting' | 'generating' | 'ready' | 'playing' | 'paused' | 'failed' | 'unavailable'

interface Props {
  feedId: string | null
  posts: FeedPost[]
  onCurrentPostChange?: (postIndex: number | null) => void
}

function personaDisplay(post: FeedPost): string {
  const key = post.persona
  if (!key) return ''
  return key.charAt(0).toUpperCase() + key.slice(1)
}

/**
 * Sequential feed-audio player.
 *
 * Lifecycle:
 *   idle -> (click Play) -> requesting -> generating -> ready -> playing
 *                                                    \-> failed | unavailable
 *
 * "Playing" walks the posts array in order, skipping posts without
 * audio_url (soft-deleted on the server, or skipped by the worker due to
 * an ElevenLabs error). When it hits the end it stops and returns to
 * 'ready' so the user can replay.
 *
 * The component owns ONE HTMLAudioElement and swaps its `src` between
 * tracks rather than instantiating per-post elements — mobile browsers
 * cap concurrent audio contexts and creating/destroying elements on
 * iOS Safari causes autoplay-policy flakiness.
 */
export function FeedAudioPlayer({ feedId, posts, onCurrentPostChange }: Props) {
  const [status, setStatus] = useState<Status>('idle')
  const [currentIndex, setCurrentIndex] = useState<number>(-1)
  // `serverPosts` holds posts with hydrated audio_urls after the /feed/{id}
  // GET that completes when audio_status flips to 'ready'. We read from it
  // for playback rather than the prop, because the parent's useFeed hook
  // doesn't re-fetch on audio status changes and wouldn't have the URLs.
  const [serverPosts, setServerPosts] = useState<FeedPost[] | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  const activePosts = serverPosts ?? posts
  const activePostsRef = useRef<FeedPost[]>(activePosts)
  useEffect(() => { activePostsRef.current = activePosts }, [activePosts])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current)
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current.src = ''
      }
    }
  }, [])

  // A feed switch resets the player entirely.
  useEffect(() => {
    setStatus('idle')
    setCurrentIndex(-1)
    setServerPosts(null)
    onCurrentPostChange?.(null)
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.src = ''
    }
    if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current)
  }, [feedId, onCurrentPostChange])

  const playableIndices = useMemo(
    () =>
      activePosts
        .map((p, i) => ({ p, i }))
        .filter(({ p }) => !p.deleted && p.audio_url)
        .map(({ i }) => i),
    [activePosts],
  )

  const playAtIndex = useCallback(
    (i: number) => {
      const audio = audioRef.current
      if (!audio) return
      const post = activePostsRef.current[i]
      if (!post || !post.audio_url) return
      audio.src = post.audio_url
      audio.play()
        .then(() => {
          if (!mountedRef.current) return
          setCurrentIndex(i)
          setStatus('playing')
          onCurrentPostChange?.(i)
        })
        .catch(() => {
          // Autoplay blocked or network error. Park in paused so the
          // user can tap to retry without losing position.
          if (mountedRef.current) setStatus('paused')
        })
    },
    [onCurrentPostChange],
  )

  const advance = useCallback(() => {
    const next = playableIndices.find((i) => i > currentIndex)
    if (next !== undefined) {
      playAtIndex(next)
    } else {
      // End of feed — park on the last post, go to ready so Play restarts.
      setStatus('ready')
      setCurrentIndex(-1)
      onCurrentPostChange?.(null)
    }
  }, [playableIndices, currentIndex, playAtIndex, onCurrentPostChange])

  const goPrev = useCallback(() => {
    const prior = [...playableIndices].reverse().find((i) => i < currentIndex)
    if (prior !== undefined) playAtIndex(prior)
  }, [playableIndices, currentIndex, playAtIndex])

  const pollUntilReady = useCallback(async () => {
    if (!feedId || !mountedRef.current) return
    try {
      const feed = await getFeed(feedId)
      if (!mountedRef.current) return
      // Propagate the freshly-hydrated audio_urls up so the parent's
      // `posts` prop contains them before we try to play. We do this by
      // mutating our local postsRef directly from the server response —
      // the parent will see it on its next refresh via its own state.
      // For immediate playback, source from the server's posts array.
      const fresh = (feed.posts as FeedPost[]) || []
      setServerPosts(fresh)
      activePostsRef.current = fresh

      if (feed.audio_status === 'ready') {
        setStatus('ready')
        // Auto-start on first ready: the user clicked Play a moment ago
        // and has been staring at the spinner — don't make them click again.
        const firstPlayable = fresh.findIndex(
          (p) => !p.deleted && p.audio_url,
        )
        if (firstPlayable >= 0) {
          const audio = audioRef.current
          if (audio) {
            const url = fresh[firstPlayable].audio_url!
            audio.src = url
            audio.play()
              .then(() => {
                if (!mountedRef.current) return
                setCurrentIndex(firstPlayable)
                setStatus('playing')
                onCurrentPostChange?.(firstPlayable)
              })
              .catch(() => {
                if (mountedRef.current) setStatus('paused')
              })
          }
        }
        return
      }
      if (feed.audio_status === 'failed') {
        setStatus('failed')
        return
      }
      // Still generating — poll again
      pollTimeoutRef.current = setTimeout(pollUntilReady, 2500)
    } catch {
      // Transient network error — back off slightly and try again
      pollTimeoutRef.current = setTimeout(pollUntilReady, 4000)
    }
  }, [feedId, onCurrentPostChange])

  const handlePlayClick = useCallback(async () => {
    if (!feedId) return
    // Already-playing path (from ready or paused): just kick off / resume.
    if (status === 'ready' || status === 'paused') {
      if (currentIndex < 0) {
        // Fresh play from ready — start at first playable
        const first = playableIndices[0]
        if (first !== undefined) playAtIndex(first)
      } else {
        // Resume paused
        audioRef.current?.play().then(() => {
          if (mountedRef.current) setStatus('playing')
        })
      }
      return
    }
    // Not generated yet — request and poll.
    setStatus('requesting')
    try {
      const resp = await requestFeedAudio(feedId)
      if (!mountedRef.current) return
      if (resp.status === 'ready') {
        // Audio was already generated (another tab, or a prior click).
        // Reload to get hydrated URLs, then play.
        setStatus('generating')
        pollUntilReady()
      } else {
        setStatus('generating')
        pollTimeoutRef.current = setTimeout(pollUntilReady, 1500)
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      // The API returns 501 when ELEVENLABS_API_KEY is unset. The
      // request() wrapper surfaces this as a generic error — we key on
      // the 501 in the message to hide the player entirely.
      if (msg.includes('501') || msg.toLowerCase().includes('not configured')) {
        setStatus('unavailable')
      } else {
        setStatus('failed')
      }
    }
  }, [feedId, status, currentIndex, playableIndices, playAtIndex, pollUntilReady])

  const handlePauseClick = useCallback(() => {
    audioRef.current?.pause()
    setStatus('paused')
  }, [])

  const handleCloseClick = useCallback(() => {
    audioRef.current?.pause()
    if (audioRef.current) audioRef.current.src = ''
    setStatus(playableIndices.length > 0 ? 'ready' : 'idle')
    setCurrentIndex(-1)
    onCurrentPostChange?.(null)
  }, [playableIndices.length, onCurrentPostChange])

  if (!feedId || posts.length === 0 || status === 'unavailable') {
    return null
  }

  const isBusy = status === 'requesting' || status === 'generating'
  const isActive = status === 'playing' || status === 'paused'
  const currentPost = currentIndex >= 0 ? activePosts[currentIndex] : null

  return (
    <div className="sticky top-0 z-20 bg-bg border-b border-border">
      <audio
        ref={audioRef}
        preload="none"
        onEnded={advance}
        onError={() => {
          // Track error — skip to next rather than halt the whole session.
          if (mountedRef.current && status === 'playing') advance()
        }}
      />
      <div className="flex items-center gap-3 px-4 py-2.5">
        {!isActive && !isBusy && (
          <button
            onClick={handlePlayClick}
            className="flex items-center gap-2 text-gold hover:bg-gold/10 rounded-full px-3 py-1.5 text-sm font-semibold transition-colors"
            aria-label="Play feed audio"
          >
            <Play size={16} fill="currentColor" />
            Play feed
          </button>
        )}
        {isBusy && (
          <div
            className="flex items-center gap-2 text-text-muted text-sm"
            role="status"
            aria-live="polite"
          >
            <Loader2 size={16} className="animate-spin text-gold" aria-hidden="true" />
            {status === 'requesting' ? 'Requesting audio…' : 'Generating audio (this takes ~30s)…'}
          </div>
        )}
        {isActive && (
          <>
            <button
              onClick={goPrev}
              disabled={!playableIndices.some((i) => i < currentIndex)}
              className="text-text-mid hover:text-text disabled:opacity-30 p-1"
              aria-label="Previous post"
            >
              <SkipBack size={18} />
            </button>
            {status === 'playing' ? (
              <button
                onClick={handlePauseClick}
                className="text-gold hover:bg-gold/10 rounded-full p-1.5"
                aria-label="Pause"
              >
                <Pause size={20} fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={handlePlayClick}
                className="text-gold hover:bg-gold/10 rounded-full p-1.5"
                aria-label="Resume"
              >
                <Play size={20} fill="currentColor" />
              </button>
            )}
            <button
              onClick={advance}
              disabled={!playableIndices.some((i) => i > currentIndex)}
              className="text-text-mid hover:text-text disabled:opacity-30 p-1"
              aria-label="Next post"
            >
              <SkipForward size={18} />
            </button>
            <div className="flex items-center gap-2 text-xs text-text-muted flex-1 min-w-0">
              <Volume2 size={14} aria-hidden="true" className="shrink-0" />
              <span className="truncate">
                {currentPost ? (
                  <>
                    <span className="text-text-secondary">{personaDisplay(currentPost)}</span>
                    <span className="text-text-subtle"> · post {currentIndex + 1} of {activePosts.length}</span>
                  </>
                ) : null}
              </span>
            </div>
            <button
              onClick={handleCloseClick}
              className="text-text-mid hover:text-text p-1"
              aria-label="Close audio player"
            >
              <X size={16} />
            </button>
          </>
        )}
        {status === 'failed' && (
          <div className="flex items-center gap-2 text-sm text-persona-skeptic">
            Audio generation failed.{' '}
            <button
              onClick={() => {
                setStatus('idle')
              }}
              className="underline hover:no-underline"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
