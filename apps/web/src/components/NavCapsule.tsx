import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useChromeMode } from '../chrome/scrollChrome'
import { Mascot } from './Mascot'
import { ThemeToggle } from './ThemeToggle'
import './NavCapsule.css'

// `stagger`: distance from the mascot, the order the tabs reappear in —
// centre out in the normal capsule, left to right (`order`) in the compact
// one (S15-03/S15-04), where the mascot sits before every tab.
const TABS = [
  // Left wing: follow what happens. Right wing: configure (Tema is its 4th slot).
  { to: '/', label: 'Início', stagger: 3, order: 0 },
  { to: '/feed', label: 'Ofertas', stagger: 2, order: 1 },
  { to: '/historico', label: 'Histórico', stagger: 1, order: 2 },
  { to: '/economia', label: 'Economia', stagger: 0, order: 3 },
  { to: '/regras', label: 'Regras', stagger: 0, order: 4 },
  { to: '/fontes', label: 'Grupos', stagger: 1, order: 5 },
  { to: '/saude', label: 'Saúde', stagger: 2, order: 6 },
]

const COMPACT_NAV_QUERY = '(max-width: 760px)'

function subscribeToCompactNavigation(listener: () => void) {
  if (typeof window.matchMedia !== 'function') return () => {}
  const media = window.matchMedia(COMPACT_NAV_QUERY)
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}

function isCompactNavigation() {
  return typeof window.matchMedia !== 'function'
    ? true
    : window.matchMedia(COMPACT_NAV_QUERY).matches
}

function NavTab({ to, label, stagger, order, onNavigate }: (typeof TABS)[number] & { onNavigate: () => void }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) => 'nav-tab' + (isActive ? ' nav-tab--active' : '')}
      style={{ '--nav-stagger': stagger, '--nav-order': order } as CSSProperties}
      onClick={onNavigate}
    >
      {label}
    </NavLink>
  )
}

export function NavCapsule() {
  const [isPinnedOpen, setIsPinnedOpen] = useState(false)
  const isCompact = useSyncExternalStore(subscribeToCompactNavigation, isCompactNavigation, () => true)
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const currentTab = TABS.find((tab) => tab.to === pathname)?.label ?? 'Navegação'
  // S15-03: while the Feed is scrolled, the capsule shrinks to the mascot
  // disc at the top-left (NavCapsule.css) and the mascot becomes its toggle.
  const chromeMode = useChromeMode()
  const isChromeCompact = chromeMode === 'compact'
  const [isChromeOpen, setIsChromeOpen] = useState(false)
  const capsuleRef = useRef<HTMLElement>(null)
  const mascotIsToggle = isCompact || isChromeCompact
  const isExpanded = isCompact ? isPinnedOpen : isChromeOpen

  // Leaving compact (back to the top, or another page) always starts closed.
  if (!isChromeCompact && isChromeOpen) setIsChromeOpen(false)

  useEffect(() => {
    if (!isChromeOpen) return
    const closeOnOutside = (event: PointerEvent) => {
      if (!capsuleRef.current?.contains(event.target as Node)) setIsChromeOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutside)
    return () => document.removeEventListener('pointerdown', closeOnOutside)
  }, [isChromeOpen])

  function closeAll() {
    setIsPinnedOpen(false)
    setIsChromeOpen(false)
  }

  return (
    <header className={'nav-shell' + (isPinnedOpen ? ' nav-shell--open' : '')}>
      <svg className="nav-glass-filter" aria-hidden="true">
        <defs>
          <filter
            id="nav-glass-refraction"
            x="-10%"
            y="-25%"
            width="120%"
            height="150%"
            colorInterpolationFilters="sRGB"
          >
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.016 0.045"
              numOctaves="1"
              seed="12"
              result="surface"
            />
            <feGaussianBlur in="surface" stdDeviation="1.2" result="softSurface" />
            <feDisplacementMap
              in="SourceGraphic"
              in2="softSurface"
              scale="14"
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        </defs>
      </svg>

      <nav
        ref={capsuleRef}
        className={
          'nav-capsule' +
          (isPinnedOpen ? ' nav-capsule--pinned' : '') +
          (isChromeOpen ? ' nav-capsule--chrome-open' : '')
        }
        aria-label="Navegação principal"
        onKeyDown={(event) => {
          if (event.key === 'Escape') closeAll()
        }}
      >
        <span className="nav-capsule__glass" aria-hidden="true">
          <span className="nav-glass__refraction" />
          <span className="nav-glass__tint" />
          <span className="nav-glass__shine" />
        </span>

        <span className="nav-capsule__brand" aria-hidden="true">teleyes</span>
        <span className="nav-capsule__current" role="status" aria-label={`Página atual: ${currentTab}`}>
          {currentTab}
        </span>

        <div className="nav-capsule__menu" id="teleyes-navigation-tabs">
          <span className="nav-capsule__wing nav-capsule__wing--left">
            {TABS.slice(0, 4).map((tab) => (
              <NavTab key={tab.to} {...tab} onNavigate={closeAll} />
            ))}
          </span>

          <span className="nav-capsule__wing nav-capsule__wing--right">
            {TABS.slice(4).map((tab) => (
              <NavTab key={tab.to} {...tab} onNavigate={closeAll} />
            ))}
            <span className="nav-tab-slot" style={{ '--nav-stagger': 3, '--nav-order': 7 } as CSSProperties}>
              <ThemeToggle />
            </span>
          </span>
        </div>

        {/* One element in both roles, so the compact-chrome spring keeps moving
            the same node: a toggle where the tabs are collapsed, else "home". */}
        <button
          type="button"
          className="nav-mascot"
          aria-label={
            mascotIsToggle ? (isExpanded ? 'Recolher navegação' : 'Expandir navegação') : 'Ir para o início'
          }
          aria-expanded={mascotIsToggle ? isExpanded : undefined}
          aria-controls={mascotIsToggle ? 'teleyes-navigation-tabs' : undefined}
          onClick={() => {
            if (!mascotIsToggle) navigate('/')
            else if (isCompact) setIsPinnedOpen((open) => !open)
            else setIsChromeOpen((open) => !open)
          }}
        >
          <span className="nav-mascot__refraction" aria-hidden="true" />
          <span className="nav-mascot__tint" aria-hidden="true" />
          <span className="nav-mascot__shine" aria-hidden="true" />
          <Mascot width={46} height={46} />
        </button>
      </nav>
    </header>
  )
}
