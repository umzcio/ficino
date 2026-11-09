// Post media URLs come from stored posts. The server builds them only from its own ids, but a post read from the
// offline cache (or served by an older server) can carry a URL a model wrote, and the browser would fetch it on
// sight. So media is loaded only from the API's own paths: a figure from the relative `/figures/...` path the server
// signs, prefixed here with the API base, and audio from the `<API base>/media/...` URL the server returns. Any other
// value is ignored: the card shows "Figure not available", the post has no audio.
import type { FeedPost } from '../types'

export const API_BASE: string = import.meta.env.VITE_API_BASE || '/ficino/api'

/** No backslash, whitespace or control character anywhere, and no `..` (plain or percent-encoded) in the path. */
function safePath(v: string): boolean {
  if (v.includes('\\') || /\s/.test(v)) return false
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return false
  }
  const path = v.split(/[?#]/, 1)[0]!
  return !/\.\.|%2e/i.test(path)
}

/** The `<img>` src for a post's figure_url, or '' when it is not a server-signed figure path. */
export function figureSrc(v: unknown): string {
  if (typeof v !== 'string' || !v.startsWith('/figures/') || !safePath(v)) return ''
  return `${API_BASE}${v}`
}

/** A post or podcast audio URL as given when it is the API's own `/media/` URL, else null. */
export function apiMediaSrc(v: unknown): string | null {
  if (typeof v !== 'string' || !v.startsWith(`${API_BASE}/media/`) || !safePath(v)) return null
  return v
}

/** The posts with every audio_url that apiMediaSrc rejects set to null; a post with nothing to drop is kept as is. */
export function withSafeAudio(posts: FeedPost[]): FeedPost[] {
  return posts.map((p) => {
    if (!p || typeof p !== 'object') return p
    const v = (p as { audio_url?: unknown }).audio_url
    if (v === undefined || v === null || apiMediaSrc(v) !== null) return p
    return { ...p, audio_url: null }
  })
}
