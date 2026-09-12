import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

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
  '/demo',
  '/openapi.json',
]

const API_TARGET = process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:8000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: Object.fromEntries(
      API_PREFIXES.map((prefix) => [prefix, { target: API_TARGET, changeOrigin: true }]),
    ),
  },
})
