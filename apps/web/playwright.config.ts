import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

const dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5183',
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
      command: 'npm run dev -- --port 5183 --strictPort --host 127.0.0.1',
      cwd: dirname,
      env: { VITE_API_PROXY_TARGET: 'http://127.0.0.1:8199' },
      url: 'http://127.0.0.1:5183',
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
})
