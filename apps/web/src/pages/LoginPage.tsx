import { Mascot } from '../components/Mascot'
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { isSameLocalDay, parseApiDate } from '../utils/dates'
import { useFillOrigin } from '../utils/useFillOrigin'
import { useHealth } from '../hooks/useHealth'
import type { SseState } from '../hooks/useHealth'
import { fetchHealth } from '../api/health'
import type { HealthResponse } from '../api/health'
import { listRules } from '../api/rules'
import { listSources } from '../api/sources'
import { fetchMatches } from '../api/matches'
import { DEMO_PASSWORD } from '../api/demo'
import { botStateLabel } from '../components/adapterStateLabel'
import type { StateLabel } from '../components/adapterStateLabel'
import '../styles/materials.css'
import '../components/FillButton.css'
import './LoginPage.css'

const SSE_STATE_LABELS: Record<SseState, StateLabel> = {
  connecting: { label: 'Conectando…', color: 'var(--plane-status-warn)', dot: 'var(--plane-status-warn-dot)' },
  open: { label: 'Conectado', color: 'var(--plane-status-good)', dot: 'var(--plane-status-good-dot)' },
  error: { label: 'Desconectado', color: 'var(--plane-status-danger)', dot: 'var(--plane-status-danger-dot)' },
}

interface DashboardStats {
  activeRules: number
  activeSources: number
  matchesToday: number
}

const DEMO_URL = 'https://gabriellimasc.github.io/teleyes/'
const REPO_URL = 'https://github.com/GabrielLimaSC/teleyes'

function mascotSrc(name: string): string {
  return `${import.meta.env.BASE_URL}mascot/${name}.png`
}

/** Real install: link to the public demo (never a way in without a password).
 * Static demo build: the mocked app is already open, so it goes straight in. */
function DemoEntry() {
  if (import.meta.env.VITE_DEMO_STATIC === '1') {
    return (
      <Link className="plane-action plane-action--secondary login-submit" to="/">
        Explorar a demonstração
      </Link>
    )
  }
  return (
    <a
      className="plane-action plane-action--secondary login-submit"
      href={DEMO_URL}
      target="_blank"
      rel="noopener noreferrer"
    >
      Explorar a demonstração
    </a>
  )
}

function Brand() {
  return (
    <div className="login-panel__brand">
      <span className="login-card__mascot-frame">
        <Mascot className="login-card__mascot" />
      </span>
      <div>
        <h1>teleyes</h1>
        <p className="login-card__tagline">Monitor pessoal de promoções do Telegram</p>
      </div>
    </div>
  )
}

function StatusRow({
  label,
  state,
}: {
  label: string
  state: StateLabel | string
}) {
  return (
    <div className="login-status-row">
      <span className="login-status-row__label">{label}</span>
      {typeof state === 'string' ? (
        <span className="login-status-row__value login-status-row__value--plain">{state}</span>
      ) : (
        <span className="login-status-row__value" style={{ color: state.color }}>
          <span className="login-status-row__dot" style={{ background: state.dot }} />
          {state.label}
        </span>
      )}
    </div>
  )
}

