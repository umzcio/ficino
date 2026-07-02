import { getDB } from './offline-db'
import type { Feed, Paper, PaperSummary, GroupChat, Workspace } from '../types'
import type { BookmarkItem, AnnotationItem, AlertItem, PersonaData, UserPost, FeedLikes } from './api'

// ── Generic network-first helper ────────────────────────────────────────────

export async function networkFirst<T>(
  networkFn: () => Promise<T>,
  cacheFn: (data: T) => Promise<void>,
  fallbackFn: () => Promise<T | undefined>,
): Promise<T> {
  try {
    const data = await networkFn()
    // Fire-and-forget cache write so it doesn't slow down the UI
    cacheFn(data).catch(() => {})
    return data
  } catch (err) {
    if (!navigator.onLine) {
      const cached = await fallbackFn()
      if (cached !== undefined) return cached
    }
    throw err
  }
}

// ── Feeds ───────────────────────────────────────────────────────────────────

export async function cacheFeeds(feeds: Feed[], workspaceId?: string) {
  const db = await getDB()
  const tx = db.transaction('feeds', 'readwrite')
  // Upsert pattern: put all incoming records, then delete stale keys that
  // no longer appear in the new set. Without the delete step, a feed
  // removed on the server (e.g. when the last paper in a workspace is
  // deleted and papers.py:256-261 cascades) lingers in IndexedDB and
  // resurrects on any offline load via getCachedFeeds.
  const newKeys = new Set(feeds.map((f) => f.id))
  const existingKeys = workspaceId
    ? await tx.store.index('by-workspace').getAllKeys(workspaceId)
    : await tx.store.getAllKeys()
  const ops: Promise<unknown>[] = [
    ...feeds.map((f) => tx.store.put({ ...f, workspaceId })),
    ...existingKeys
      .filter((k) => !newKeys.has(String(k)))
      .map((k) => tx.store.delete(k)),
  ]
  await Promise.all(ops)
  await tx.done
}

export async function cacheFeed(feed: Feed, workspaceId?: string) {
  const db = await getDB()
  await db.put('feeds', { ...feed, workspaceId })
}

export async function getCachedFeeds(workspaceId?: string): Promise<Feed[]> {
  const db = await getDB()
  if (workspaceId) {
    return db.getAllFromIndex('feeds', 'by-workspace', workspaceId)
  }
  return db.getAll('feeds')
}

// ── Papers ──────────────────────────────────────────────────────────────────

export async function cachePapers(papers: Paper[], workspaceId?: string) {
  const db = await getDB()
  const tx = db.transaction('papers', 'readwrite')
  // See cacheFeeds for the rationale — same upsert-then-delete shape so a
  // server-side delete propagates to the IndexedDB cache.
  const newKeys = new Set(papers.map((p) => p.id))
  const existingKeys = workspaceId
    ? await tx.store.index('by-workspace').getAllKeys(workspaceId)
    : await tx.store.getAllKeys()
  const ops: Promise<unknown>[] = [
    ...papers.map((p) => tx.store.put({ ...p, workspaceId })),
    ...existingKeys
      .filter((k) => !newKeys.has(String(k)))
      .map((k) => tx.store.delete(k)),
  ]
  await Promise.all(ops)
  await tx.done
}

export async function getCachedPapers(workspaceId?: string): Promise<Paper[]> {
  const db = await getDB()
  if (workspaceId) {
    return db.getAllFromIndex('papers', 'by-workspace', workspaceId)
  }
  return db.getAll('papers')
}

// ── Paper summaries / group chats ───────────────────────────────────────────
// R10 FE-5: PaperChat/GroupChatView had no offline fallback despite these
// stores existing since v1 — a failed initial fetch just spun forever with
// nothing to fall back to. Single-record put/get (keyed by paper_id / id
// respectively) rather than the list upsert-then-delete shape above; these
// are read one at a time by the detail views, never listed.

export async function cachePaperSummary(summary: PaperSummary): Promise<void> {
  const db = await getDB()
  await db.put('paperSummaries', summary)
}

export async function getCachedPaperSummary(paperId: string): Promise<PaperSummary | undefined> {
  const db = await getDB()
  return db.get('paperSummaries', paperId)
}

export async function cacheGroupChat(chat: GroupChat): Promise<void> {
  const db = await getDB()
  await db.put('groupChats', chat)
}

