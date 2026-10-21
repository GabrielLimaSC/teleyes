import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

const dirname = path.dirname(fileURLToPath(import.meta.url))

// DEMO_BASE_URL points the run at an already running demo stack (README screenshots
// from docker-compose.demo.yml): nothing to start then.
const externalStack = process.env.DEMO_BASE_URL

const ownServers = [
  {
    command: './e2e-demo/start-demo-backend.sh',
    cwd: dirname,
    url: 'http://127.0.0.1:8198/health',
    reuseExistingServer: false,
    timeout: 60_000,
  },
  {
    command: 'npm run dev -- --port 5184 --strictPort --host 127.0.0.1',
    cwd: dirname,
    env: { VITE_API_PROXY_TARGET: 'http://127.0.0.1:8198' },
    url: 'http://127.0.0.1:5184',
    reuseExistingServer: false,
    timeout: 30_000,
  },
]

// S19-03: the demo-mode specs run against a backend seeded by scripts/seed_demo.py
// (its own ports, so it never shares state with the main e2e run: `npm run test:e2e:demo`).
export default defineConfig({
  testDir: './e2e-demo',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: externalStack ?? 'http://127.0.0.1:5184' },
  webServer: externalStack ? [] : ownServers,
})
