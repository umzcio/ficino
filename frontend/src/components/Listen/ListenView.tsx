import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Play, Pause, SkipForward, SkipBack, Loader2, Headphones, AlertCircle, Volume2,
} from 'lucide-react'
import type { FeedPost } from '../../types'
import { getFeed, requestFeedAudio } from '../../lib/api'
import { usePersonas } from '../../hooks/usePersonas'

type Status =
  | 'idle'
  | 'requesting'
  | 'generating'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'failed'
  | 'unavailable'
  | 'empty'

interface Props {
  feedId: string | null
  posts: FeedPost[]
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Dedicated "Listen" page. Takes the current feed's posts and drives
 * ElevenLabs-generated audio playback with a proper track-list UI.
 *
 * State machine is the same as the old inline player
 * (idle→requesting→generating→ready→playing/paused), but the rendering
 * is a full-page hero + post list instead of a cramped sticky bar.
 *
 * Owns exactly one HTMLAudioElement and swaps its src between tracks.
 * Mobile browsers penalize short-lived <audio> instantiations with
 * autoplay-policy resets; one persistent element avoids that trap.
 */
export function ListenView({ feedId, posts }: Props) {
  const personas = usePersonas()
  const [status, setStatus] = useState<Status>(posts.length === 0 ? 'empty' : 'idle')
  const [currentIndex, setCurrentIndex] = useState<number>(-1)
  const [progress, setProgress] = useState<{ current: number; duration: number }>({ current: 0, duration: 0 })
  // serverPosts holds the feed after its audio_url fields have been
  // hydrated server-side. We prefer it over the prop because the
  // parent useFeed hook doesn't refetch on audio status changes.
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

  useEffect(() => {
    setStatus(posts.length === 0 ? 'empty' : 'idle')
    setCurrentIndex(-1)
    setServerPosts(null)
    setProgress({ current: 0, duration: 0 })
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.src = ''
    }
    if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current)
  }, [feedId, posts.length])

  const playableIndices = useMemo(
    () =>
      activePosts
        .map((p, i) => ({ p, i }))
        .filter(({ p }) => !p.deleted && p.audio_url)
        .map(({ i }) => i),
    [activePosts],
  )

  const playAtIndex = useCallback((i: number) => {
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
      })
      .catch(() => {
        if (mountedRef.current) setStatus('paused')
      })
  }, [])

  const advance = useCallback(() => {
    const next = playableIndices.find((i) => i > currentIndex)
    if (next !== undefined) {
      playAtIndex(next)
    } else {
      // End of feed — reset to ready so Play restarts from the top.
      setStatus('ready')
      setCurrentIndex(-1)
      setProgress({ current: 0, duration: 0 })
    }
  }, [playableIndices, currentIndex, playAtIndex])

  const goPrev = useCallback(() => {
    const prior = [...playableIndices].reverse().find((i) => i < currentIndex)
    if (prior !== undefined) playAtIndex(prior)
  }, [playableIndices, currentIndex, playAtIndex])

  const pollUntilReady = useCallback(async () => {
    if (!feedId || !mountedRef.current) return
    try {
      const feed = await getFeed(feedId)
      if (!mountedRef.current) return
      const fresh = (feed.posts as FeedPost[]) || []
      setServerPosts(fresh)
      activePostsRef.current = fresh

      if (feed.audio_status === 'ready') {
        setStatus('ready')
        const firstPlayable = fresh.findIndex((p) => !p.deleted && p.audio_url)
        if (firstPlayable >= 0) {
          const audio = audioRef.current
          if (audio) {
            audio.src = fresh[firstPlayable].audio_url!
            audio.play()
              .then(() => {
                if (!mountedRef.current) return
                setCurrentIndex(firstPlayable)
                setStatus('playing')
              })
              .catch(() => { if (mountedRef.current) setStatus('paused') })
          }
        }
        return
      }
      if (feed.audio_status === 'failed') {
        setStatus('failed')
        return
      }
      pollTimeoutRef.current = setTimeout(pollUntilReady, 2500)
    } catch {
      pollTimeoutRef.current = setTimeout(pollUntilReady, 4000)
    }
  }, [feedId])

  const handlePlayClick = useCallback(async () => {
    if (!feedId) return
    if (status === 'ready' || status === 'paused') {
      if (currentIndex < 0) {
        const first = playableIndices[0]
        if (first !== undefined) playAtIndex(first)
      } else {
        audioRef.current?.play().then(() => {
          if (mountedRef.current) setStatus('playing')
        })
      }
      return
    }
    setStatus('requesting')
    try {
      const resp = await requestFeedAudio(feedId)
      if (!mountedRef.current) return
      if (resp.status === 'ready') {
        setStatus('generating')
        pollUntilReady()
      } else {
        setStatus('generating')
        pollTimeoutRef.current = setTimeout(pollUntilReady, 1500)
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
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

  const handleTrackClick = useCallback((i: number) => {
    // Click a track → jump to it if it has audio. Otherwise ignored.
    if (!activePosts[i]?.audio_url) return
    playAtIndex(i)
  }, [activePosts, playAtIndex])

  const isBusy = status === 'requesting' || status === 'generating'
  const isActive = status === 'playing' || status === 'paused'
  const hasPlayableAudio = playableIndices.length > 0
  const uniquePersonas = useMemo(
    () => Array.from(new Set(activePosts.map((p) => p.persona).filter(Boolean))),
    [activePosts],
  )

  // --- Empty states ---
  if (status === 'unavailable') {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center">
        <Headphones size={48} className="mx-auto mb-4 text-text-muted" />
        <h1 className="text-xl font-semibold text-text mb-2">Audio not configured</h1>
        <p className="text-sm text-text-muted max-w-md mx-auto">
          Feed audio requires an ElevenLabs API key. Ask your Ficino
          administrator to set <code className="text-gold text-xs">ELEVENLABS_API_KEY</code>.
        </p>
      </div>
    )
  }

  if (status === 'empty' || !feedId) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center">
        <Headphones size={48} className="mx-auto mb-4 text-text-muted" strokeWidth={1.25} />
        <h1 className="text-xl font-semibold text-text mb-2">Nothing to listen to yet</h1>
        <p className="text-sm text-text-muted">
          Generate a feed first, then come back here to hear the personas debate aloud.
        </p>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 pt-6 pb-24">
      <audio
        ref={audioRef}
        preload="none"
        onEnded={advance}
        onError={() => { if (mountedRef.current && status === 'playing') advance() }}
        onTimeUpdate={(e) => {
          const el = e.currentTarget
          setProgress({ current: el.currentTime, duration: el.duration || 0 })
        }}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget
          setProgress({ current: 0, duration: el.duration || 0 })
        }}
      />

      {/* Header */}
      <div className="flex items-center gap-2 mb-6">
        <Headphones size={20} className="text-gold" />
        <h1 className="text-[22px] font-semibold text-text">Listen</h1>
      </div>

      {/* Hero card */}
      <div className="rounded-2xl border border-border bg-bg-hover p-5 mb-6">
        <div className="flex items-start gap-4">
          {/* Persona avatar stack */}
          <div className="flex -space-x-3 shrink-0">
            {uniquePersonas.slice(0, 4).map((key, idx) => {
              const p = personas[key]
              if (!p) return null
              const common = {
                key,
                className: 'w-12 h-12 rounded-full border-2 border-bg-hover object-cover',
                style: { zIndex: 10 - idx, boxShadow: `0 0 0 1px ${p.color}60` },
              } as const
              return p.avatar_url ? (
                <img {...common} src={p.avatar_url} alt={p.name} />
              ) : (
                <div
                  {...common}
                  className="w-12 h-12 rounded-full border-2 border-bg-hover flex items-center justify-center text-sm font-bold"
                  style={{
                    backgroundColor: p.color + '30',
                    color: p.color,
                    zIndex: 10 - idx,
                  }}
                >
                  {p.initials}
                </div>
              )
            })}
            {uniquePersonas.length > 4 && (
              <div className="w-12 h-12 rounded-full bg-bg border-2 border-bg-hover flex items-center justify-center text-xs font-bold text-text-muted">
                +{uniquePersonas.length - 4}
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] uppercase tracking-wider text-text-muted font-semibold">
              Latest feed
            </div>
            <div className="text-lg text-text font-semibold mt-0.5">
              {posts.length} posts · {uniquePersonas.length} personas
            </div>
            {isActive && currentIndex >= 0 && (
              <div className="mt-2 text-xs text-text-muted flex items-center gap-1.5">
                <Volume2 size={12} className="text-gold" />
                Now playing post {currentIndex + 1} of {activePosts.length}
              </div>
            )}
          </div>
        </div>

        {/* Main play button + progress */}
        <div className="mt-5 flex items-center gap-4">
          <button
            onClick={goPrev}
            disabled={!isActive || !playableIndices.some((i) => i < currentIndex)}
            aria-label="Previous post"
            className="p-2 rounded-full text-text-mid hover:text-text hover:bg-border/50 disabled:opacity-25 disabled:hover:bg-transparent transition-colors"
          >
            <SkipBack size={22} />
          </button>

          {isBusy ? (
            <button
              disabled
              aria-label="Generating audio"
              className="w-14 h-14 rounded-full flex items-center justify-center bg-gold/10 text-gold cursor-wait"
            >
              <Loader2 size={26} className="animate-spin" />
            </button>
          ) : status === 'playing' ? (
            <button
              onClick={handlePauseClick}
              aria-label="Pause"
              className="w-14 h-14 rounded-full flex items-center justify-center bg-gold text-bg shadow-lg hover:scale-105 transition-transform"
            >
              <Pause size={26} fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={handlePlayClick}
              aria-label={status === 'paused' ? 'Resume' : 'Play feed'}
              className="w-14 h-14 rounded-full flex items-center justify-center bg-gold text-bg shadow-lg hover:scale-105 transition-transform"
            >
              <Play size={26} fill="currentColor" className="ml-1" />
            </button>
          )}

          <button
            onClick={advance}
            disabled={!isActive || !playableIndices.some((i) => i > currentIndex)}
            aria-label="Next post"
            className="p-2 rounded-full text-text-mid hover:text-text hover:bg-border/50 disabled:opacity-25 disabled:hover:bg-transparent transition-colors"
          >
            <SkipForward size={22} />
          </button>

          <div className="flex-1 flex items-center gap-2 text-xs text-text-muted font-mono tabular-nums min-w-0">
            <span className="shrink-0">{formatTime(progress.current)}</span>
            <div className="flex-1 h-1 rounded-full bg-border overflow-hidden">
              <div
                className="h-full bg-gold transition-[width] duration-150"
                style={{
                  width: progress.duration
                    ? `${Math.min(100, (progress.current / progress.duration) * 100)}%`
                    : '0%',
                }}
              />
            </div>
            <span className="shrink-0">{formatTime(progress.duration)}</span>
          </div>
        </div>

        {/* Status line */}
        {status === 'requesting' && (
          <div className="mt-3 text-xs text-text-muted" role="status" aria-live="polite">
            Requesting audio…
          </div>
        )}
        {status === 'generating' && (
          <div className="mt-3 text-xs text-text-muted" role="status" aria-live="polite">
            Generating audio with ElevenLabs — this takes ~30 seconds for a full feed.
          </div>
        )}
        {status === 'idle' && !hasPlayableAudio && (
          <div className="mt-3 text-xs text-text-muted">
            Press play to generate audio for this feed.
          </div>
        )}
        {status === 'failed' && (
          <div className="mt-3 flex items-center gap-2 text-sm text-persona-skeptic" role="alert">
            <AlertCircle size={16} />
            Audio generation failed.{' '}
            <button
              onClick={() => setStatus('idle')}
              className="underline hover:no-underline ml-1"
            >
              Try again
            </button>
          </div>
        )}
      </div>

      {/* Track list */}
      <ol className="list-none p-0 m-0 space-y-1">
        {activePosts.map((post, idx) => {
          if (post.deleted) return null
          const p = personas[post.persona]
          const isCurrent = idx === currentIndex
          const hasAudio = Boolean(post.audio_url)
          const isPlaying = isCurrent && status === 'playing'
          return (
            <li key={idx}>
              <button
                onClick={() => handleTrackClick(idx)}
                disabled={!hasAudio}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors ${
                  isCurrent ? 'bg-gold/10' : hasAudio ? 'hover:bg-bg-hover' : ''
                } ${!hasAudio ? 'cursor-default opacity-60' : 'cursor-pointer'}`}
              >
                {/* Track number or playing indicator */}
                <div className="w-6 flex-shrink-0 flex items-center justify-center text-xs text-text-muted font-mono tabular-nums">
                  {isPlaying ? (
                    <Volume2 size={14} className="text-gold" />
                  ) : (
                    <span>{idx + 1}</span>
                  )}
                </div>
                {/* Avatar */}
                {p ? (
                  p.avatar_url ? (
                    <img
                      src={p.avatar_url}
                      alt={p.name}
                      className="w-9 h-9 rounded-full object-cover shrink-0"
                      style={{ boxShadow: `0 0 0 1.5px ${p.color}60` }}
                    />
                  ) : (
                    <div
                      className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
                      style={{
                        backgroundColor: p.color + '28',
                        border: `1.5px solid ${p.color}50`,
                        color: p.color,
                      }}
                    >
                      {p.initials}
                    </div>
                  )
                ) : (
                  <div className="w-9 h-9 rounded-full bg-border shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className={`text-sm font-semibold truncate ${isCurrent ? 'text-gold' : 'text-text'}`}>
                    {p?.name ?? post.persona}
                  </div>
                  <div className="text-xs text-text-muted truncate">
                    {post.content}
                  </div>
                </div>
                {!hasAudio && status === 'ready' && (
                  <div className="text-[10px] text-text-subtle uppercase tracking-wider shrink-0">
                    Skipped
                  </div>
                )}
              </button>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
