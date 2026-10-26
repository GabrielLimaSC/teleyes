import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { CSRF_MISSING_MESSAGE } from '../auth/AuthContext'
import { ApiError } from '../api/auth'
import { fetchSetupStatus, pollPairing, saveBotToken, startPairing } from '../api/setup'
import type { Pairing } from '../api/setup'
import { listRecipients, updateRecipient } from '../api/recipients'
import { testNotification } from '../api/notifications'
import type { Recipient } from '../api/types'
import { useFillOrigin } from '../utils/useFillOrigin'
import { errorMessage, sleep, useCountdown, useRetryLock } from './timers'
import type { StepProps } from './types'
import { secondsLabel, validateBotToken } from './validation'

/** At least this long between two polls, so a second tab that is also waiting cannot make us spin. */
const MIN_POLL_GAP_MS = 1500

/** One registered recipient: editable name and a real test message. */
function RecipientRow({ recipient, csrfToken }: { recipient: Recipient; csrfToken: string | null }) {
  const [name, setName] = useState(recipient.name)
  const [saved, setSaved] = useState(recipient.name)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)

  const save = () => {
    const trimmed = name.trim()
    if (csrfToken === null || trimmed === '' || trimmed === saved) return
    setBusy('save')
    updateRecipient(csrfToken, recipient.id, { name: trimmed })
      .then(() => {
        setSaved(trimmed)
        setMessage({ tone: 'ok', text: 'Nome salvo.' })
      })
      .catch((failure: unknown) =>
        setMessage({ tone: 'error', text: errorMessage(failure, 'Não foi possível salvar o nome.') }),
      )
      .finally(() => setBusy(null))
  }

  const test = () => {
    if (csrfToken === null) {
      setMessage({ tone: 'error', text: CSRF_MISSING_MESSAGE })
      return
    }
    setBusy('test')
    setMessage(null)
    testNotification(csrfToken, recipient.telegram_chat_id, 'Teste do assistente de configuração do teleyes.')
      .then((result) =>
        setMessage(
          result.delivered
            ? { tone: 'ok', text: 'Mensagem de teste entregue. Confira o Telegram deste destinatário.' }
            : { tone: 'error', text: `Não entregue (${result.status}).` },
        ),
      )
      .catch((failure: unknown) =>
        setMessage({ tone: 'error', text: errorMessage(failure, 'Não foi possível enviar o teste.') }),
      )
      .finally(() => setBusy(null))
  }

  return (
    <li className="setup-recipient">
      <label className="setup-field">
        Nome do destinatário
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              save()
            }
          }}
          maxLength={200}
        />
      </label>
      <button
        type="button"
        className="plane-action plane-action--secondary setup-button"
        onClick={test}
        disabled={busy !== null || !recipient.active || !recipient.allowlisted}
      >
        {busy === 'test' ? 'Enviando…' : 'Enviar mensagem de teste'}
      </button>
      {message !== null && (
        <p role={message.tone === 'error' ? 'alert' : 'status'} className={message.tone === 'error' ? 'setup-error' : 'setup-ok'}>
          {message.text}
        </p>
      )}
    </li>
  )
}

