// Feed posts come from model output. The server keeps only well-typed model fields, but a post stored before that
// check (or read from the offline cache) can carry any JSON type, and one card that throws while rendering would
// unmount the whole app. These helpers make every field PostCard renders as text a string (or null) first.
import type { FeedPost } from '../types'

/** A string as is; a finite number or a boolean as its text; anything else as ''. */
export function asText(v: unknown): string {
  if (typeof v === 'string') return v
  if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') return String(v)
  return ''
}

const TEXT_FIELDS = ['content', 'paper_ref', 'quoting_handle', 'quoting_content', 'replying_to', 'post_type'] as const

/** The post itself when its rendered fields are well typed, else a copy with them made so. */
export function safeFeedPost(post: FeedPost): FeedPost {
  const raw = post as unknown as Record<string, unknown>
  const fixed: Record<string, unknown> = {}
  for (const f of TEXT_FIELDS) {
    const v = raw[f]
    if (v !== undefined && v !== null && typeof v !== 'string') fixed[f] = asText(v)
  }
  const tp = raw.thread_posts
  if (tp !== undefined && !(Array.isArray(tp) && tp.every(x => typeof x === 'string'))) {
    fixed.thread_posts = Array.isArray(tp) ? tp.map(asText).filter(x => x !== '') : undefined
  }
  const tc = raw.thread_count
  if (tc !== undefined && !(typeof tc === 'number' && Number.isFinite(tc))) fixed.thread_count = undefined
  return Object.keys(fixed).length === 0 ? post : ({ ...post, ...fixed } as FeedPost)
}

/**
 * `table[key]` only when the table has that key itself: a model-written key such as `__proto__` or `constructor`
 * must not reach Object.prototype's members. Anything else (including a non-string key) is undefined.
 */
export function ownEntry<T>(table: Readonly<Record<string, T>>, key: unknown): T | undefined {
  return typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined
}
