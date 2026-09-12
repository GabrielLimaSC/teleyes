import { Route, Routes } from 'react-router-dom'
import { NavCapsule } from './components/NavCapsule'
import { RequireAuth } from './auth/RequireAuth'
import { LoginPage } from './pages/LoginPage'
import { FeedPage } from './pages/FeedPage'
import { HistoricoPage } from './pages/HistoricoPage'
import { PlaceholderPage } from './pages/PlaceholderPage'

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
              <PlaceholderPage title="Regras" />
            </RequireAuth>
          }
        />
        <Route
          path="/fontes"
          element={
            <RequireAuth>
              <PlaceholderPage title="Fontes" />
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
              <PlaceholderPage title="Saúde" />
            </RequireAuth>
          }
        />
      </Routes>
    </>
  )
}

export default App