export function LoginPage() {
  const { status, adminId, logout, login } = useAuth()
  const fillOrigin = useFillOrigin()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [remember, setRemember] = useState(true)
  const [logoutError, setLogoutError] = useState<string | null>(null)

  // Anonymous view: only GET /health is reachable pre-login (/rules,
  // /sources, /matches and /events all require a session — see
  // app/routers/*.py's `Depends(get_current_session)`), so this is a plain
  // one-shot fetch of the public snapshot, never the full useHealth() hook.
  const [anonHealth, setAnonHealth] = useState<HealthResponse | null>(null)
  useEffect(() => {
    if (status !== 'anonymous') return
    let cancelled = false
    fetchHealth()
      .then((data) => {
        if (!cancelled) setAnonHealth(data)
      })
      .catch(() => {
        /* painel de login não exibe stats sem elas — sem placeholder falso */
      })
    return () => {
      cancelled = true
    }
  }, [status])

  // Authenticated view: same live health + SSE state as Saúde (S11-06),
  // gated so it never opens the auth-only /events stream on the anonymous
  // view (see the `enabled` doc on useHealth itself).
  const { health, sseState } = useHealth(5000, status === 'authenticated')

  const [stats, setStats] = useState<DashboardStats | null>(null)
  useEffect(() => {
    if (status !== 'authenticated') return
    let cancelled = false
    Promise.all([listRules(), listSources(), fetchMatches()])
      .then(([rules, sources, matches]) => {
        if (cancelled) return
        const now = new Date()
        setStats({
          activeRules: rules.filter((rule) => rule.active).length,
          activeSources: sources.filter((source) => source.active).length,
          matchesToday: matches.filter((match) => isSameLocalDay(parseApiDate(match.matched_at), now))
            .length,
        })
      })
      .catch(() => {
        /* mesma regra: sem número real disponível, não mostra tile */
      })
    return () => {
      cancelled = true
    }
  }, [status])

  if (status === 'checking') {
    return (
      <main className="login-page">
        <p>Verificando sessão…</p>
      </main>
    )
  }

  if (status === 'authenticated') {
    return (
      <main className="login-page">
        <div className="login-page__grid">
          <section className="plane-glass login-panel">
            <Brand />
            <div className="login-panel__divider" />
            <div className="login-stats">
              <div className="login-stats__tile">
                <div className="login-stats__label">Regras ativas</div>
                <div className="login-stats__value">{stats ? stats.activeRules : '…'}</div>
              </div>
              <div className="login-stats__tile">
                <div className="login-stats__label">Fontes ouvindo</div>
                <div className="login-stats__value">{stats ? stats.activeSources : '…'}</div>
              </div>
              <div className="login-stats__tile">
                <div className="login-stats__label">Matches hoje</div>
                <div className="login-stats__value">{stats ? stats.matchesToday : '…'}</div>
              </div>
            </div>
            <div className="login-status">
              <StatusRow label="Feed em tempo real (SSE)" state={SSE_STATE_LABELS[sseState]} />
              {health && <StatusRow label="Bot do Telegram" state={botStateLabel(health.bot.state)} />}
              {health && (
                <StatusRow label="Ambiente" state={`${health.env} · v${health.version}`} />
              )}
            </div>
          </section>
          <section className="plane-pearl login-panel login-panel--form">
            <div className="login-panel__heading">
              <h2>Sessão ativa</h2>
              <p>Admin #{adminId}.</p>
            </div>
            <button
              type="button"
              className="plane-action login-submit fill-button"
              onPointerDown={fillOrigin}
              onClick={() => {
                setLogoutError(null)
                logout().catch((err: unknown) => {
                  setLogoutError(err instanceof Error ? err.message : 'Não foi possível sair.')
                })
              }}
            >
              Sair
            </button>
            {logoutError && (
              <p className="login-error" role="alert">
                {logoutError}
              </p>
            )}
          </section>
        </div>
      </main>
    )
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    login(password, remember)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Não foi possível entrar.')
      })
      .finally(() => setSubmitting(false))
  }

  return (
    <main className="login-page login-page--v2">
      <div className="login-v2">
        <section className="login-v2__brand">
          <span className="login-v2__mascot-wrap">
            <img className="login-v2__mascot login-v2__mascot--light" src={mascotSrc('mascote-accent')} alt="" />
            <img className="login-v2__mascot login-v2__mascot--dark" src={mascotSrc('mascote-inverse')} alt="" />
          </span>
          <h1 className="login-v2__wordmark">teleyes</h1>
          <p className="login-v2__lede">
            Lê os grupos de promoção do Telegram por você e só chama quando o preço vale a pena.
          </p>
          <ul className="login-v2__bullets">
            <li data-tone="1">Regras por termo, teto e alvo de preço</li>
            <li data-tone="2">Histórico de 90 dias para cada produto</li>
            <li data-tone="3">Alerta no Telegram só quando é de verdade</li>
          </ul>
        </section>
        <form className="plane-glass login-v2__form" onSubmit={handleSubmit}>
          <div className="login-panel__heading">
            <h2>Entrar</h2>
            <p>Acesso de administrador desta instalação.</p>
          </div>
          <div className="login-field">
            <label htmlFor="password">Senha</label>
            <div className="login-field__control">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                autoFocus
                required
              />
              <button
                type="button"
                className="login-field__toggle"
                aria-pressed={showPassword}
                aria-controls="password"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setShowPassword((value) => !value)}
              >
                {showPassword ? 'Ocultar' : 'Mostrar'}
              </button>
            </div>
            {anonHealth?.demo === true ? (
              <span className="login-field__helper" data-testid="demo-login-hint">
                Demonstração: use a senha <code>{DEMO_PASSWORD}</code>.
              </span>
            ) : (
              <span className="login-field__helper">
                Definida em <code>ADMIN_PASSWORD</code> no servidor.
              </span>
            )}
          </div>
          <label className="login-check">
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
            <span>Manter conectado neste dispositivo</span>
          </label>
          <button
            type="submit"
            className="plane-action login-submit fill-button"
            onPointerDown={fillOrigin}
            disabled={submitting || password.length === 0}
          >
            {submitting ? 'Entrando…' : 'Entrar'}
          </button>
          {error && (
            <p className="login-error" role="alert">
              {error}
            </p>
          )}
          <div className="login-v2__or" aria-hidden="true">
            <span>ou</span>
          </div>
          <DemoEntry />
          <p className="login-v2__demo-note">
            A demonstração usa dados fictícios e não envia nada. Nenhuma regra é salva.
          </p>
        </form>
        <footer className="login-v2__footer">
          <span>{anonHealth ? `v${anonHealth.version} · ${anonHealth.env}` : ''}</span>
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
            Ver o código no GitHub
          </a>
        </footer>
      </div>
    </main>
  )
}
