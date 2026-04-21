import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Play, Pause, SkipForward, SkipBack, Loader2, Headphones, AlertCircle, Volume2, Mic,
} from 'lucide-react'
import type { FeedPost, PodcastSegment } from '../../types'
import { getFeed, requestFeedAudio, requestFeedPodcast } from '../../lib/api'
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

type Mode = 'feed' | 'podcast'

// Unified track shape used by the shared <audio> element. Both feed posts
// (persona voices) and podcast segments (two hosts) render through the
// same play/pause/skip machinery — only the source of tracks and the
// rendered list item differ per mode.
interface Track {
  audio_url?: string | null
  deleted?: boolean
}

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

function hostLabel(speaker: 'host_a' | 'host_b'): string {
  return speaker === 'host_a' ? 'Host A' : 'Host B'
}

function hostColor(speaker: 'host_a' | 'host_b'): string {
  // Two distinct colors so the track list scans quickly. Gold for A
  // (matches the primary accent), a cooler teal-ish for B.
  return speaker === 'host_a' ? '#d4a84b' : '#6fa8c7'
}

/**
 * Dedicated "Listen" page. Takes the current feed and drives
 * ElevenLabs-generated audio playback in one of two modes:
 *   - Feed mode: one track per post, persona-voiced. The original flow.
 *   - Podcast mode: NotebookLM-style two-host dialogue grounded in the
 *     same papers. New; on-demand like feed audio.
 *
 * Owns exactly one HTMLAudioElement and swaps its src between tracks.
 * Mobile browsers penalize short-lived <audio> instantiations with
 * autoplay-policy resets; one persistent element avoids that trap.
 */
