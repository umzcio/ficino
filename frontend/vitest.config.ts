import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  test: {
    // environmentMatchGlobs was removed in vitest 4, so the routing is
    // expressed as two projects instead. Convention: .test.ts = node/pure,
    // .test.tsx = jsdom/render.
    projects: [
      {
        plugins: [react()],
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
        },
      },
    ],
  },
})
