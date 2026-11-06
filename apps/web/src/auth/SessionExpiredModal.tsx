import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ApiError } from '../api/auth'
import { useAuth } from './AuthContext'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { useModalMotion } from '../motion/modalMotion'
import { DIALOG_PRESET } from '../motion/waapi'
import './SessionExpiredModal.css'

/**
 * S13-08: the one UI surface for "your session/CSRF token expired mid-write"
 * — `api/http.ts`'s `apiRequest` triggers it (through `sessionRecovery`) for
 * any write, so no page shows the raw "invalid csrf token"/401 error
 * anymore. It renders on top of whatever page is open without unmounting
 * it, so a half-filled form underneath keeps its state; on a correct
 * password it reuses `useAuth().login`, which resolves the write that
 * triggered this and lets it complete on its own.
 */
export function SessionExpiredModal() {
  const { sessionExpired, login, cancelReauth } = useAuth()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef, sessionExpired)
  useModalMotion(backdropRef, dialogRef, DIALOG_PRESET, sessionExpired)

  // Fresh fields every time it opens — including when it's resolved from
  // another tab (see AuthContext's `storage` listener) while this one was
  // never actually shown.
  useEffect(() => {
    if (!sessionExpired) {
      setPassword('')
      setError(null)
      setSubmitting(false)
    }
  }, [sessionExpired])

  if (!sessionExpired) return null

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    login(password)
      .catch((err: unknown) => {
        setError(err instanceof ApiError && err.status === 401 ? 'Senha incorreta.' : 'Não foi possível entrar agora.')
      })
      .finally(() => setSubmitting(false))
  }

  return (
    <div ref={backdropRef} className="session-expired__backdrop" role="presentation">
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="plane-pearl session-expired"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-expired-title"
      >
        <h2 id="session-expired-title">Sua sessão expirou</h2>
        <p className="session-expired__body">
          Digite sua senha para continuar — o que você estava preenchendo continua aqui, nada foi
          perdido.
        </p>
        <form onSubmit={handleSubmit} className="session-expired__form">
          <div className="session-expired__field">
            <label htmlFor="session-expired-password">Senha</label>
            <input
              id="session-expired-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              autoFocus
              required
            />
          </div>
          {error && (
            <p className="session-expired__error" role="alert">
              {error}
            </p>
          )}
          <div className="session-expired__actions">
            <button
              type="button"
              className="plane-action plane-action--secondary"
              onClick={cancelReauth}
              disabled={submitting}
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="plane-action fill-button"
              disabled={submitting || password.length === 0}
            >
              {submitting ? 'Entrando…' : 'Entrar e continuar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
