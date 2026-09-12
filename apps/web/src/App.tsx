import { Route, Routes } from 'react-router-dom'
import { NavCapsule } from './components/NavCapsule'
import { RequireAuth } from './auth/RequireAuth'
import { LoginPage } from './pages/LoginPage'
import { FeedPage } from './pages/FeedPage'
import { HistoricoPage } from './pages/HistoricoPage'
import { RegrasPage } from './pages/RegrasPage'
import { DestinatariosSection } from './pages/DestinatariosSection'
import { FontesPage } from './pages/FontesPage'
import { SaudePage } from './pages/SaudePage'

function App() {
  return (
    <>
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
              <DestinatariosSection />
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
    </>
  )
}

export default App
