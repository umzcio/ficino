import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  base: '/ficino/',
  plugins: [react(), tailwindcss()],
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
