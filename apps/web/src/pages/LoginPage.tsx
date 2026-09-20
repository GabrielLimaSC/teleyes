import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useFillOrigin } from '../utils/useFillOrigin'
import { useHealth } from '../hooks/useHealth'
import type { SseState } from '../hooks/useHealth'
import { fetchHealth } from '../api/health'
import type { HealthResponse } from '../api/health'
import { listRules } from '../api/rules'
import { listSources } from '../api/sources'
import { fetchMatches } from '../api/matches'
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

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function Brand() {
  return (
    <div className="login-panel__brand">
      <span className="login-card__mascot-frame">
        <img className="login-card__mascot" src="/mascot.png" alt="" />
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
  const { status, adminId, logout, csrfMissing, login } = useAuth()
  const fillOrigin = useFillOrigin()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
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
          matchesToday: matches.filter((match) => isSameLocalDay(new Date(match.matched_at), now))
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
            {csrfMissing && (
              <p className="login-warning">
                Esta aba recarregou e perdeu o token de sessão — para sair, será preciso entrar de
                novo.
              </p>
            )}
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
    login(password)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Não foi possível entrar.')
      })
      .finally(() => setSubmitting(false))
  }

  return (
    <main className="login-page">
      <div className="login-page__grid">
        <section className="plane-glass login-panel">
          <Brand />
          <div className="login-panel__divider" />
          <div className="login-status">
            {anonHealth && (
              <StatusRow label="Bot do Telegram" state={botStateLabel(anonHealth.bot.state)} />
            )}
            {anonHealth && (
              <StatusRow label="Ambiente" state={`${anonHealth.env} · v${anonHealth.version}`} />
            )}
          </div>
        </section>
        <form className="plane-pearl login-panel login-panel--form" onSubmit={handleSubmit}>
          <div className="login-panel__heading">
            <h2>Entrar</h2>
            <p>Acesso de administrador. A sessão expira ao fechar o navegador.</p>
          </div>
          <div className="login-field">
            <label htmlFor="password">Senha</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
            <span className="login-field__helper">
              Definida com <code>scripts/create_admin.py</code>.
            </span>
          </div>
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
        </form>
      </div>
    </main>
  )
}
