import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

const dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * S20-03: perf runs against the PRODUCTION build (vite build + vite preview),
 * not the dev server — the dev build does not represent what the user sees.
 * Same fixed ports as the regular e2e config.
 *
 *   PANEL_PERF=1 PANEL_PERF_SEED=350 npx playwright test -c playwright.perf.config.ts e2e/panel-perf.spec.ts
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 240_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5183',
    launchOptions: { args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--enable-zero-copy'] },
  },
  webServer: [
    {
      command: './e2e/start-backend.sh',
      cwd: dirname,
      url: 'http://127.0.0.1:8199/health',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'npx vite build && npx vite preview --port 5183 --strictPort --host 127.0.0.1',
      cwd: dirname,
      env: { VITE_API_PROXY_TARGET: 'http://127.0.0.1:8199' },
      url: 'http://127.0.0.1:5183',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
