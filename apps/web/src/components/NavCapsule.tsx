import { useLayoutEffect, useRef, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import './NavCapsule.css'

const TABS = [
  { to: '/', label: 'Login' },
  { to: '/feed', label: 'Feed' },
  { to: '/regras', label: 'Regras' },
  { to: '/fontes', label: 'Fontes' },
  { to: '/historico', label: 'Histórico' },
  { to: '/saude', label: 'Saúde' },
]

function activeIndex(pathname: string): number {
  const index = TABS.findIndex((tab) => (tab.to === '/' ? pathname === '/' : pathname.startsWith(tab.to)))
  return index === -1 ? 0 : index
}

export function NavCapsule() {
  const location = useLocation()
  const tabRefs = useRef<(HTMLAnchorElement | null)[]>([])
  const [pillStyle, setPillStyle] = useState<{
    left: number
    top: number
    width: number
    height: number
  } | null>(null)

  useLayoutEffect(() => {
    const measure = () => {
      const activeTab = tabRefs.current[activeIndex(location.pathname)]
      if (activeTab === null || activeTab === undefined) return
      // top/height too, not just left/width — the capsule wraps to multiple
      // rows on narrow screens (NavCapsule.css), so the pill must follow.
      setPillStyle({
        left: activeTab.offsetLeft,
        top: activeTab.offsetTop,
        width: activeTab.offsetWidth,
        height: activeTab.offsetHeight,
      })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [location.pathname])

  return (
    <header className="nav-shell">
      <span className="nav-wordmark">teleyes</span>
      <nav className="nav-capsule" aria-label="Navegação principal">
        {/* The gooey "metaball" look: the pill's own blurred, contrast-boosted
            edges deform as `left`/`width` transition between tabs — filter and
            transition both fall away under prefers-reduced-motion. */}
        <div className="nav-capsule__goo-layer">
          {pillStyle && (
            <span
              className="nav-pill"
              style={{
                left: pillStyle.left,
                top: pillStyle.top,
                width: pillStyle.width,
                height: pillStyle.height,
              }}
            />
          )}
        </div>
        {TABS.map((tab, index) => (
          <NavLink
            key={tab.to}
            ref={(element) => {
              tabRefs.current[index] = element
            }}
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
