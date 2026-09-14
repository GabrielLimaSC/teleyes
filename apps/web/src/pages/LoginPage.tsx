import { useState } from 'react'
import type { FormEvent } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useFillOrigin } from '../utils/useFillOrigin'
import '../components/GlassCard.css'
import '../components/FillButton.css'
import './LoginPage.css'

export function LoginPage() {
  const { status, adminId, logout, csrfMissing, login } = useAuth()
  const fillOrigin = useFillOrigin()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)

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
        <section className="glass-card login-card">
          <div className="login-card__brand">
            <span className="login-card__mascot-frame">
              <img className="login-card__mascot" src="/mascot.png" alt="" />
            </span>
            <h1>teleyes</h1>
            <p className="login-card__tagline">Monitor pessoal de promoções do Telegram</p>
          </div>
          <p>Sessão ativa (admin #{adminId}).</p>
          {csrfMissing && (
            <p className="login-warning">
              Esta aba recarregou e perdeu o token de sessão — para sair, será preciso entrar de novo.
            </p>
          )}
          <button
            type="button"
            className="fill-button"
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
      <form className="glass-card login-card" onSubmit={handleSubmit}>
        <div className="login-card__brand">
          <span className="login-card__mascot-frame">
            <img className="login-card__mascot" src="/mascot.png" alt="" />
          </span>
          <h1>teleyes</h1>
          <p className="login-card__tagline">Monitor pessoal de promoções do Telegram</p>
        </div>
        <div className="login-card__field">
          <p className="login-card__hint">Entre com a senha de administrador.</p>
          <label htmlFor="password">Senha</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        <button
          type="submit"
          className="fill-button"
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
    </main>
  )
}