export async function getCachedGroupChat(id: string): Promise<GroupChat | undefined> {
  const db = await getDB()
  return db.get('groupChats', id)
}

// ── Bookmarks ───────────────────────────────────────────────────────────────

export async function cacheBookmarks(bookmarks: BookmarkItem[]) {
  const db = await getDB()
  const tx = db.transaction('bookmarks', 'readwrite')

  // Upsert pattern: put all incoming records (put overwrites by key), then
  // delete keys that no longer appear in the new set. Avoids the clear-then-put
  // race where a failed put mid-loop leaves IndexedDB empty.
  const newKeys = new Set(bookmarks.map((b) => b.id))
  const existingKeys = await tx.store.getAllKeys()

  const ops: Promise<unknown>[] = [
    ...bookmarks.map((b) => tx.store.put(b)),
    ...existingKeys
      .filter((k) => !newKeys.has(String(k)))
      .map((k) => tx.store.delete(k)),
  ]
  await Promise.all(ops)
  await tx.done
}

export async function getCachedBookmarks(): Promise<BookmarkItem[]> {
  const db = await getDB()
  return db.getAll('bookmarks')
}

// ── Annotations ─────────────────────────────────────────────────────────────

export async function cacheAnnotations(annotations: AnnotationItem[]) {
  const db = await getDB()
  const tx = db.transaction('annotations', 'readwrite')

  // Upsert pattern: put all incoming records (put overwrites by key), then
  // delete keys that no longer appear in the new set. Avoids the clear-then-put
  // race where a failed put mid-loop leaves IndexedDB empty.
  const newKeys = new Set(annotations.map((a) => `${a.feed_id}:${a.post_index}`))
  const existingKeys = await tx.store.getAllKeys()

  const ops: Promise<unknown>[] = [
    ...annotations.map((a) =>
      tx.store.put({ ...a, _key: `${a.feed_id}:${a.post_index}` }),
    ),
    ...existingKeys
      .filter((k) => !newKeys.has(String(k)))
      .map((k) => tx.store.delete(k)),
  ]
  await Promise.all(ops)
  await tx.done
}

export async function getCachedAnnotations(): Promise<AnnotationItem[]> {
  const db = await getDB()
  const items = await db.getAll('annotations')
  return items.map(({ _key: _, ...rest }) => rest as unknown as AnnotationItem)
}

// ── Likes ───────────────────────────────────────────────────────────────────

export async function cacheLikes(feedId: string, likes: FeedLikes) {
  const db = await getDB()
  await db.put('likes', { ...likes, feedId })
}

export async function getCachedLikes(feedId: string): Promise<FeedLikes | undefined> {
  const db = await getDB()
  const result = await db.get('likes', feedId)
  if (!result) return undefined
  const { feedId: _, ...rest } = result
  return rest as FeedLikes
}

// ── Personas ────────────────────────────────────────────────────────────────

export async function cachePersonas(personas: PersonaData[]) {
  const db = await getDB()
  const tx = db.transaction('personas', 'readwrite')

  // Upsert pattern: put all incoming records (put overwrites by key), then
  // delete keys that no longer appear in the new set. Avoids the clear-then-put
  // race where a failed put mid-loop leaves IndexedDB empty.
  const newKeys = new Set(personas.map((p) => p.key))
  const existingKeys = await tx.store.getAllKeys()

  const ops: Promise<unknown>[] = [
    ...personas.map((p) => tx.store.put(p)),
    ...existingKeys
      .filter((k) => !newKeys.has(String(k)))
      .map((k) => tx.store.delete(k)),
  ]
  await Promise.all(ops)
  await tx.done
}

export async function getCachedPersonas(): Promise<PersonaData[]> {
  const db = await getDB()
  return db.getAll('personas')
}

// ── Workspaces ──────────────────────────────────────────────────────────────

export async function cacheWorkspaces(workspaces: Workspace[]) {
  const db = await getDB()
  const tx = db.transaction('workspaces', 'readwrite')

  // Upsert pattern: put all incoming records (put overwrites by key), then
  // delete keys that no longer appear in the new set. Avoids the clear-then-put
  // race where a failed put mid-loop leaves IndexedDB empty.
  const newKeys = new Set(workspaces.map((w) => w.id))
  const existingKeys = await tx.store.getAllKeys()

  const ops: Promise<unknown>[] = [
    ...workspaces.map((w) => tx.store.put(w)),
    ...existingKeys
      .filter((k) => !newKeys.has(String(k)))
      .map((k) => tx.store.delete(k)),
  ]
  await Promise.all(ops)
  await tx.done
}

