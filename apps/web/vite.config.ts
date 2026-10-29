import { copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'

// Proxy every real backend prefix so the browser sees the API as same-origin —
// the session cookie is Secure/SameSite=strict (S3-02), which needs that in dev.
const API_PREFIXES = [
  '/auth',
  '/health',
  '/rules',
  '/sources',
  '/recipients',
  '/matches',
  '/metrics',
  '/notifications',
  '/events',
  '/listener',
  '/demo',
  '/settings',
  // S14-08: GET /products/{key} (S14-01) — the product panel's history API.
  '/products',
  // S14-08: was missing since S14-03 — POST/GET /snoozes, DELETE /snoozes/{id}.
  '/snoozes',
  // S19-04: purchases CRUD and the savings report behind the Economia page.
  '/purchases',
  '/savings',
  '/digest',
  // S19-02: the first-run setup wizard API. The page itself lives at /configuracao.
  '/setup',
  '/openapi.json',
]

const API_TARGET = process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:8000'

/**
 * S19-05: GitHub Pages has no SPA fallback, so a refresh on /teleyes/regras would
 * 404. Pages serves 404.html for unknown paths; a copy of index.html there boots
 * the same app, which then reads the URL and renders the right route.
 */
function spaFallback404(): Plugin {
  let outDir = 'dist'
  return {
    name: 'teleyes-spa-404',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      copyFileSync(resolve(outDir, 'index.html'), resolve(outDir, '404.html'))
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  // S19-05: VITE_BASE=/teleyes/ for the GitHub Pages demo; '/' for everything else.
  base: process.env.VITE_BASE ?? '/',
  plugins: [react(), ...(mode === 'demo-static' ? [spaFallback404()] : [])],
  server: {
    proxy: Object.fromEntries(
      API_PREFIXES.map((prefix) => [prefix, { target: API_TARGET, changeOrigin: true }]),
    ),
  },
}))
