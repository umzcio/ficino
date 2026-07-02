import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Play, Pause, SkipForward, SkipBack, Loader2, Headphones, AlertCircle,
  Volume2, VolumeX, Volume1, Volume, Mic, RotateCcw, RotateCw,
} from 'lucide-react'
import type { FeedPost, PodcastSegment } from '../../types'
import { getFeed, requestFeedAudio, requestFeedPodcast } from '../../lib/api'
import { usePersonas } from '../../hooks/usePersonas'
import { Slider } from '../_shared/primitives'
import { safeLocal } from '../../lib/safeLocal'

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
  return speaker === 'host_a' ? '#d4a84b' : '#6fa8c7'
}

function hostAvatar(speaker: 'host_a' | 'host_b'): string {
  // Root-absolute paths 404 under the self-host default base of
  // `/ficino/` (vite.config.ts) — prefix with BASE_URL like every other
  // component that references a public/ asset (App.tsx, MobileDrawer.tsx).
  const base = import.meta.env.BASE_URL
  return speaker === 'host_a' ? `${base}personas/host1.png` : `${base}personas/host2.png`
}

/**
 * Dedicated "Listen" page. Two modes on one shared <audio> element:
 *
 *   Feed mode: per-post persona-voiced clips. The original flow — track
 *   list with click-to-jump, skip/prev buttons, per-post hydration.
 *
 *   Podcast mode: ONE continuous mp3 rendered via ElevenLabs v3 Dialogue
 *   Mode with two hosts in natural conversation. No per-turn seeking —
 *   v3 gives us cross-speaker prosody and interruptions for free, and
 *   the unified audio file is the feature. Transcript is display-only.
 */
