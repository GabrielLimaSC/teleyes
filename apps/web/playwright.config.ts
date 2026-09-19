import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

const dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  testDir: './e2e',
  // S12-01 visual baseline (opt-in, VISUAL=1): one folder, no platform suffix.
  snapshotPathTemplate: '{testDir}/visual-baseline/{arg}{ext}',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5183',
    // S12-01 visual baseline (VISUAL=1): software rasterization, so the
    // blur/contrast/backdrop filters render the same pixels on every run.
    launchOptions: {
      args:
        process.env.VISUAL === '1'
          ? ['--disable-gpu', '--disable-gpu-rasterization', '--force-color-profile=srgb', '--disable-lcd-text', '--font-render-hinting=none']
          : [],
    },
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
