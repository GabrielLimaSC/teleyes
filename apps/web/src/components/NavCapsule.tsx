import { useState } from 'react'
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

function NavTab({ to, label, onNavigate }: (typeof TABS)[number] & { onNavigate: () => void }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) => 'nav-tab' + (isActive ? ' nav-tab--active' : '')}
      onClick={onNavigate}
    >
      {label}
    </NavLink>
  )
}

export function NavCapsule() {
  const [isPinnedOpen, setIsPinnedOpen] = useState(false)

  return (
    <header className="nav-shell">
      <svg className="nav-glass-filter" aria-hidden="true">
        <defs>
          <filter
            id="nav-glass-refraction"
            x="-15%"
            y="-35%"
            width="130%"
            height="170%"
            colorInterpolationFilters="sRGB"
          >
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.012 0.08"
              numOctaves="1"
              seed="7"
              result="surface"
            />
            <feGaussianBlur in="surface" stdDeviation="1.4" result="softSurface" />
            <feDisplacementMap
              in="SourceGraphic"
              in2="softSurface"
              scale="34"
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        </defs>
      </svg>

      <nav
        className={'nav-capsule' + (isPinnedOpen ? ' nav-capsule--pinned' : '')}
        aria-label="Navegação principal"
        onKeyDown={(event) => {
          if (event.key === 'Escape') setIsPinnedOpen(false)
        }}
      >
        <span className="nav-capsule__glass" aria-hidden="true">
          <span className="nav-glass__refraction" />
          <span className="nav-glass__tint" />
          <span className="nav-glass__shine" />
        </span>

        <span className="nav-capsule__wing nav-capsule__wing--left">
          {TABS.slice(0, 3).map((tab) => (
            <NavTab key={tab.to} {...tab} onNavigate={() => setIsPinnedOpen(false)} />
          ))}
        </span>

        <span className="nav-capsule__wing nav-capsule__wing--right">
          {TABS.slice(3).map((tab) => (
            <NavTab key={tab.to} {...tab} onNavigate={() => setIsPinnedOpen(false)} />
          ))}
        </span>

        <button
          type="button"
          className="nav-mascot"
          aria-label={isPinnedOpen ? 'Recolher navegação' : 'Expandir navegação'}
          aria-expanded={isPinnedOpen}
          onClick={() => setIsPinnedOpen((open) => !open)}
        >
          <span className="nav-mascot__refraction" aria-hidden="true" />
          <span className="nav-mascot__tint" aria-hidden="true" />
          <span className="nav-mascot__shine" aria-hidden="true" />
          <img src="/mascot.png" alt="" width="256" height="256" />
        </button>
      </nav>
    </header>
  )
}