export function ListenView({ feedId, posts }: Props) {
  const personas = usePersonas()
  const [mode, setMode] = useState<Mode>('feed')
  const [status, setStatus] = useState<Status>(posts.length === 0 ? 'empty' : 'idle')
  const [currentIndex, setCurrentIndex] = useState<number>(-1)
  const [progress, setProgress] = useState<{ current: number; duration: number }>({ current: 0, duration: 0 })
  const [serverPosts, setServerPosts] = useState<FeedPost[] | null>(null)
  const [podcastSegments, setPodcastSegments] = useState<PodcastSegment[] | null>(null)
  const [podcastStatus, setPodcastStatus] = useState<'generating' | 'ready' | 'failed' | null>(null)
  const [podcastAudioUrl, setPodcastAudioUrl] = useState<string | null>(null)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  // Tracks the URL we actually loaded into the audio element, independent
  // of what audioRef.current.src reports. Reading .src back after setting
  // it to '' returns the document URL (spec: IDL attribute resolves
  // against the base URL), so we can't rely on `!audio.src` to mean
  // "cleared" — the podcast resume path used to check that and take the
  // wrong branch, refusing to load the podcast URL.
  const loadedSrcRef = useRef<string | null>(null)
  // Tracks which poller (if any) currently owns pollTimeoutRef. Each poll
  // captures this at entry and checks again before rescheduling; an
  // in-flight poll whose mode was switched out from under it bails
  // instead of stomping the new poller's scheduled timer. Without this,
  // mode-change + stopPlayback only clears the pending timer — if the
  // previous poll already fired and is awaiting getFeed, it will happily
  // reschedule itself on top of the new mode's timer when it resumes,
  // which is exactly the "second mode spins forever" bug.
  const activePollerRef = useRef<'feed' | 'podcast' | null>(null)

  const activePosts = serverPosts ?? posts
  const activePostsRef = useRef<FeedPost[]>(activePosts)
  useEffect(() => { activePostsRef.current = activePosts }, [activePosts])

  // Playback preferences — persisted per-browser so they stick across
  // sessions. Volume/mute/rate live on the <audio> element, which
  // preserves them across src changes, so we only need to (a) write them
  // once per change, (b) re-hydrate on mount from localStorage.
  const [volume, setVolume] = useState<number>(() => {
    if (typeof window === 'undefined') return 1
    const saved = safeLocal.get('ficino:listen:volume')
    const v = saved === null ? 1 : parseFloat(saved)
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1
  })
  const [muted, setMuted] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return safeLocal.get('ficino:listen:muted') === 'true'
  })
  const [playbackRate, setPlaybackRate] = useState<number>(() => {
    if (typeof window === 'undefined') return 1
    const saved = safeLocal.get('ficino:listen:rate')
    const r = saved === null ? 1 : parseFloat(saved)
    return Number.isFinite(r) && r > 0 ? r : 1
  })
  useEffect(() => {
    safeLocal.set('ficino:listen:volume', String(volume))
    if (audioRef.current) audioRef.current.volume = volume
  }, [volume])
  useEffect(() => {
    safeLocal.set('ficino:listen:muted', String(muted))
    if (audioRef.current) audioRef.current.muted = muted
  }, [muted])
  useEffect(() => {
    safeLocal.set('ficino:listen:rate', String(playbackRate))
    if (audioRef.current) audioRef.current.playbackRate = playbackRate
  }, [playbackRate])

  const stopPlayback = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      // removeAttribute + load is the only reliable way to drop the
      // current source; assigning audio.src = '' is a no-op on read.
      audioRef.current.removeAttribute('src')
      audioRef.current.load()
    }
    loadedSrcRef.current = null
    if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current)
    pollTimeoutRef.current = null
    activePollerRef.current = null
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

  // Refetch feed on mount / feed change to learn whether a podcast is
  // already generated. Without this, the Podcast tab would always kick
  // off a fresh generation even when a cached episode exists.
  useEffect(() => {
    if (!feedId) return
    let cancelled = false
    getFeed(feedId).then((feed) => {
      if (cancelled || !mountedRef.current) return
      setServerPosts((feed.posts as FeedPost[]) || null)
      setPodcastSegments((feed.podcast_segments as PodcastSegment[]) ?? null)
      setPodcastStatus(feed.podcast_status ?? null)
      setPodcastAudioUrl(feed.podcast_audio_url ?? null)
      if (feed.podcast_status === 'ready') setMode('podcast')
    }).catch(() => { /* non-fatal */ })
    return () => { cancelled = true }
  }, [feedId])

  // Hard reset when the user actually switches modes or feeds. Runs
  // only on those discrete user actions — NOT on incremental server
  // data updates. A prior iteration folded podcastAudioUrl/serverPosts
  // into the deps so the status could be promoted to 'ready' after the
  // mount fetch arrived, but that made the effect fire on every poll
  // iteration (serverPosts is updated every 2.5s during generation),
  // which called stopPlayback() and killed the in-flight poller mid-
  // flight. Keep the reset surgical; a second effect below promotes
  // idle → ready without resetting playback state.
  useEffect(() => {
    setStatus(posts.length === 0 ? 'empty' : 'idle')
    setCurrentIndex(-1)
    setProgress({ current: 0, duration: 0 })
    stopPlayback()
  }, [feedId, posts.length, mode, stopPlayback])

  // Once we learn that server-side audio for the current mode already
  // exists, skip straight to 'ready' so clicking Play jumps into the
  // resume path instead of flashing "Requesting…". Guarded by status
  // === 'idle' so it can't interfere with an active generation or
  // playback cycle.
  useEffect(() => {
    if (status !== 'idle') return
    if (mode === 'podcast' && podcastAudioUrl) {
      setStatus('ready')
    } else if (mode === 'feed') {
      const hasFeedAudio = (serverPosts ?? posts).some(p => !p.deleted && p.audio_url)
      if (hasFeedAudio) setStatus('ready')
    }
  }, [status, mode, podcastAudioUrl, serverPosts, posts])

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
    loadedSrcRef.current = post.audio_url
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

  const playPodcast = useCallback((url: string) => {
    const audio = audioRef.current
    if (!audio) {
      console.warn('[listen] playPodcast: no audio element')
      setStatus('failed')
      return
    }
    audio.src = url
    loadedSrcRef.current = url
    audio.play()
      .then(() => {
        if (!mountedRef.current) return
        setStatus('playing')
      })
      .catch((err) => {
        if (!mountedRef.current) return
        // Surface failures — the prior "silently flip to paused" hid
        // real problems (bad URL, CORS, unplayable format) behind a
        // button that just looked untouched.
        console.warn('[listen] podcast play() rejected', err)
        setStatus('failed')
      })
  }, [])

  const advance = useCallback(() => {
    if (mode === 'podcast') {
      // One continuous file — "advance" means the episode ended.
      setStatus('ready')
      setProgress({ current: 0, duration: 0 })
      return
    }
    const next = playableIndices.find((i) => i > currentIndex)
    if (next !== undefined) {
      playAtIndex(next)
    } else {
      setStatus('ready')
      setCurrentIndex(-1)
      setProgress({ current: 0, duration: 0 })
    }
  }, [mode, playableIndices, currentIndex, playAtIndex])

  const goPrev = useCallback(() => {
    if (mode === 'podcast') return
    const prior = [...playableIndices].reverse().find((i) => i < currentIndex)
    if (prior !== undefined) playAtIndex(prior)
  }, [mode, playableIndices, currentIndex, playAtIndex])

  const pollUntilFeedAudioReady = useCallback(async () => {
    if (!feedId || !mountedRef.current) return
    // Bail if the mode was switched out from under us while a prior
    // iteration was awaiting getFeed. Without this, the stale poll would
    // stomp the new mode's state + poll timer.
    if (activePollerRef.current !== 'feed') return
    try {
      const feed = await getFeed(feedId)
      if (!mountedRef.current) return
      if (activePollerRef.current !== 'feed') return
      const fresh = (feed.posts as FeedPost[]) || []
      setServerPosts(fresh)
      setPodcastSegments((feed.podcast_segments as PodcastSegment[]) ?? null)
      setPodcastStatus(feed.podcast_status ?? null)
      setPodcastAudioUrl(feed.podcast_audio_url ?? null)

      if (feed.audio_status === 'ready') {
        setStatus('ready')
        const firstPlayable = fresh.findIndex((p) => !p.deleted && p.audio_url)
        if (firstPlayable >= 0) {
          // Route through playAtIndex rather than duplicating the
          // src-assignment + play() here — the inline duplication is
          // what let this path drift out of sync with loadedSrcRef in
          // the first place (FE-2), causing pause->resume to restart
          // the clip from 0:00 instead of resuming.
          //
          // playAtIndex reads activePostsRef, which only syncs to the
          // serverPosts state we just set on the NEXT render (via the
          // effect at the top of the component) — sync it now so the
          // just-fetched posts are visible to the lookup. Without this
          // the ref still holds the pre-generation posts (no audio_url),
          // playAtIndex's `!post.audio_url` guard fires, and auto-play
          // never starts.
          activePostsRef.current = fresh
          playAtIndex(firstPlayable)
        }
        activePollerRef.current = null
        return
      }
      if (feed.audio_status === 'failed') {
        setStatus('failed')
        activePollerRef.current = null
        return
      }
      if (activePollerRef.current !== 'feed') return
      pollTimeoutRef.current = setTimeout(pollUntilFeedAudioReady, 2500)
    } catch {
      if (activePollerRef.current !== 'feed') return
      pollTimeoutRef.current = setTimeout(pollUntilFeedAudioReady, 4000)
    }
  }, [feedId, playAtIndex])

  const pollUntilPodcastReady = useCallback(async () => {
    if (!feedId || !mountedRef.current) return
    if (activePollerRef.current !== 'podcast') return
    try {
      const feed = await getFeed(feedId)
      if (!mountedRef.current) return
      if (activePollerRef.current !== 'podcast') return
      setPodcastSegments((feed.podcast_segments as PodcastSegment[]) ?? null)
      setPodcastStatus(feed.podcast_status ?? null)
      setPodcastAudioUrl(feed.podcast_audio_url ?? null)

      if (feed.podcast_status === 'ready' && feed.podcast_audio_url) {
        setStatus('ready')
        playPodcast(feed.podcast_audio_url)
        activePollerRef.current = null
        return
      }
      if (feed.podcast_status === 'failed') {
        setStatus('failed')
        activePollerRef.current = null
        return
      }
      if (activePollerRef.current !== 'podcast') return
      pollTimeoutRef.current = setTimeout(pollUntilPodcastReady, 2500)
    } catch {
      if (activePollerRef.current !== 'podcast') return
      pollTimeoutRef.current = setTimeout(pollUntilPodcastReady, 4000)
    }
  }, [feedId, playPodcast])

  const handlePlayClick = useCallback(async () => {
    if (!feedId) {
      console.warn('[listen] handlePlayClick: no feedId')
      return
    }
    console.info('[listen] play click', { mode, status, podcastAudioUrl: !!podcastAudioUrl, playableCount: playableIndices.length })

    // Dispatch on data, not status. Status can lag a mode switch (the
    // reset effect runs post-render; clicking immediately after a tab
    // change would see stale status otherwise). If we have audio for
    // the current mode, play it. If not, kick off generation.
    if (mode === 'podcast') {
      if (podcastAudioUrl) {
        if (loadedSrcRef.current === podcastAudioUrl) {
          const audio = audioRef.current
          if (!audio) {
            playPodcast(podcastAudioUrl)
            return
          }
          audio.play()
            .then(() => { if (mountedRef.current) setStatus('playing') })
            .catch((err) => {
              console.warn('[listen] podcast resume play() rejected', err)
              playPodcast(podcastAudioUrl)
            })
        } else {
          playPodcast(podcastAudioUrl)
        }
        return
      }
      // Nothing generated yet — dispatch podcast task.
      stopPlayback()
      activePollerRef.current = 'podcast'
      setStatus('requesting')
      try {
        const resp = await requestFeedPodcast(feedId)
        if (!mountedRef.current || activePollerRef.current !== 'podcast') return
        setStatus('generating')
        if (resp.status === 'ready') pollUntilPodcastReady()
        else pollTimeoutRef.current = setTimeout(pollUntilPodcastReady, 1500)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn('[listen] requestFeedPodcast failed', msg)
        if (msg.includes('501') || msg.toLowerCase().includes('not configured')) {
          setStatus('unavailable')
        } else {
          setStatus('failed')
        }
      }
      return
    }

    // Feed mode.
    if (playableIndices.length > 0) {
      const target = currentIndex >= 0 ? currentIndex : playableIndices[0]
      const expected = activePosts[target]?.audio_url
      if (expected && loadedSrcRef.current === expected) {
        audioRef.current?.play()
          .then(() => { if (mountedRef.current) setStatus('playing') })
          .catch((err) => {
            console.warn('[listen] feed resume play() rejected', err)
            playAtIndex(target)
          })
      } else {
        playAtIndex(target)
      }
      return
    }
    // Nothing generated yet — dispatch feed audio task.
    stopPlayback()
    activePollerRef.current = 'feed'
    setStatus('requesting')
    try {
      const resp = await requestFeedAudio(feedId)
      if (!mountedRef.current || activePollerRef.current !== 'feed') return
      setStatus('generating')
      if (resp.status === 'ready') pollUntilFeedAudioReady()
      else pollTimeoutRef.current = setTimeout(pollUntilFeedAudioReady, 1500)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('501') || msg.toLowerCase().includes('not configured')) {
        setStatus('unavailable')
      } else {
        setStatus('failed')
      }
    }
  }, [feedId, status, mode, currentIndex, playableIndices, playAtIndex, playPodcast, podcastAudioUrl, pollUntilFeedAudioReady, pollUntilPodcastReady, stopPlayback, activePosts])

  const handlePauseClick = useCallback(() => {
    audioRef.current?.pause()
    setStatus('paused')
  }, [])

  const handleTrackClick = useCallback((i: number) => {
    if (!activePosts[i]?.audio_url) return
    playAtIndex(i)
  }, [activePosts, playAtIndex])

  // Skip / seek / speed helpers. All operate on the live audioRef so
  // they work equally in feed and podcast mode.
  const skipBy = useCallback((deltaSec: number) => {
    const audio = audioRef.current
    if (!audio) return
    const dur = audio.duration
    const target = audio.currentTime + deltaSec
    audio.currentTime = Math.max(0, Number.isFinite(dur) ? Math.min(dur, target) : target)
  }, [])

  const seekTo = useCallback((t: number) => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = Math.max(0, t)
    // Optimistic progress update so the slider thumb doesn't snap back
    // to the old position while waiting for the next timeupdate event.
    setProgress(p => ({ ...p, current: t }))
  }, [])

  const cyclePlaybackRate = useCallback(() => {
    const rates = [1, 1.25, 1.5, 2]
    setPlaybackRate(r => {
      const idx = rates.indexOf(r)
      return rates[(idx + 1) % rates.length]
    })
  }, [])

  const toggleMute = useCallback(() => setMuted(m => !m), [])

  // Keyboard shortcuts while the Listen view is mounted. Space toggles
  // play/pause, ←/→ skip 15s, ↑/↓ nudge volume ±5%, M toggles mute.
  // Ignored while focus is in an input, textarea, or contenteditable
  // element so a stray space in the compose box never hijacks playback.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      switch (e.key) {
        case ' ':
        case 'Spacebar':
          e.preventDefault()
          if (status === 'playing') handlePauseClick()
          else if (status === 'ready' || status === 'paused' || status === 'idle') handlePlayClick()
          break
        case 'ArrowLeft':
          if (status === 'playing' || status === 'paused') { e.preventDefault(); skipBy(-15) }
          break
        case 'ArrowRight':
          if (status === 'playing' || status === 'paused') { e.preventDefault(); skipBy(15) }
          break
        case 'ArrowUp':
          e.preventDefault()
          setVolume(v => Math.min(1, +(v + 0.05).toFixed(2)))
          if (muted) setMuted(false)
          break
        case 'ArrowDown':
          e.preventDefault()
          setVolume(v => Math.max(0, +(v - 0.05).toFixed(2)))
          break
        case 'm':
        case 'M':
          toggleMute()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [status, muted, handlePlayClick, handlePauseClick, skipBy, toggleMute])

  const isBusy = status === 'requesting' || status === 'generating'
  const isActive = status === 'playing' || status === 'paused'
  const hasPlayableAudio = mode === 'podcast' ? !!podcastAudioUrl : playableIndices.length > 0
  const uniquePersonas = useMemo(
    () => Array.from(new Set(activePosts.map((p) => p.persona).filter(Boolean))),
    [activePosts],
  )

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
          // Re-apply preferences on every new source. volume / muted /
          // playbackRate do persist on an HTMLMediaElement across src
          // changes per spec, but browsers differ on how aggressively
          // they snap back to defaults (Safari has historically reset
          // playbackRate on src change), so we mirror state explicitly.
          el.volume = volume
          el.muted = muted
          el.playbackRate = playbackRate
        }}
      />

      <div className="flex items-center gap-2 mb-4">
        <Headphones size={20} className="text-gold" />
        <h1 className="text-[22px] font-semibold text-text">Listen</h1>
      </div>

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
              <img
                src={hostAvatar('host_a')}
                alt={hostLabel('host_a')}
                className="w-12 h-12 rounded-full border-2 border-bg-hover object-cover"
                style={{ zIndex: 10 }}
              />
              <img
                src={hostAvatar('host_b')}
                alt={hostLabel('host_b')}
                className="w-12 h-12 rounded-full border-2 border-bg-hover object-cover"
                style={{ zIndex: 9 }}
              />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] uppercase tracking-wider text-text-muted font-semibold">
                Podcast — two hosts, one take
              </div>
              <div className="text-lg text-text font-semibold mt-0.5">
                {podcastStatus === 'ready'
                  ? `${podcastSegmentCount}-turn episode`
                  : 'Not generated yet'}
              </div>
              {!isActive && !isBusy && podcastStatus !== 'ready' && (
                <div className="mt-2 text-xs text-text-muted">
                  Press play for a NotebookLM-style dialogue grounded in your papers.
                </div>
              )}
            </div>
          </div>
        )}

        <div className="mt-5 flex items-center gap-4">
          {mode === 'feed' && (
            <button
              onClick={goPrev}
              disabled={!isActive || !playableIndices.some((i) => i < currentIndex)}
              aria-label="Previous"
              className="p-2 rounded-full text-text-mid hover:text-text hover:bg-border/50 disabled:opacity-25 disabled:hover:bg-transparent transition-colors"
            >
              <SkipBack size={22} />
            </button>
          )}

          {/* Skip back 15s — podcast mode only. In feed mode the
              flanking buttons already hop between posts, which is the
              more useful affordance there. */}
          {mode === 'podcast' && (
            <button
              onClick={() => skipBy(-15)}
              disabled={!isActive}
              aria-label="Skip back 15 seconds"
              title="Skip back 15s (←)"
              className="relative p-2 rounded-full text-text-mid hover:text-text hover:bg-border/50 disabled:opacity-25 disabled:hover:bg-transparent transition-colors"
            >
              <RotateCcw size={22} />
              <span className="absolute inset-0 flex items-center justify-center text-[9px] font-bold pointer-events-none mt-0.5">15</span>
            </button>
          )}

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

          {mode === 'podcast' && (
            <button
              onClick={() => skipBy(15)}
              disabled={!isActive}
              aria-label="Skip forward 15 seconds"
              title="Skip forward 15s (→)"
              className="relative p-2 rounded-full text-text-mid hover:text-text hover:bg-border/50 disabled:opacity-25 disabled:hover:bg-transparent transition-colors"
            >
              <RotateCw size={22} />
              <span className="absolute inset-0 flex items-center justify-center text-[9px] font-bold pointer-events-none mt-0.5">15</span>
            </button>
          )}

          {mode === 'feed' && (
            <button
              onClick={advance}
              disabled={!isActive || !playableIndices.some((i) => i > currentIndex)}
              aria-label="Next"
              className="p-2 rounded-full text-text-mid hover:text-text hover:bg-border/50 disabled:opacity-25 disabled:hover:bg-transparent transition-colors"
            >
              <SkipForward size={22} />
            </button>
          )}

          <div className="flex-1 flex items-center gap-2 text-xs text-text-muted font-mono tabular-nums min-w-0">
            <span className="shrink-0">{formatTime(progress.current)}</span>
            {/* Seekable progress. The gradient on the track shows
                progress so even browsers without ::-moz-range-progress
                support render a filled bar; the thumb is a small gold
                circle. Disabled while duration is unknown (pre-load). */}
            <Slider
              value={Math.min(progress.current, progress.duration || 0)}
              min={0}
              max={progress.duration || 1}
              step={0.1}
              onChange={seekTo}
              disabled={!progress.duration || !isActive}
              ariaLabel="Seek"
              accent="gold"
              thumbSize="md"
              thumbShadow
              showValue={false}
              fillPercent={progress.duration ? Math.min(100, (progress.current / progress.duration) * 100) : 0}
            />
            <span className="shrink-0">{formatTime(progress.duration)}</span>
          </div>
        </div>

        {/* Secondary controls — volume + speed. Compact row; doesn't
            appear until the user has actually started playing, so the
            idle layout stays clean. */}
        {(isActive || status === 'ready') && (
          <div className="mt-3 flex items-center gap-4 text-xs text-text-muted">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={toggleMute}
                aria-label={muted ? 'Unmute' : 'Mute'}
                title={muted ? 'Unmute (M)' : 'Mute (M)'}
                className="p-1 rounded-full hover:text-text hover:bg-border/50 bg-transparent border-none cursor-pointer transition-colors"
              >
                {muted || volume === 0 ? (
                  <VolumeX size={16} />
                ) : volume < 0.33 ? (
                  <Volume size={16} />
                ) : volume < 0.67 ? (
                  <Volume1 size={16} />
                ) : (
                  <Volume2 size={16} />
                )}
              </button>
              <Slider
                value={muted ? 0 : volume}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => {
                  setVolume(v)
                  if (v > 0 && muted) setMuted(false)
                }}
                ariaLabel="Volume"
                accent="muted"
                thumbSize="sm"
                showValue={false}
                widthClassName="w-24"
                fillPercent={(muted ? 0 : volume) * 100}
              />
            </div>
            <button
              type="button"
              onClick={cyclePlaybackRate}
              aria-label={`Playback speed ${playbackRate}x`}
              title="Cycle playback speed"
              className="ml-auto font-bold text-text-mid hover:text-text bg-bg border border-border rounded-md px-2 py-0.5 cursor-pointer tabular-nums min-w-[42px]"
            >
              {playbackRate}x
            </button>
          </div>
        )}

        {status === 'requesting' && (
          <div className="mt-3 text-xs text-text-muted" role="status" aria-live="polite">
            Requesting audio…
          </div>
        )}
        {status === 'generating' && (
          <div className="mt-3 text-xs text-text-muted" role="status" aria-live="polite">
            {mode === 'podcast'
              ? 'Producing the episode — retrieving chunks, scripting dialogue, rendering with v3. ~1 minute.'
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
            {mode === 'podcast' ? 'Podcast playback or generation failed.' : 'Audio playback or generation failed.'}
            <button
              onClick={() => {
                // Clear any loaded src so the retry doesn't try to
                // reuse a stale/expired URL, then reset to idle and
                // let the next Play click re-run dispatch.
                stopPlayback()
                setStatus('idle')
              }}
              className="underline hover:no-underline ml-1"
            >
              Try again
            </button>
          </div>
        )}
      </div>

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
        // Podcast mode: scrolling transcript. The actual audio is one
        // continuous mp3 — transcript lines are display-only; no
        // per-turn seeking (v3 doesn't return alignments).
        <div>
          {podcastSegmentCount > 0 ? (
            <div className="px-1">
              <div className="text-[11px] uppercase tracking-wider text-text-muted font-semibold mb-3">
                Transcript
              </div>
              <ol className="list-none p-0 m-0 space-y-3">
                {(podcastSegments ?? []).map((seg) => {
                  const color = hostColor(seg.speaker)
                  return (
                    <li key={seg.index} className="flex items-start gap-3">
                      <img
                        src={hostAvatar(seg.speaker)}
                        alt={hostLabel(seg.speaker)}
                        className="w-8 h-8 rounded-full shrink-0 mt-0.5 object-cover"
                        style={{ border: `1.5px solid ${color}50` }}
                      />
                      <div className="flex-1 min-w-0">
                        <div
                          className="text-[11px] font-semibold tracking-wide"
                          style={{ color }}
                        >
                          {hostLabel(seg.speaker)}
                        </div>
                        <div className="text-sm text-text leading-relaxed">
                          {seg.text}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ol>
            </div>
          ) : (
            !isBusy && (
              <div className="text-center text-sm text-text-muted py-8">
                No episode yet. Press play above to generate one.
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
}
