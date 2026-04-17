import { getDB } from './offline-db'
import type { Feed, Paper, Workspace } from '../types'
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
  // Queue all puts without awaiting each sequentially — an in-loop await
  // on tx.store.put() can yield the event loop before the last put commits,
  // letting tx.done race. Promise.all keeps the transaction open until every
  // put's request is registered, then tx.done guarantees the commit.
  await Promise.all(feeds.map((f) => tx.store.put({ ...f, workspaceId })))
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
  await Promise.all(papers.map((p) => tx.store.put({ ...p, workspaceId })))
  await tx.done
}

export async function getCachedPapers(workspaceId?: string): Promise<Paper[]> {
  const db = await getDB()
  if (workspaceId) {
    return db.getAllFromIndex('papers', 'by-workspace', workspaceId)
  }
  return db.getAll('papers')
}

// ── Bookmarks ───────────────────────────────────────────────────────────────

export async function cacheBookmarks(bookmarks: BookmarkItem[]) {
  const db = await getDB()
  const tx = db.transaction('bookmarks', 'readwrite')
  await tx.store.clear()
  for (const b of bookmarks) {
    await tx.store.put(b)
  }
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
  for (const p of personas) {
    await tx.store.put(p)
  }
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
  await tx.store.clear()
  for (const w of workspaces) {
    await tx.store.put(w)
  }
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
  // Clear existing posts for this workspace before caching
  if (workspaceId) {
    const existing = await tx.store.index('by-workspace').getAllKeys(workspaceId)
    for (const key of existing) {
      await tx.store.delete(key)
    }
  }
  for (const p of posts) {
    await tx.store.put({ ...p, workspaceId })
  }
  await tx.done
}

export async function getCachedUserPosts(workspaceId?: string): Promise<UserPost[]> {
  const db = await getDB()
  if (workspaceId) {
    return db.getAllFromIndex('userPosts', 'by-workspace', workspaceId)
  }
  return db.getAll('userPosts')
}

// ── Alerts ──────────────────────────────────────────────────────────────────

export async function cacheAlerts(alerts: AlertItem[]) {
  const db = await getDB()
  const tx = db.transaction('alerts', 'readwrite')
  await tx.store.clear()
  for (const a of alerts) {
    await tx.store.put(a)
  }
  await tx.done
}

export async function getCachedAlerts(): Promise<AlertItem[]> {
  const db = await getDB()
  return db.getAll('alerts')
}
