import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Feed, Paper, PaperSummary, GroupChat, Workspace } from '../types'
import type { BookmarkItem, AnnotationItem, AlertItem, PersonaData, UserPost, FeedLikes } from './api'

export interface FicinoDB extends DBSchema {
  feeds: {
    key: string
    value: Feed & { workspaceId?: string }
    indexes: { 'by-workspace': string }
  }
  papers: {
    key: string
    value: Paper & { workspaceId?: string }
    indexes: { 'by-workspace': string }
  }
  paperSummaries: {
    key: string
    value: PaperSummary
  }
  groupChats: {
    key: string
    value: GroupChat
  }
  bookmarks: {
    key: string
    value: BookmarkItem
    indexes: { 'by-feed': string }
  }
  annotations: {
    key: string
    value: AnnotationItem & { _key: string }
  }
  likes: {
    key: string
    value: FeedLikes & { feedId: string }
  }
  personas: {
    key: string
    value: PersonaData
  }
  workspaces: {
    key: string
    value: Workspace
  }
  settings: {
    key: string
    value: { _key: string; data: Record<string, unknown> }
  }
  userPosts: {
    key: string
    value: UserPost & { workspaceId?: string }
    indexes: { 'by-workspace': string }
  }
  alerts: {
    key: string
    value: AlertItem
  }
  syncMeta: {
    key: string
    value: { storeName: string; lastSync: number }
  }
}

let dbPromise: Promise<IDBPDatabase<FicinoDB>> | null = null

// Schema version. Bump on any structural change so `upgrade()` runs against
// older local databases — otherwise returning users who first opened the app
// at version N won't see later stores or indexes. Current:
//   v1: initial stores + by-workspace indexes
//   v2: (reserved) future schema changes land here with explicit migrations
const DB_VERSION = 2

export function getDB(): Promise<IDBPDatabase<FicinoDB>> {
  if (!dbPromise) {
    dbPromise = openDB<FicinoDB>('ficino-offline', DB_VERSION, {
      upgrade(db, oldVersion) {
        // v0 → v1: create all stores and indexes
        if (oldVersion < 1) {
          const feeds = db.createObjectStore('feeds', { keyPath: 'id' })
          feeds.createIndex('by-workspace', 'workspaceId')

          const papers = db.createObjectStore('papers', { keyPath: 'id' })
          papers.createIndex('by-workspace', 'workspaceId')

          db.createObjectStore('paperSummaries', { keyPath: 'paper_id' })
          db.createObjectStore('groupChats', { keyPath: 'id' })

          const bookmarks = db.createObjectStore('bookmarks', { keyPath: 'id' })
          bookmarks.createIndex('by-feed', 'feed_id')

          db.createObjectStore('annotations', { keyPath: '_key' })
          db.createObjectStore('likes', { keyPath: 'feedId' })
          db.createObjectStore('personas', { keyPath: 'key' })
          db.createObjectStore('workspaces', { keyPath: 'id' })
          db.createObjectStore('settings', { keyPath: '_key' })

          const userPosts = db.createObjectStore('userPosts', { keyPath: 'id' })
          userPosts.createIndex('by-workspace', 'workspaceId')

          db.createObjectStore('alerts', { keyPath: 'id' })
          db.createObjectStore('syncMeta', { keyPath: 'storeName' })
        }
        // v1 → v2: no-op for now — schema is stable. Placeholder block so
        // the next structural change just adds `if (oldVersion < 3) { ... }`.
      },
    })
  }
  return dbPromise
}