export function ListenView({ feedId, posts }: Props) {
  const personas = usePersonas()
  const [mode, setMode] = useState<Mode>('feed')
  const [status, setStatus] = useState<Status>(posts.length === 0 ? 'empty' : 'idle')
  const [currentIndex, setCurrentIndex] = useState<number>(-1)
  const [progress, setProgress] = useState<{ current: number; duration: number }>({ current: 0, duration: 0 })
  // serverPosts holds the feed after its audio_url fields have been
  // hydrated server-side. We prefer it over the prop because the
  // parent useFeed hook doesn't refetch on audio status changes.
  const [serverPosts, setServerPosts] = useState<FeedPost[] | null>(null)
  const [podcastSegments, setPodcastSegments] = useState<PodcastSegment[] | null>(null)
  const [podcastStatus, setPodcastStatus] = useState<'generating' | 'ready' | 'failed' | null>(null)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  const activePosts = serverPosts ?? posts

  // Which track array is active depends on the mode. Podcast segments
  // filter deleted=false (no soft-delete in podcast today) and use audio_url
  // the same way.
  const tracks: Track[] = useMemo(() => {
    if (mode === 'podcast') return (podcastSegments ?? []) as Track[]
    return activePosts as Track[]
  }, [mode, podcastSegments, activePosts])

  const tracksRef = useRef<Track[]>(tracks)
  useEffect(() => { tracksRef.current = tracks }, [tracks])

  const stopPlayback = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.src = ''
    }
    if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current)
  }, [])

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

  // Refetch feed on mount / feed change so we know whether a podcast is
  // already ready. Without this, the Podcast tab would always kick off a
  // fresh generation even when the user has a cached episode.
  useEffect(() => {
    if (!feedId) return
    let cancelled = false
    getFeed(feedId).then((feed) => {
      if (cancelled || !mountedRef.current) return
      setServerPosts((feed.posts as FeedPost[]) || null)
      setPodcastSegments((feed.podcast_segments as PodcastSegment[]) ?? null)
      setPodcastStatus(feed.podcast_status ?? null)
      // If podcast is ready, flip the tab so the user lands on it.
      if (feed.podcast_status === 'ready') setMode('podcast')
    }).catch(() => {
      // Non-fatal — the user can still trigger podcast generation manually.
    })
    return () => { cancelled = true }
  }, [feedId])

  // Reset playback state when feed, mode, or post-length changes. Each
  // mode has its own track list, so stale currentIndex pointers are
  // never what we want.
  useEffect(() => {
    setStatus(posts.length === 0 ? 'empty' : 'idle')
    setCurrentIndex(-1)
    setProgress({ current: 0, duration: 0 })
    stopPlayback()
  }, [feedId, posts.length, mode, stopPlayback])

  const playableIndices = useMemo(
    () =>
      tracks
        .map((t, i) => ({ t, i }))
        .filter(({ t }) => !t.deleted && t.audio_url)
        .map(({ i }) => i),
    [tracks],
  )

  const playAtIndex = useCallback((i: number) => {
    const audio = audioRef.current
    if (!audio) return
    const track = tracksRef.current[i]
    if (!track || !track.audio_url) return
    audio.src = track.audio_url
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
      setStatus('ready')
      setCurrentIndex(-1)
      setProgress({ current: 0, duration: 0 })
    }
  }, [playableIndices, currentIndex, playAtIndex])

  const goPrev = useCallback(() => {
    const prior = [...playableIndices].reverse().find((i) => i < currentIndex)
    if (prior !== undefined) playAtIndex(prior)
  }, [playableIndices, currentIndex, playAtIndex])

  const pollUntilFeedAudioReady = useCallback(async () => {
    if (!feedId || !mountedRef.current) return
    try {
      const feed = await getFeed(feedId)
      if (!mountedRef.current) return
      const fresh = (feed.posts as FeedPost[]) || []
      setServerPosts(fresh)
      setPodcastSegments((feed.podcast_segments as PodcastSegment[]) ?? null)
      setPodcastStatus(feed.podcast_status ?? null)

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
      pollTimeoutRef.current = setTimeout(pollUntilFeedAudioReady, 2500)
    } catch {
      pollTimeoutRef.current = setTimeout(pollUntilFeedAudioReady, 4000)
    }
  }, [feedId])

  const pollUntilPodcastReady = useCallback(async () => {
    if (!feedId || !mountedRef.current) return
    try {
      const feed = await getFeed(feedId)
      if (!mountedRef.current) return
      const segments = (feed.podcast_segments as PodcastSegment[]) ?? null
      setPodcastSegments(segments)
      setPodcastStatus(feed.podcast_status ?? null)

      if (feed.podcast_status === 'ready') {
        setStatus('ready')
        const firstPlayable = (segments ?? []).findIndex((s) => s.audio_url)
        if (firstPlayable >= 0 && segments) {
          const audio = audioRef.current
          if (audio) {
            audio.src = segments[firstPlayable].audio_url!
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
      if (feed.podcast_status === 'failed') {
        setStatus('failed')
        return
      }
      pollTimeoutRef.current = setTimeout(pollUntilPodcastReady, 2500)
    } catch {
      pollTimeoutRef.current = setTimeout(pollUntilPodcastReady, 4000)
    }
  }, [feedId])

  const handlePlayClick = useCallback(async () => {
    if (!feedId) return
    // Resume path — audio already loaded for the current mode.
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
      if (mode === 'podcast') {
        const resp = await requestFeedPodcast(feedId)
        if (!mountedRef.current) return
        if (resp.status === 'ready') {
          setStatus('generating')
          pollUntilPodcastReady()
        } else {
          setStatus('generating')
          pollTimeoutRef.current = setTimeout(pollUntilPodcastReady, 1500)
        }
      } else {
        const resp = await requestFeedAudio(feedId)
        if (!mountedRef.current) return
        if (resp.status === 'ready') {
          setStatus('generating')
          pollUntilFeedAudioReady()
        } else {
          setStatus('generating')
          pollTimeoutRef.current = setTimeout(pollUntilFeedAudioReady, 1500)
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('501') || msg.toLowerCase().includes('not configured')) {
        setStatus('unavailable')
      } else {
        setStatus('failed')
      }
    }
  }, [feedId, status, mode, currentIndex, playableIndices, playAtIndex, pollUntilFeedAudioReady, pollUntilPodcastReady])

  const handlePauseClick = useCallback(() => {
    audioRef.current?.pause()
    setStatus('paused')
  }, [])

  const handleTrackClick = useCallback((i: number) => {
    if (!tracks[i]?.audio_url) return
    playAtIndex(i)
  }, [tracks, playAtIndex])

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

  const podcastSegmentCount = podcastSegments?.length ?? 0

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
      <div className="flex items-center gap-2 mb-4">
        <Headphones size={20} className="text-gold" />
        <h1 className="text-[22px] font-semibold text-text">Listen</h1>
      </div>

      {/* Mode pill bar — segmented control between Feed and Podcast */}
      <div className="inline-flex rounded-full bg-bg-hover border border-border p-1 mb-5 text-sm">
        <button
          onClick={() => setMode('feed')}
          className={`px-4 py-1.5 rounded-full font-medium transition-colors ${
            mode === 'feed' ? 'bg-gold text-bg' : 'text-text-muted hover:text-text'
          }`}
        >
          Feed
        </button>
        <button
          onClick={() => setMode('podcast')}
          className={`px-4 py-1.5 rounded-full font-medium transition-colors flex items-center gap-1.5 ${
            mode === 'podcast' ? 'bg-gold text-bg' : 'text-text-muted hover:text-text'
          }`}
        >
          <Mic size={14} />
          Podcast
          {podcastStatus === 'ready' && mode !== 'podcast' && (
            <span className="w-1.5 h-1.5 rounded-full bg-green-500" aria-label="Ready" />
          )}
        </button>
      </div>

      {/* Hero card */}
      <div className="rounded-2xl border border-border bg-bg-hover p-5 mb-6">
        {mode === 'feed' ? (
          <div className="flex items-start gap-4">
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
                Feed — persona voices
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
        ) : (
          <div className="flex items-start gap-4">
            <div className="flex -space-x-3 shrink-0">
              <div
                className="w-12 h-12 rounded-full border-2 border-bg-hover flex items-center justify-center text-sm font-bold"
                style={{ backgroundColor: hostColor('host_a') + '30', color: hostColor('host_a'), zIndex: 10 }}
              >
                A
              </div>
              <div
                className="w-12 h-12 rounded-full border-2 border-bg-hover flex items-center justify-center text-sm font-bold"
                style={{ backgroundColor: hostColor('host_b') + '30', color: hostColor('host_b'), zIndex: 9 }}
              >
                B
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] uppercase tracking-wider text-text-muted font-semibold">
                Podcast — two hosts
              </div>
              <div className="text-lg text-text font-semibold mt-0.5">
                {podcastSegmentCount > 0
                  ? `${podcastSegmentCount} segments`
                  : 'Not generated yet'}
              </div>
              {isActive && currentIndex >= 0 && podcastSegments && (
                <div className="mt-2 text-xs text-text-muted flex items-center gap-1.5">
                  <Volume2 size={12} className="text-gold" />
                  Now playing segment {currentIndex + 1} of {podcastSegmentCount}
                </div>
              )}
              {!isActive && !isBusy && podcastSegmentCount === 0 && (
                <div className="mt-2 text-xs text-text-muted">
                  Press play to generate a two-host episode grounded in your papers.
                </div>
              )}
            </div>
          </div>
        )}

        {/* Main play button + progress */}
        <div className="mt-5 flex items-center gap-4">
          <button
            onClick={goPrev}
            disabled={!isActive || !playableIndices.some((i) => i < currentIndex)}
            aria-label="Previous"
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
              aria-label={status === 'paused' ? 'Resume' : mode === 'podcast' ? 'Play podcast' : 'Play feed'}
              className="w-14 h-14 rounded-full flex items-center justify-center bg-gold text-bg shadow-lg hover:scale-105 transition-transform"
            >
              <Play size={26} fill="currentColor" className="ml-1" />
            </button>
          )}

          <button
            onClick={advance}
            disabled={!isActive || !playableIndices.some((i) => i > currentIndex)}
            aria-label="Next"
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
            {mode === 'podcast'
              ? 'Producing a two-host episode — grounding in your papers, then synthesizing voices. ~1–2 minutes.'
              : 'Generating audio with ElevenLabs — this takes ~30 seconds for a full feed.'}
          </div>
        )}
        {status === 'idle' && !hasPlayableAudio && mode === 'feed' && (
          <div className="mt-3 text-xs text-text-muted">
            Press play to generate audio for this feed.
          </div>
        )}
        {status === 'failed' && (
          <div className="mt-3 flex items-center gap-2 text-sm text-persona-skeptic" role="alert">
            <AlertCircle size={16} />
            {mode === 'podcast' ? 'Podcast generation failed.' : 'Audio generation failed.'}
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
      {mode === 'feed' ? (
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
                  <div className="w-6 flex-shrink-0 flex items-center justify-center text-xs text-text-muted font-mono tabular-nums">
                    {isPlaying ? (
                      <Volume2 size={14} className="text-gold" />
                    ) : (
                      <span>{idx + 1}</span>
                    )}
                  </div>
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
      ) : (
        <ol className="list-none p-0 m-0 space-y-1">
          {(podcastSegments ?? []).map((seg, idx) => {
            const isCurrent = idx === currentIndex
            const hasAudio = Boolean(seg.audio_url)
            const isPlaying = isCurrent && status === 'playing'
            const color = hostColor(seg.speaker)
            return (
              <li key={idx}>
                <button
                  onClick={() => handleTrackClick(idx)}
                  disabled={!hasAudio}
                  className={`w-full flex items-start gap-3 px-3 py-2.5 rounded-lg text-left transition-colors ${
                    isCurrent ? 'bg-gold/10' : hasAudio ? 'hover:bg-bg-hover' : ''
                  } ${!hasAudio ? 'cursor-default opacity-60' : 'cursor-pointer'}`}
                >
                  <div className="w-6 flex-shrink-0 flex items-center justify-center text-xs text-text-muted font-mono tabular-nums pt-0.5">
                    {isPlaying ? (
                      <Volume2 size={14} className="text-gold" />
                    ) : (
                      <span>{idx + 1}</span>
                    )}
                  </div>
                  <div
                    className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
                    style={{
                      backgroundColor: color + '28',
                      border: `1.5px solid ${color}50`,
                      color,
                    }}
                  >
                    {seg.speaker === 'host_a' ? 'A' : 'B'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div
                      className={`text-sm font-semibold truncate ${isCurrent ? 'text-gold' : 'text-text'}`}
                    >
                      {hostLabel(seg.speaker)}
                    </div>
                    <div className="text-xs text-text-muted line-clamp-2">
                      {seg.text}
                    </div>
                  </div>
                  {!hasAudio && seg.audio_error && (
                    <div
                      className="text-[10px] text-text-subtle uppercase tracking-wider shrink-0"
                      title={seg.audio_error}
                    >
                      Skipped
                    </div>
                  )}
                </button>
              </li>
            )
          })}
          {podcastSegmentCount === 0 && !isBusy && (
            <li className="text-center text-sm text-text-muted py-8">
              No episode yet. Press play above to generate one.
            </li>
          )}
        </ol>
      )}

    </div>
  )
}
