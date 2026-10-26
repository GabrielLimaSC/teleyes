import { useState } from 'react'
import type { FormEvent } from 'react'
import { CSRF_MISSING_MESSAGE } from '../auth/AuthContext'
import {
  cancelLogin,
  disconnectTelegram,
  startLogin,
  submitLoginCode,
  submitLoginPassword,
} from '../api/setup'
import type { SetupStatus } from '../api/setup'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { useFillOrigin } from '../utils/useFillOrigin'
import { errorMessage, useCountdown, useRetryLock } from './timers'
import type { StepProps } from './types'
import { normalizePhone, secondsLabel, validateLoginCode, validatePhone } from './validation'

/** Shown before the phone is asked, and again on the connected account. */
function SessionWarning() {
  return (
    <p className="setup-callout" role="note">
      <strong>Atenção:</strong> esta sessão dá acesso total à conta do Telegram. Use, de preferência, uma
      conta dedicada. Ela fica só no seu computador, nunca vai para o Git, para os backups nem para a tela.
    </p>
  )
}

/** Step 2: sign the Telegram account in (phone, code, 2FA password when it has one). */
export function LoginStep({ status, csrfToken, onStatus }: StepProps) {
  const fillOrigin = useFillOrigin()
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const lock = useRetryLock()
  const login = status.login
  const expiresIn = useCountdown(login.state === 'authorized' ? null : login.expires_in_seconds)

  const run = (action: (token: string) => Promise<SetupStatus>, fallback: string, after?: () => void) => {
    if (csrfToken === null) {
      setError(CSRF_MISSING_MESSAGE)
      return
    }
    setBusy(true)
    setError(null)
    action(csrfToken)
      .then((next) => {
        // Secrets leave the page the moment the server has them.
        setCode('')
        setPassword('')
        after?.()
        onStatus(next)
      })
      .catch((failure: unknown) => {
        setPassword('') // a rejected 2FA password must not linger in the field
        lock.lockFrom(failure)
        setError(errorMessage(failure, fallback))
      })
      .finally(() => setBusy(false))
  }

  const submitPhone = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const problem = validatePhone(phone)
    if (problem !== null) {
      setError(problem)
      return
    }
    run(
      (token) => startLogin(token, normalizePhone(phone)),
      'Não foi possível pedir o código ao Telegram.',
      () => setPhone(''),
    )
  }

  const submitCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const problem = validateLoginCode(code)
    if (problem !== null) {
      setError(problem)
      return
    }
    run((token) => submitLoginCode(token, code.replace(/\s/g, '')), 'Não foi possível confirmar o código.')
  }

  const submitPassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (password === '') {
      setError('Digite a senha da verificação em duas etapas.')
      return
    }
    run((token) => submitLoginPassword(token, password), 'Não foi possível confirmar a senha.')
  }

  const waitLabel = lock.locked ? ` (aguarde ${secondsLabel(lock.remaining)})` : ''
  const errorLine =
    error !== null ? (
      <p role="alert" className="setup-error">
        {error}
      </p>
    ) : null

  if (!status.steps.credentials) {
    return <p className="setup-note">Salve primeiro o api_id e o api_hash (passo 1).</p>
  }

  if (login.state === 'authorized') {
    return (
      <div className="setup-stack">
        <p className="setup-note">
          A conta do Telegram está conectada. O monitor lê os grupos com esta sessão.
        </p>
        <SessionWarning />
        <div className="setup-actions">
          <button
            type="button"
            className="plane-action plane-action--danger setup-button"
            onClick={() => setConfirmDisconnect(true)}
          >
            Desconectar Telegram
          </button>
          <span className="setup-hint">
            Apaga a sessão e as credenciais guardadas aqui. Para encerrar de vez, termine também a sessão em
            Telegram, Configurações, Dispositivos.
          </span>
        </div>
        {errorLine}
        {confirmDisconnect && (
          <ConfirmDialog
            title="Desconectar o Telegram?"
            message="A sessão, o api_hash e o token do bot guardados neste computador serão apagados e o monitor para de ler os grupos. Os grupos, regras e destinatários cadastrados ficam."
            confirmLabel="Desconectar"
            busyLabel="Desconectando…"
            busy={busy}
            onCancel={() => setConfirmDisconnect(false)}
            onConfirm={() =>
              run(
                (token) => disconnectTelegram(token),
                'Não foi possível desconectar o Telegram.',
                () => setConfirmDisconnect(false),
              )
            }
          />
        )}
      </div>
    )
  }

  if (login.state === 'awaiting_code') {
    return (
      <form className="setup-stack" onSubmit={submitCode} noValidate>
        <p className="setup-note">
          Enviamos um código para o Telegram da conta <strong>{login.phone_hint}</strong>. Abra o aplicativo
          do Telegram nessa conta: ele chega na conversa <em>Telegram</em>, não por SMS.
        </p>
        <label className="setup-field">
          Código
          <input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            spellCheck={false}
            placeholder="12345"
            aria-describedby="login-expiry"
          />
        </label>
        <p id="login-expiry" className="setup-hint">
          {expiresIn !== null && expiresIn > 0
            ? `O código vale por mais ${secondsLabel(expiresIn)}.`
            : 'O tempo acabou: cancele e peça um novo código.'}
        </p>
        {errorLine}
        <div className="setup-actions">
          <button
            type="submit"
            className="plane-action fill-button setup-button"
            onPointerDown={fillOrigin}
            disabled={busy || lock.locked}
          >
            {busy ? 'Confirmando…' : `Confirmar código${waitLabel}`}
          </button>
          <button
            type="button"
            className="plane-action plane-action--secondary setup-button"
            disabled={busy}
            onClick={() => run((token) => cancelLogin(token), 'Não foi possível cancelar.')}
          >
            Cancelar e recomeçar
          </button>
        </div>
      </form>
    )
  }

  if (login.state === 'awaiting_password') {
    return (
      <form className="setup-stack" onSubmit={submitPassword} noValidate>
        <p className="setup-note">
          Esta conta usa verificação em duas etapas. Digite a senha dela (a que você criou no Telegram).
        </p>
        <label className="setup-field">
          Senha da verificação em duas etapas
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="off"
            data-1p-ignore
          />
        </label>
        {errorLine}
        <div className="setup-actions">
          <button
            type="submit"
            className="plane-action fill-button setup-button"
            onPointerDown={fillOrigin}
            disabled={busy || lock.locked}
          >
            {busy ? 'Entrando…' : `Entrar${waitLabel}`}
          </button>
          <button
            type="button"
            className="plane-action plane-action--secondary setup-button"
            disabled={busy}
            onClick={() => run((token) => cancelLogin(token), 'Não foi possível cancelar.')}
          >
            Cancelar e recomeçar
          </button>
        </div>
      </form>
    )
  }

  return (
    <form className="setup-stack" onSubmit={submitPhone} noValidate>
      <SessionWarning />
      <p className="setup-note">
        Informe o telefone da conta que já participa dos grupos de promoções. O Telegram vai enviar um
        código para o aplicativo dessa conta.
      </p>
      <label className="setup-field">
        Telefone (com + e código do país)
        <input
          type="tel"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          autoComplete="off"
          placeholder="+5511999998888"
        />
      </label>
      {errorLine}
      <div className="setup-actions">
        <button
          type="submit"
          className="plane-action fill-button setup-button"
          onPointerDown={fillOrigin}
          disabled={busy || lock.locked}
        >
          {busy ? 'Pedindo o código…' : `Enviar código${waitLabel}`}
        </button>
      </div>
    </form>
  )
}
