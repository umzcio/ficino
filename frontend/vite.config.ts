import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: '/ficino/',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      scope: '/ficino/',
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico,woff2}'],
        navigateFallback: '/ficino/index.html',
        navigateFallbackAllowlist: [/^\/ficino\//],
        navigateFallbackDenylist: [/^\/ficino\/api\//],
        runtimeCaching: [
          {
            urlPattern: /\/ficino\/personas\/.*\.png$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'persona-avatars',
              expiration: { maxEntries: 50, maxAgeSeconds: 30 * 24 * 60 * 60 },
            },
          },
          {
            urlPattern: /\/ficino\/api\/figures\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'figure-images',
              expiration: { maxEntries: 200, maxAgeSeconds: 30 * 24 * 60 * 60 },
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
        scope: '/ficino/',
        start_url: '/ficino/',
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
})