/** Step 3: the alert bot (token) and who receives the alerts (pairing by /start). */
export function BotStep({ status, csrfToken, onStatus }: StepProps) {
  const fillOrigin = useFillOrigin()
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [changing, setChanging] = useState(false)
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const [pairingBusy, setPairingBusy] = useState(false)
  const [pairingError, setPairingError] = useState<string | null>(null)
  const [pairingNotice, setPairingNotice] = useState<string | null>(null)
  const [ignored, setIgnored] = useState(0)
  const [recipients, setRecipients] = useState<Recipient[]>([])
  const tokenLock = useRetryLock()
  const pairingActive = status.bot.pairing_active
  const pairingLeft = useCountdown(pairing?.expires_in_seconds ?? status.bot.pairing_expires_in_seconds)

  const loadRecipients = useCallback(() => {
    listRecipients()
      .then(setRecipients)
      .catch(() => setRecipients([]))
  }, [])

  useEffect(() => {
    if (status.bot.configured) loadRecipients()
  }, [status.bot.configured, loadRecipients])

  // Waits for the /start while a pairing window is open on the server. Keyed on the
  // server flag, not on the local link, so a reloaded tab keeps waiting too.
  useEffect(() => {
    if (!pairingActive || csrfToken === null) return
    let cancelled = false
    const wait = async () => {
      while (!cancelled) {
        const startedAt = Date.now()
        try {
          const result = await pollPairing(csrfToken)
          if (cancelled) return
          if (result.state === 'paired') {
            setPairing(null)
            setIgnored(0)
            setPairingNotice(`${result.recipient?.name ?? 'Destinatário'} cadastrado. Você já pode enviar um teste.`)
            loadRecipients()
            // The server closed the window: pull the new status (recipient step done).
            onStatus(await fetchSetupStatus())
            return
          }
          if (result.state === 'expired') {
            setPairing(null)
            setPairingNotice('O link expirou. Gere um novo para tentar de novo.')
            onStatus(await fetchSetupStatus())
            return
          }
          if (result.ignored_starts > 0) setIgnored((count) => count + result.ignored_starts)
        } catch (failure) {
          if (cancelled) return
          setPairing(null)
          setPairingError(errorMessage(failure, 'Não foi possível esperar pelo /start.'))
          return
        }
        await sleep(Math.max(0, MIN_POLL_GAP_MS - (Date.now() - startedAt)))
      }
    }
    void wait()
    return () => {
      cancelled = true
    }
  }, [pairingActive, csrfToken, loadRecipients, onStatus])

  const submitToken = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const problem = validateBotToken(token)
    if (problem !== null) {
      setError(problem)
      return
    }
    if (csrfToken === null) {
      setError(CSRF_MISSING_MESSAGE)
      return
    }
    setSaving(true)
    setError(null)
    saveBotToken(csrfToken, token.trim())
      .then((next) => {
        setToken('')
        setChanging(false)
        onStatus(next)
      })
      .catch((failure: unknown) => {
        tokenLock.lockFrom(failure)
        setError(errorMessage(failure, 'Não foi possível validar o token.'))
      })
      .finally(() => setSaving(false))
  }

  const openPairing = () => {
    if (csrfToken === null) {
      setPairingError(CSRF_MISSING_MESSAGE)
      return
    }
    setPairingBusy(true)
    setPairingError(null)
    setPairingNotice(null)
    setIgnored(0)
    startPairing(csrfToken)
      .then(async (next) => {
        setPairing(next)
        onStatus(await fetchSetupStatus())
      })
      .catch((failure: unknown) => {
        setPairingError(
          failure instanceof ApiError ? failure.message : 'Não foi possível gerar o link de pareamento.',
        )
      })
      .finally(() => setPairingBusy(false))
  }

  const bot = status.bot
  const tokenForm = (
    <form className="setup-stack" onSubmit={submitToken} noValidate>
      <ol className="setup-steps-list">
        <li>
          No Telegram, abra <strong>@BotFather</strong> e envie <code>/newbot</code>.
        </li>
        <li>Escolha um nome e um usuário para o bot (o usuário termina em <code>bot</code>).</li>
        <li>Copie o token que ele devolve (algo como <code>123456789:ABC…</code>) e cole abaixo.</li>
      </ol>
      <label className="setup-field">
        Token do bot
        <input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore
        />
      </label>
      {error !== null && (
        <p role="alert" className="setup-error">
          {error}
        </p>
      )}
      <div className="setup-actions">
        <button
          type="submit"
          className="plane-action fill-button setup-button"
          onPointerDown={fillOrigin}
          disabled={saving || tokenLock.locked}
        >
          {saving
            ? 'Validando…'
            : tokenLock.locked
              ? `Aguarde ${secondsLabel(tokenLock.remaining)}`
              : 'Validar token'}
        </button>
        {changing && (
          <button
            type="button"
            className="plane-action plane-action--secondary setup-button"
            onClick={() => setChanging(false)}
          >
            Cancelar
          </button>
        )}
      </div>
    </form>
  )

  if (!bot.configured) return tokenForm

  const username = bot.username
  return (
    <div className="setup-stack">
      {changing ? (
        tokenForm
      ) : (
        <div className="setup-botline">
          <p className="setup-note">
            {username !== null ? (
              <>
                Bot configurado:{' '}
                <a href={`https://t.me/${username}`} target="_blank" rel="noopener noreferrer">
                  @{username}
                </a>
              </>
            ) : (
              <>Bot configurado pelo arquivo <code>.env</code>.</>
            )}
          </p>
          {bot.source === 'wizard' && (
            <button
              type="button"
              className="plane-action plane-action--secondary setup-button"
              onClick={() => setChanging(true)}
            >
              Trocar token
            </button>
          )}
        </div>
      )}
      {changing && (
        <p className="setup-hint">
          Trocar o bot não apaga os destinatários, mas cada pessoa precisa tocar em Iniciar no bot novo.
        </p>
      )}

      <div className="setup-divider" />
      <h3 className="setup-subtitle">Quem recebe os alertas</h3>
      <p className="setup-note">
        Cada pessoa precisa conversar com o bot uma vez. Gere o link, abra-o no Telegram de quem vai receber e
        toque em <strong>Iniciar</strong>. O link vale por 10 minutos e só funciona com o código dele, então
        ninguém mais consegue se cadastrar por engano.
      </p>

      {recipients.length > 0 && (
        <ul className="setup-recipients">
          {recipients.map((recipient) => (
            <RecipientRow key={recipient.id} recipient={recipient} csrfToken={csrfToken} />
          ))}
        </ul>
      )}

      {pairing !== null && (
        <div className="setup-pairing">
          <a
            className="plane-action fill-button setup-button setup-pairing__link"
            href={pairing.deep_link}
            target="_blank"
            rel="noopener noreferrer"
            onPointerDown={fillOrigin}
          >
            Abrir @{pairing.bot_username} no Telegram
          </a>
          <p className="setup-hint">
            Ou envie manualmente ao bot: <code>/start {pairing.code}</code>
          </p>
        </div>
      )}
      {pairingActive && (
        <p className="setup-waiting" role="status">
          <span className="setup-spinner" aria-hidden="true" />
          Aguardando o /start…{' '}
          {pairingLeft !== null && pairingLeft > 0 && <>(o link vale por mais {secondsLabel(pairingLeft)})</>}
        </p>
      )}
      {ignored > 0 && (
        <p className="setup-hint" role="status">
          Recebi {ignored} /start sem o código do link, e ignorei. Use o botão acima, ou envie{' '}
          <code>/start</code> seguido do código.
        </p>
      )}
      {pairingNotice !== null && (
        <p role="status" className="setup-ok">
          {pairingNotice}
        </p>
      )}
      {pairingError !== null && (
        <p role="alert" className="setup-error">
          {pairingError}
        </p>
      )}
      <div className="setup-actions">
        <button
          type="button"
          className={`plane-action setup-button${recipients.length > 0 ? ' plane-action--secondary' : ' fill-button'}`}
          onClick={openPairing}
          onPointerDown={recipients.length > 0 ? undefined : fillOrigin}
          disabled={pairingBusy}
        >
          {pairingBusy
            ? 'Gerando…'
            : recipients.length > 0
              ? 'Adicionar outra pessoa'
              : pairingActive || pairing !== null
                ? 'Gerar um novo link'
                : 'Gerar link de pareamento'}
        </button>
      </div>
    </div>
  )
}
