import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import './styles/tokens.css'
import './styles/materials.css'
import './index.css'
import './styles/viewTransitions.css'
import './styles/chrome.css'
import App from './App.tsx'
import { AuthProvider } from './auth/AuthContext'

const router = createBrowserRouter(
  [
    {
      path: '*',
      element: (
        <AuthProvider>
          <App />
        </AuthProvider>
      ),
    },
  ],
  // S19-05: the static demo lives under /teleyes/ on GitHub Pages ('/' everywhere else).
  { basename: import.meta.env.BASE_URL.replace(/\/$/, '') || '/' },
)

async function start(): Promise<void> {
  // S19-05: replaced by a literal at build time, so the normal bundle has no mock at all.
  if (import.meta.env.VITE_DEMO_STATIC === '1') {
    const { bootDemoStatic } = await import('./demo-static/install')
    await bootDemoStatic()
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  )
}

void start()
