import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { DEMO_BANNER_TEXT } from '../api/demo'
import { DemoStaticLinks } from '../demo-static/DemoStaticLinks'
import { useMobileScrollChrome } from '../chrome/useMobileScrollChrome'
import { useHealth } from '../hooks/useHealth'
import type { SseState } from '../hooks/useHealth'
import { useTheme } from '../hooks/useTheme'
import { THEME_LABELS } from '../theme/theme'
import type { ThemePreference } from '../theme/theme'
import { telegramStateLabel } from './adapterStateLabel'
import { BottomSheet } from './BottomSheet'
import { ConfirmDialog } from './ConfirmDialog'
import { Mascot } from './Mascot'
import './MobileChrome.css'

const CONNECTION: Record<SseState, { label: string; color: string; dot: string }> = {
  connecting: { label: 'Conectando…', color: 'var(--plane-status-warn)', dot: 'var(--plane-status-warn-dot)' },
  open: { label: 'Ao vivo', color: 'var(--plane-status-good)', dot: 'var(--plane-status-good-dot)' },
  error: { label: 'Sem conexão', color: 'var(--plane-status-danger)', dot: 'var(--plane-status-danger-dot)' },
}

const THEME_SEGMENTS: ThemePreference[] = ['light', 'dark', 'system']
const MORE_PATHS = ['/historico', '/fontes', '/saude', '/configuracao']

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 22 22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

const ICONS = {
  home: (
    <Icon>
      <path d="M4 10.5 11 4l7 6.5V18a1 1 0 0 1-1 1h-3.5v-5h-5v5H5a1 1 0 0 1-1-1z" />
    </Icon>
  ),
  offers: (
    <Icon>
      <path d="M3.5 11.2V4.5a1 1 0 0 1 1-1h6.7l7.3 7.3a1.4 1.4 0 0 1 0 2l-5.7 5.7a1.4 1.4 0 0 1-2 0z" />
      <circle cx="7.6" cy="7.6" r="1.4" />
    </Icon>
  ),
  rules: (
    <Icon>
      <path d="M4 7h8M17 7h1M4 15h2M11 15h7" />
      <circle cx="14.5" cy="7" r="2.3" />
      <circle cx="8.5" cy="15" r="2.3" />
    </Icon>
  ),
  savings: (
    <Icon>
      <path d="M4 18V10M9 18V5M14 18v-5M19 18V8" />
    </Icon>
  ),
  more: (
    <Icon>
      <circle cx="5" cy="11" r="1.6" fill="currentColor" />
      <circle cx="11" cy="11" r="1.6" fill="currentColor" />
      <circle cx="17" cy="11" r="1.6" fill="currentColor" />
    </Icon>
  ),
}

const TABS = [
  { to: '/', label: 'Início', icon: ICONS.home },
  { to: '/feed', label: 'Ofertas', icon: ICONS.offers },
  { to: '/regras', label: 'Regras', icon: ICONS.rules },
  { to: '/economia', label: 'Economia', icon: ICONS.savings },
]

function ConnectionPill({ state }: { state: SseState }) {
  const view = CONNECTION[state]
  return (
    <span className="mobile-top__pill" role="status" style={{ color: view.color }}>
      <span className="mobile-top__dot" style={{ background: view.dot }} aria-hidden="true" />
      {view.label}
    </span>
  )
}

/**
 * S24-01: phone chrome (<= 640px, signed in): top bar with the mascot and the
 * connection pill, floating bottom tab bar and the "Mais" sheet. It replaces
 * the NavCapsule there; App decides which of the two is mounted.
 */
