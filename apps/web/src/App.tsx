import { useEffect } from 'react'
import { Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from './auth/AuthContext'
import { NavCapsule } from './components/NavCapsule'
import { MobileChrome } from './components/MobileChrome'
import { PHONE_QUERY, useMediaQuery } from './hooks/useMediaQuery'
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

const ROUTE_TITLES: Record<string, string> = {
  '/feed': 'Ofertas ao vivo',
  '/regras': 'Regras',
  '/fontes': 'Grupos',
  '/historico': 'Histórico',
  '/economia': 'Economia',
  '/saude': 'Saúde',
  '/configuracao': 'Configuração',
}

/** S23-02: one `document.title` per route ("Regras · teleyes"); "/" is the login
 * screen until a session exists, then the home ("Início"). */
function DocumentTitle() {
  const { pathname } = useLocation()
  const { status } = useAuth()
  const page = pathname === '/' ? (status === 'authenticated' ? 'Início' : 'Entrar') : (ROUTE_TITLES[pathname] ?? null)
  useEffect(() => {
    document.title = page === null ? 'teleyes' : `${page} · teleyes`
  }, [page])
  return null
}

/** S23-02: first Tab stop; moves focus to the page's <main> (which is not
 * focusable by itself) and scrolls it into view. */
function SkipLink() {
  return (
    <a
      className="skip-link"
      href="#conteudo"
      onClick={(event) => {
        const main = document.querySelector('main')
        if (main === null) return
        event.preventDefault()
        main.setAttribute('tabindex', '-1')
        main.focus()
        main.scrollIntoView()
      }}
    >
      Pular para o conteúdo
    </a>
  )
}

/** S24-01: on a phone, once signed in, the tab bar + top bar replace the capsule. */
function Chrome() {
  const { status } = useAuth()
  const phone = useMediaQuery(PHONE_QUERY)
  return phone && status === 'authenticated' ? <MobileChrome /> : <NavCapsule />
}

function App() {
  return (
    <>
      <SkipLink />
      <DocumentTitle />
      <OfflineBanner />
      <DemoBanner />
      <Chrome />
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
