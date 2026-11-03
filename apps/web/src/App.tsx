import { Route, Routes } from 'react-router-dom'
import { NavCapsule } from './components/NavCapsule'
import { DemoBanner } from './components/DemoBanner'
import { OfflineBanner } from './components/OfflineBanner'
import { RequireAuth } from './auth/RequireAuth'
import { LoginPage } from './pages/LoginPage'
import { FeedPage } from './pages/FeedPage'
import { HistoricoPage } from './pages/HistoricoPage'
import { RegrasPage } from './pages/RegrasPage'
import { FontesPage } from './pages/FontesPage'
import { SaudePage } from './pages/SaudePage'
import { EconomiaPage } from './pages/EconomiaPage'
import { ConfiguracaoPage } from './pages/ConfiguracaoPage'

function App() {
  return (
    <>
      <OfflineBanner />
      <DemoBanner />
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
          path="/economia"
          element={
            <RequireAuth>
              <EconomiaPage />
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
        <Route
          path="/configuracao"
          element={
            <RequireAuth>
              <ConfiguracaoPage />
            </RequireAuth>
          }
        />
      </Routes>
    </>
  )
}

export default App
