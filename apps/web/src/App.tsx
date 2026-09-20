import { Route, Routes } from 'react-router-dom'
import { NavCapsule } from './components/NavCapsule'
import { OfflineBanner } from './components/OfflineBanner'
import { ThemeToggle } from './components/ThemeToggle'
import { RequireAuth } from './auth/RequireAuth'
import { LoginPage } from './pages/LoginPage'
import { FeedPage } from './pages/FeedPage'
import { HistoricoPage } from './pages/HistoricoPage'
import { RegrasPage } from './pages/RegrasPage'
import { FontesPage } from './pages/FontesPage'
import { SaudePage } from './pages/SaudePage'

function App() {
  return (
    <>
      <OfflineBanner />
      <NavCapsule />
      <Routes>
        <Route path="/" element={<LoginPage />} />
        <Route
          path="/feed"
          element={
            <RequireAuth>
              <FeedPage />
            </RequireAuth>
          }
        />
        <Route
          path="/regras"
          element={
            <RequireAuth>
              <RegrasPage />
            </RequireAuth>
          }
        />
        <Route
          path="/fontes"
          element={
            <RequireAuth>
              <FontesPage />
            </RequireAuth>
          }
        />
        <Route
          path="/historico"
          element={
            <RequireAuth>
              <HistoricoPage />
            </RequireAuth>
          }
        />
        <Route
          path="/saude"
          element={
            <RequireAuth>
              <SaudePage />
            </RequireAuth>
          }
        />
      </Routes>
      {/* Last, so the page's own elements keep their positions in the tree. */}
      <ThemeToggle />
    </>
  )
}

export default App
