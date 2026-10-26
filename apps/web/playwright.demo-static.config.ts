import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

const dirname = path.dirname(fileURLToPath(import.meta.url))

// S19-05: the static GitHub Pages demo — no backend at all. Builds the demo-static bundle
// and serves it under the /teleyes/ subpath exactly like Pages does (port 5185, its own).
// `npm run test:e2e:demo-static`.
export default defineConfig({
  testDir: './e2e-demo-static',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5185/teleyes/' },
  webServer: {
    command: 'npm run build:demo-static && npm run preview:demo-static -- --host 127.0.0.1',
    cwd: dirname,
    url: 'http://127.0.0.1:5185/teleyes/',
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
