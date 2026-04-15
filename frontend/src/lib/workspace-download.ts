import {
  listFeeds, listPapers, listBookmarks, listAnnotations,
  listPersonas, getSettings, listUserPosts, listLikesForFeed,
  listPaperConversations, getPaperSummary,
} from './api'
import {
  cacheFeeds, cachePapers, cacheBookmarks, cacheAnnotations,
  cachePersonas, cacheSettings, cacheUserPosts, cacheLikes,
} from './offline-cache'
import { getDB } from './offline-db'
import type { Feed } from '../types'

const API_BASE = import.meta.env.VITE_API_BASE || '/ficino/api'

export interface DownloadProgress {
  step: string
  current: number
  total: number
  done: boolean
}

export async function downloadWorkspace(
  workspaceId: string,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const report = (step: string, current: number, total: number) =>
    onProgress({ step, current, total, done: false })

  const totalSteps = 7
  let step = 0

  const check = () => { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError') }

  // 1. Feeds
  report('Feeds', ++step, totalSteps)
  check()
  const feeds = await listFeeds(workspaceId)
  await cacheFeeds(feeds, workspaceId)

  // 2. Papers
  report('Papers', ++step, totalSteps)
  check()
  const papers = await listPapers(workspaceId)
  await cachePapers(papers, workspaceId)

  // 3. Bookmarks + Annotations + Personas + Settings (parallel)
  report('Bookmarks & notes', ++step, totalSteps)
  check()
  const [bookmarks, annotations, personas, settings, userPosts] = await Promise.all([
    listBookmarks(),
    listAnnotations(),
    listPersonas(),
    getSettings(),
    listUserPosts(workspaceId),
  ])
  await Promise.all([
    cacheBookmarks(bookmarks),
    cacheAnnotations(annotations),
    cachePersonas(personas),
    cacheSettings(settings),
    cacheUserPosts(userPosts, workspaceId),
  ])

  // 4. Likes for each feed
  report('Likes', ++step, totalSteps)
  check()
  for (const feed of feeds) {
    check()
    try {
      const likes = await listLikesForFeed(feed.id)
      await cacheLikes(feed.id, likes)
    } catch { /* skip individual feed errors */ }
  }

  // 5. Paper summaries
  report('Paper summaries', ++step, totalSteps)
  check()
  const conversations = await listPaperConversations(workspaceId)
  const withSummary = conversations.filter(p => p.has_summary)
  const db = await getDB()
  for (const conv of withSummary) {
    check()
    try {
      const summary = await getPaperSummary(conv.paper_id)
      await db.put('paperSummaries', summary)
    } catch { /* skip individual errors */ }
  }

  // 6. Figure images (warm the service worker cache)
  report('Figures', ++step, totalSteps)
  check()
  const figureUrls = collectFigureUrls(feeds)
  for (const url of figureUrls) {
    check()
    try { await fetch(url) } catch { /* ignore */ }
  }

  // 7. Record sync timestamp
  report('Finishing', ++step, totalSteps)
  await db.put('syncMeta', { storeName: `workspace:${workspaceId}`, lastSync: Date.now() })

  onProgress({ step: 'Complete', current: totalSteps, total: totalSteps, done: true })
}

function collectFigureUrls(feeds: Feed[]): string[] {
  const urls = new Set<string>()
  for (const feed of feeds) {
    for (const post of feed.posts) {
      if (post.figure_url) {
        urls.add(`${API_BASE}${post.figure_url}`)
      }
    }
  }
  return [...urls]
}

// ── Sync metadata helpers ───────────────────────────────────────────────────

export async function getLastSync(workspaceId: string): Promise<number | null> {
  const db = await getDB()
  const meta = await db.get('syncMeta', `workspace:${workspaceId}`)
  return meta?.lastSync ?? null
}

export async function estimateCacheSize(): Promise<{ bytes: number; formatted: string }> {
  if (navigator.storage?.estimate) {
    const est = await navigator.storage.estimate()
    const used = est.usage ?? 0
    return { bytes: used, formatted: formatBytes(used) }
  }
  return { bytes: 0, formatted: 'unknown' }
}

export async function clearOfflineData(): Promise<void> {
  const db = await getDB()
  const storeNames: (keyof typeof db.objectStoreNames extends never ? never : string)[] = [
    'feeds', 'papers', 'paperSummaries', 'groupChats', 'bookmarks',
    'annotations', 'likes', 'personas', 'workspaces', 'settings',
    'userPosts', 'alerts', 'syncMeta',
  ]
  for (const name of storeNames) {
    const tx = db.transaction(name as never, 'readwrite')
    await tx.store.clear()
    await tx.done
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}
