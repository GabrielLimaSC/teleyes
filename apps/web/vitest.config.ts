import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// S13-01: the suite runs in the user's real timezone (UTC-3), not the runner's.
// A UTC CI box and a UTC-3 laptop would otherwise disagree on "today" for any
// instant between 21h and 24h local — the very bug this pins. Set before any
// worker starts, so every test file inherits it.
process.env.TZ = 'America/Sao_Paulo'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    exclude: ['**/node_modules/**', '**/e2e/**'],
  },
})