export function MobileChrome() {
  const { pathname } = useLocation()
  const { logout } = useAuth()
  const { health, sseState } = useHealth()
  const [moreOpen, setMoreOpen] = useState(false)
  const [confirmLogout, setConfirmLogout] = useState(false)
  const [busy, setBusy] = useState(false)
  const { preference, setPreference } = useTheme()
  const { compact, scrolled } = useMobileScrollChrome()

  // Tells the stylesheet there is a tab bar: room under the content, and the
  // fixed demo strip moves into the "Mais" sheet.
  useEffect(() => {
    document.documentElement.dataset.mobileNav = 'true'
    return () => {
      delete document.documentElement.dataset.mobileNav
    }
  }, [])

  const moreActive = moreOpen || MORE_PATHS.includes(pathname)
  const adapter = health === null ? null : telegramStateLabel(health.telegram.state)
  const healthText = health === null ? 'Verificando…' : health.demo === true ? 'Operando em demonstração' : (adapter?.label ?? '')
  const closeMore = () => setMoreOpen(false)
  const tabIndex = TABS.findIndex((tab) => (tab.to === '/' ? pathname === '/' : pathname.startsWith(tab.to)))
  // The sliding pill sits under the current tab; "Mais" owns the last slot.
  const pillIndex = moreActive ? TABS.length : tabIndex

  return (
    <>
      <header className="mobile-top" data-scrolled={scrolled ? 'true' : undefined}>
        <Link to="/" className="mobile-top__brand" aria-label="teleyes, ir para o início">
          <Mascot width={32} height={32} />
          <span className="mobile-top__name">teleyes</span>
        </Link>
        <ConnectionPill state={sseState} />
      </header>

      <nav
        className="mobile-tabs"
        aria-label="Navegação principal"
        data-compact={compact ? 'true' : undefined}
        style={{ '--tab-index': Math.max(pillIndex, 0) } as CSSProperties}
      >
        <span className="mobile-tabs__pill" data-visible={pillIndex >= 0 ? 'true' : 'false'} aria-hidden="true" />
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.to === '/'}
            className={({ isActive }) => 'mobile-tabs__tab' + (isActive ? ' mobile-tabs__tab--active' : '')}
          >
            <span className="mobile-tabs__icon">{tab.icon}</span>
            <span className="mobile-tabs__label">{tab.label}</span>
          </NavLink>
        ))}
        <button
          type="button"
          className={'mobile-tabs__tab' + (moreActive ? ' mobile-tabs__tab--active' : '')}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(true)}
        >
          <span className="mobile-tabs__icon">{ICONS.more}</span>
          <span className="mobile-tabs__label">Mais</span>
        </button>
      </nav>

      <BottomSheet open={moreOpen} onClose={closeMore} title="Mais" className="mobile-more-sheet">
        <div className="bottom-sheet__list">
          <Link to="/historico" replace className="bottom-sheet__item" onClick={closeMore}>
            Histórico
          </Link>
          <Link to="/fontes" replace className="bottom-sheet__item" onClick={closeMore}>
            Grupos
          </Link>
          <Link to="/saude" replace className="bottom-sheet__item" onClick={closeMore}>
            <span>Saúde</span>
            <span className="mobile-more__state" style={{ color: adapter?.color }}>
              <span className="mobile-top__dot" style={{ background: adapter?.dot }} aria-hidden="true" />
              {healthText}
            </span>
          </Link>
          <Link to="/configuracao" replace className="bottom-sheet__item" onClick={closeMore}>
            Configuração
          </Link>
        </div>

        <div className="mobile-more__theme">
          <span className="mobile-more__theme-label" id="mobile-theme-label">
            Tema
          </span>
          <div className="mobile-more__segments" role="radiogroup" aria-labelledby="mobile-theme-label">
            {THEME_SEGMENTS.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={preference === value}
                className={'mobile-more__segment' + (preference === value ? ' mobile-more__segment--on' : '')}
                onClick={() => setPreference(value)}
              >
                {THEME_LABELS[value]}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          className="bottom-sheet__item bottom-sheet__item--danger"
          onClick={() => {
            closeMore()
            setConfirmLogout(true)
          }}
        >
          Sair
        </button>

        {health?.demo === true && (
          <div className="mobile-more__demo" role="note">
            {DEMO_BANNER_TEXT}
            {import.meta.env.VITE_DEMO_STATIC === '1' && <DemoStaticLinks />}
          </div>
        )}
        {health !== null && <p className="mobile-more__version">v{health.version}</p>}
      </BottomSheet>

      {confirmLogout && (
        <ConfirmDialog
          title="Sair do teleyes?"
          message="Você precisará da senha para entrar de novo neste dispositivo."
          confirmLabel="Sair"
          busyLabel="Saindo…"
          busy={busy}
          onCancel={() => setConfirmLogout(false)}
          onConfirm={() => {
            setBusy(true)
            logout()
              .catch(() => undefined)
              .finally(() => {
                setBusy(false)
                setConfirmLogout(false)
              })
          }}
        />
      )}
    </>
  )
}
