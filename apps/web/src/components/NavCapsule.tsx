import { NavLink } from 'react-router-dom'
import './NavCapsule.css'

const TABS = [
  { to: '/', label: 'Login' },
  { to: '/feed', label: 'Feed' },
  { to: '/regras', label: 'Regras' },
  { to: '/fontes', label: 'Fontes' },
  { to: '/historico', label: 'Histórico' },
  { to: '/saude', label: 'Saúde' },
]

export function NavCapsule() {
  return (
    <header className="nav-shell">
      <span className="nav-wordmark">teleyes</span>
      <nav className="nav-capsule" aria-label="Navegação principal">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.to === '/'}
            className={({ isActive }) => 'nav-tab' + (isActive ? ' nav-tab--active' : '')}
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
    </header>
  )
}
