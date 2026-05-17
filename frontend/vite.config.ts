import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// Base path differs by deploy target:
//   self-host (default) — /ficino/, served behind a reverse proxy
//   SaaS (Railway)      — /, served at the root of ficino.app
// Set VITE_BASE_PATH at build time to flip it.
const BASE = process.env.VITE_BASE_PATH || '/ficino/'

// Escape the base for use inside a RegExp literal. "/ficino/" becomes
// "\/ficino\/"; "/" becomes "\/". Needed because the PWA plugin's URL
// patterns are passed as regex.
const BASE_RE = BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export default defineConfig({
  base: BASE,
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      scope: BASE,
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico,woff2}'],
        navigateFallback: `${BASE}index.html`,
        navigateFallbackAllowlist: [new RegExp(`^${BASE_RE}`)],
        navigateFallbackDenylist: [new RegExp(`^${BASE_RE}api\\/`)],
        runtimeCaching: [
          {
            urlPattern: new RegExp(`${BASE_RE}personas\\/.*\\.png$`),
            handler: 'CacheFirst',
            options: {
              cacheName: 'persona-avatars',
              expiration: { maxEntries: 50, maxAgeSeconds: 30 * 24 * 60 * 60 },
            },
          },
          {
            urlPattern: new RegExp(`${BASE_RE}api\\/figures\\/`),
            handler: 'CacheFirst',
            options: {
              // 200 entries was the LRU ceiling and caused silent eviction
              // once a user's corpus crossed ~20 papers × 10 figures — dropped
              // figures vanished from offline mode with no UI signal. 1000 is
              // ~10× typical corpus size and still well under the browser's
              // per-origin quota (~50 MB of JPEGs at ~100 KB each).
              cacheName: 'figure-images',
              expiration: { maxEntries: 1000, maxAgeSeconds: 30 * 24 * 60 * 60 },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'google-fonts-stylesheets',
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: { maxEntries: 10, maxAgeSeconds: 365 * 24 * 60 * 60 },
            },
          },
        ],
      },
      manifest: {
        name: 'Ficino',
        short_name: 'Ficino',
        description: 'AI-powered academic discourse engine',
        theme_color: '#080a0f',
        background_color: '#080a0f',
        display: 'standalone',
        scope: BASE,
        start_url: BASE,
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      '/ficino/api': {
        target: 'http://ficino-api:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ficino\/api/, ''),
      },
    },
  },
  build: {
    // Route-level views are split via React.lazy() in App.tsx, which produces
    // one on-demand chunk per view naturally. A manualChunks function here
    // would pull those components into the static graph and cause Rollup to
    // emit <link rel="modulepreload"> for every route on first paint, which
    // defeats the purpose of lazy loading. Let Rollup handle chunking.
  },
})
