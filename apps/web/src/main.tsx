import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import './index.css'
import './styles/viewTransitions.css'
import App from './App.tsx'
import { AuthProvider } from './auth/AuthContext'

// NavCapsule's NavLink `viewTransition` prop only wraps navigations in
// document.startViewTransition() under the data router (createBrowserRouter
// + RouterProvider) — under the plain <BrowserRouter> it used to silently no-op,
// so the diagonal page-reveal keyframe (viewTransitions.css) never actually
// fired despite the prop being set (S4-09 finish pass).
const router = createBrowserRouter([
  {
    path: '*',
    element: (
      <AuthProvider>
        <App />
      </AuthProvider>
    ),
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