export async function getCachedWorkspaces(): Promise<Workspace[]> {
  const db = await getDB()
  return db.getAll('workspaces')
}

// ── Settings ────────────────────────────────────────────────────────────────

export async function cacheSettings(data: Record<string, unknown>) {
  const db = await getDB()
  await db.put('settings', { _key: 'user', data })
}

export async function getCachedSettings(): Promise<Record<string, unknown> | undefined> {
  const db = await getDB()
  const result = await db.get('settings', 'user')
  return result?.data
}

// ── User Posts ──────────────────────────────────────────────────────────────

export async function cacheUserPosts(posts: UserPost[], workspaceId?: string) {
  const db = await getDB()
  const tx = db.transaction('userPosts', 'readwrite')
  // Upsert pattern, matching the rest of this file. The previous in-loop
  // `await tx.store.put()` was exactly the race the sibling comments warn
  // about — the transaction can auto-commit before the final put, leaving
  // the cached list half-written. Collect all ops into a single
  // Promise.all, then await tx.done once.
  const newKeys = new Set(posts.map((p) => p.id))
  const existingKeys = workspaceId
    ? await tx.store.index('by-workspace').getAllKeys(workspaceId)
    : await tx.store.getAllKeys()
  const ops: Promise<unknown>[] = [
    ...posts.map((p) => tx.store.put({ ...p, workspaceId })),
    ...existingKeys
      .filter((k) => !newKeys.has(String(k)))
      .map((k) => tx.store.delete(k)),
  ]
  await Promise.all(ops)
  await tx.done
}

export async function getCachedUserPosts(workspaceId?: string): Promise<UserPost[]> {
  const db = await getDB()
  if (workspaceId) {
    return db.getAllFromIndex('userPosts', 'by-workspace', workspaceId)
  }
  return db.getAll('userPosts')
}

export async function clearCachedUserPosts(): Promise<void> {
  const db = await getDB()
  const tx = db.transaction('userPosts', 'readwrite')
  await tx.store.clear()
  await tx.done
}

export async function clearCachedPapers(): Promise<void> {
  const db = await getDB()
  const tx = db.transaction('papers', 'readwrite')
  await tx.store.clear()
  await tx.done
}

export async function clearCachedFeeds(): Promise<void> {
  const db = await getDB()
  const tx = db.transaction('feeds', 'readwrite')
  await tx.store.clear()
  await tx.done
}

export async function clearAllCachedContent(): Promise<void> {
  // Nuclear cache wipe to accompany clear-everything on the server. Walks
  // every content-shaped IDB store; scaffolding stores (workspaces,
  // settings, syncMeta, personas) are deliberately left intact so the
  // user keeps their workspace list and preferences.
  const db = await getDB()
  const contentStores = [
    'feeds', 'papers', 'paperSummaries', 'groupChats',
    'bookmarks', 'annotations', 'likes', 'userPosts', 'alerts',
  ] as const
  for (const name of contentStores) {
    try {
      const tx = db.transaction(name as never, 'readwrite')
      await tx.store.clear()
      await tx.done
    } catch { /* store may not exist in older browsers' IDB version */ }
  }
}

// ── Alerts ──────────────────────────────────────────────────────────────────

export async function cacheAlerts(alerts: AlertItem[]) {
  const db = await getDB()
  const tx = db.transaction('alerts', 'readwrite')

  // Upsert pattern: put all incoming records (put overwrites by key), then
  // delete keys that no longer appear in the new set. Avoids the clear-then-put
  // race where a failed put mid-loop leaves IndexedDB empty.
  const newKeys = new Set(alerts.map((a) => a.id))
  const existingKeys = await tx.store.getAllKeys()

  const ops: Promise<unknown>[] = [
    ...alerts.map((a) => tx.store.put(a)),
    ...existingKeys
      .filter((k) => !newKeys.has(String(k)))
      .map((k) => tx.store.delete(k)),
  ]
  await Promise.all(ops)
  await tx.done
}

export async function getCachedAlerts(): Promise<AlertItem[]> {
  const db = await getDB()
  return db.getAll('alerts')
}
